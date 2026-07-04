import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection
} from '@discordjs/voice';
import play from 'play-dl';
import qrcode from 'qrcode-terminal';

// Obtener rutas absolutas para archivos estáticos
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Comprobar variables de entorno
const {
  DISCORD_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_PUBLIC_KEY,
  DISCORD_CLIENT_SECRET,
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  PORT = 3000
} = process.env;

if (!DISCORD_TOKEN || !SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_REDIRECT_URI) {
  console.error('ERROR: Faltan variables de entorno esenciales en tu archivo .env.');
  process.exit(1);
}

// -------------------------------------------------------------
// ESTADO DE AUTENTICACIÓN DE SPOTIFY
// -------------------------------------------------------------
let spotifyAccessToken = null;
let spotifyRefreshToken = null;
let tokenExpirationTime = 0; // Tiempo Unix en ms

async function refreshSpotifyToken() {
  if (!spotifyRefreshToken) return;
  console.log('Renovando el token de acceso de Spotify...');
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: spotifyRefreshToken,
      }),
    });

    const data = await response.json();
    if (data.access_token) {
      spotifyAccessToken = data.access_token;
      tokenExpirationTime = Date.now() + data.expires_in * 1000;
      console.log('Token de acceso de Spotify renovado con éxito.');
    } else {
      console.error('Error al renovar el token de Spotify:', data);
    }
  } catch (error) {
    console.error('Error al renovar el token de Spotify:', error);
  }
}

async function getValidAccessToken() {
  if (!spotifyAccessToken) return null;
  if (Date.now() + 30000 >= tokenExpirationTime) {
    await refreshSpotifyToken();
  }
  return spotifyAccessToken;
}

// -------------------------------------------------------------
// SERVIDOR WEB EXPRESS (SERVIR HTML Y MANEJAR OAUTH/INTERACTIONS)
// -------------------------------------------------------------
const app = express();
const loginUrl = `http://127.0.0.1:${PORT}/login`;

// Servir archivos estáticos de la carpeta /public
app.use(express.static(path.join(__dirname, 'public')));

app.get('/login', (req, res) => {
  const scopes = 'user-read-playback-state user-read-currently-playing';
  const spotifyAuthUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: scopes,
    redirect_uri: SPOTIFY_REDIRECT_URI,
  }).toString();
  res.redirect(spotifyAuthUrl);
});

app.get('/callback', async (req, res) => {
  const code = req.query.code || null;
  if (!code) {
    return res.send('Error de autenticación: Falta el código de autorización.');
  }

  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
      body: new URLSearchParams({
        code: code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
        grant_type: 'authorization_code',
      }),
    });

    const data = await response.json();
    if (data.access_token) {
      spotifyAccessToken = data.access_token;
      spotifyRefreshToken = data.refresh_token;
      tokenExpirationTime = Date.now() + data.expires_in * 1000;

      res.send(`
        <html>
          <body style="font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #0b0c10; color: white; background-image: radial-gradient(circle at 10% 20%, rgba(29, 185, 84, 0.15) 0%, transparent 40%);">
            <h1 style="color: #1DB954; font-size: 2.5rem; margin-bottom: 10px;">¡Spotify Autenticado con éxito!</h1>
            <p style="font-size: 1.1rem; color: #c5c6c7;">El bot ahora está conectado a tu cuenta (también funcionará con tu Jam activa).</p>
            <p style="font-size: 0.9rem; color: rgba(255,255,255,0.4);">Puedes cerrar esta pestaña y volver a Discord.</p>
          </body>
        </html>
      `);
      console.log('¡Conectado exitosamente a la cuenta de Spotify!');
    } else {
      res.send('Error al obtener el token de Spotify: ' + JSON.stringify(data));
    }
  } catch (error) {
    console.error('Error durante el intercambio de tokens:', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Rutas explícitas para las páginas legales y verificación
app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/linked-roles', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'linked-roles.html'));
});

// Endpoint de Interacciones de Discord
app.post('/interactions', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}), (req, res) => {
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!signature || !timestamp || !req.rawBody || !DISCORD_PUBLIC_KEY) {
    return res.status(401).send('Firma inválida o faltan parámetros.');
  }

  try {
    const isVerified = crypto.verify(
      null,
      Buffer.concat([Buffer.from(timestamp), req.rawBody]),
      crypto.createPublicKey({
        key: Buffer.concat([
          Buffer.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]),
          Buffer.from(DISCORD_PUBLIC_KEY, 'hex')
        ]),
        format: 'der',
        type: 'spki'
      }),
      Buffer.from(signature, 'hex')
    );

    if (!isVerified) {
      return res.status(401).send('Firma de interacción inválida.');
    }
  } catch (err) {
    console.error('Error al verificar la firma de la interacción:', err);
    return res.status(401).send('Firma de interacción inválida.');
  }

  const interaction = req.body;
  if (interaction.type === 1) {
    return res.json({ type: 1 });
  }

  return res.status(200).send('Interacción recibida.');
});

app.listen(PORT, () => {
  console.log(`\n============================================================`);
  console.log(`Servidor web activo para autenticación de Spotify y URLs de Discord.`);
  console.log(`- Enlace de login (Spotify): ${loginUrl}`);
  console.log(`- Términos de Servicio y Donaciones: http://localhost:${PORT}/terms`);
  console.log(`- Política de Privacidad: http://localhost:${PORT}/privacy`);
  console.log(`- Verificación de Roles: http://localhost:${PORT}/linked-roles`);
  console.log(`- Endpoint de Interacciones: http://localhost:${PORT}/interactions`);
  console.log(`============================================================\n`);
  
  qrcode.generate(loginUrl, { small: true });
});

// -------------------------------------------------------------
// CLIENTE DEL BOT DE DISCORD
// -------------------------------------------------------------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

let voiceConnection = null;
let audioPlayer = null;
let currentTrackId = null;
let lastSyncProgressMs = 0;
let lastSyncTimestamp = 0;
let syncIntervalId = null;

let currentYoutubeUrl = null;

client.on('ready', () => {
  console.log(`Bot de Discord listo como: ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content === '!joinS') {
    const member = message.member;
    if (!member.voice.channel) {
      return message.reply('Debes estar en un canal de voz para usar este comando.');
    }

    try {
      // Unirse al canal de voz inmediatamente
      voiceConnection = joinVoiceChannel({
        channelId: member.voice.channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
      });

      audioPlayer = createAudioPlayer();
      voiceConnection.subscribe(audioPlayer);

      // Si Spotify ya está vinculado, iniciar sincronización
      if (spotifyAccessToken) {
        message.reply(`¡Me he unido al canal de voz **${member.voice.channel.name}**! Sincronización en tiempo real activa.`);
      } else {
        message.reply(`¡Me he unido al canal de voz **${member.voice.channel.name}**!\n⚠️ **Sincronización pausada**: Aún no has conectado tu cuenta de Spotify.\nPor favor, vincula tu cuenta abriendo este enlace en tu navegador o escaneando el código QR de la consola: ${loginUrl}`);
      }

      startSyncLoop();
    } catch (error) {
      console.error('Error al unirse al canal de voz:', error);
      message.reply('No pude unirme al canal de voz.');
    }
  }

  if (content === '!leaveS') {
    stopSyncLoop();
    const connection = getVoiceConnection(message.guild.id);
    if (connection) {
      connection.destroy();
      voiceConnection = null;
      audioPlayer = null;
      currentTrackId = null;
      message.reply('He salido del canal de voz y la sincronización se ha detenido.');
    } else {
      message.reply('No estoy en ningún canal de voz.');
    }
  }
});

// -------------------------------------------------------------
// BUCLE DE SINCRONIZACIÓN EN TIEMPO REAL CON SPOTIFY
// -------------------------------------------------------------
function startSyncLoop() {
  stopSyncLoop();
  console.log('Iniciando el bucle de sincronización con Spotify...');
  syncIntervalId = setInterval(syncSpotifyPlayback, 3000);
}

function stopSyncLoop() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
    console.log('Bucle de sincronización con Spotify detenido.');
  }
}

async function syncSpotifyPlayback() {
  // Intentar obtener el token. Si el usuario aún no se ha logueado, reintentará en el próximo ciclo
  const token = await getValidAccessToken();
  if (!token || !audioPlayer) {
    // Si no hay token, no hacemos nada en este ciclo
    return;
  }

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player', {
      headers: {
        Authorization: `Bearer ${token}`
      }
    });

    if (response.status === 204) {
      if (audioPlayer.state.status !== AudioPlayerStatus.Paused && audioPlayer.state.status !== AudioPlayerStatus.Idle) {
        console.log('Spotify inactivo. Pausando reproducción en Discord.');
        audioPlayer.pause();
      }
      return;
    }

    const playback = await response.json();
    if (!playback || !playback.item) return;

    const trackId = playback.item.id;
    const isPlayingOnSpotify = playback.is_playing;
    const progressMs = playback.progress_ms;
    const trackName = playback.item.name;
    const artistName = playback.item.artists[0]?.name || '';

    if (trackId !== currentTrackId) {
      console.log(`Nueva canción detectada: "${trackName}" de ${artistName}`);
      currentTrackId = trackId;
      await playNewTrack(trackName, artistName, progressMs, isPlayingOnSpotify);
      return;
    }

    const isDiscordPlaying = audioPlayer.state.status === AudioPlayerStatus.Playing;
    if (isPlayingOnSpotify && !isDiscordPlaying) {
      console.log('Spotify reanudado. Reanudando Discord.');
      audioPlayer.unpause();
    } else if (!isPlayingOnSpotify && isDiscordPlaying) {
      console.log('Spotify pausado. Pausando Discord.');
      audioPlayer.pause();
    }

    if (isPlayingOnSpotify) {
      const timeSinceLastSync = Date.now() - lastSyncTimestamp;
      const expectedProgress = lastSyncProgressMs + timeSinceLastSync;
      const drift = Math.abs(progressMs - expectedProgress);

      if (drift > 3500) {
        console.log(`Desfase detectado (${drift}ms). Ajustando reproducción de Discord al segundo: ${Math.round(progressMs / 1000)}s.`);
        await streamYoutubeAtProgress(currentYoutubeUrl, progressMs, isPlayingOnSpotify);
      } else {
        lastSyncProgressMs = progressMs;
        lastSyncTimestamp = Date.now();
      }
    }
  } catch (error) {
    console.error('Error al consultar la reproducción de Spotify:', error);
  }
}

async function playNewTrack(trackName, artistName, progressMs, isPlayingOnSpotify) {
  try {
    const searchQuery = `${trackName} ${artistName} official audio`;
    console.log(`Buscando en YouTube: "${searchQuery}"`);
    const searchResults = await play.search(searchQuery, { limit: 1 });

    if (searchResults.length === 0) {
      console.error('No se encontraron resultados en YouTube.');
      return;
    }

    currentYoutubeUrl = searchResults[0].url;
    console.log(`Stream de YouTube encontrado: ${currentYoutubeUrl}`);
    await streamYoutubeAtProgress(currentYoutubeUrl, progressMs, isPlayingOnSpotify);
  } catch (error) {
    console.error('Error al reproducir la nueva canción:', error);
  }
}

async function streamYoutubeAtProgress(url, progressMs, isPlayingOnSpotify) {
  try {
    const seekSeconds = Math.floor(progressMs / 1000);
    console.log(`Transmitiendo desde YouTube a partir del segundo ${seekSeconds}...`);

    const stream = await play.stream(url, { seek: seekSeconds });
    const resource = createAudioResource(stream.stream, { inputType: stream.type });
    
    audioPlayer.play(resource);
    
    if (!isPlayingOnSpotify) {
      audioPlayer.pause();
    }

    lastSyncProgressMs = progressMs;
    lastSyncTimestamp = Date.now();
  } catch (error) {
    console.error('Error al transmitir el video de YouTube:', error);
  }
}

// Iniciar sesión en Discord
client.login(DISCORD_TOKEN);
