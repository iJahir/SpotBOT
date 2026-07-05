import 'dotenv/config';
import express from 'express';
import path from 'path';
import fs from 'fs';
import https from 'https';
import os from 'os';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import { exec, spawn } from 'child_process';
import util from 'util';
import ffmpegPath from 'ffmpeg-static';
import { Client, GatewayIntentBits } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
  StreamType
} from '@discordjs/voice';
import play from 'play-dl';
import qrcode from 'qrcode-terminal';

const execPromise = util.promisify(exec);

// Obtener rutas absolutas
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ytDlpPath = path.join(__dirname, 'yt-dlp.exe');
const stateFilePath = path.join(__dirname, '.bot_state.json');
const logFilePath = path.join(__dirname, 'bot.log');

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

// Canal de testeo por defecto solicitado por el usuario
const TESTING_CHANNEL_ID = '1523120310809792713';

// -------------------------------------------------------------
// SISTEMA DE LOGS Y CONSOLA EN TIEMPO REAL CON CÓDIGOS DE ERROR
// -------------------------------------------------------------
let systemLogs = [];

function writeToLogFile(type, message) {
  const timestamp = new Date().toLocaleTimeString();
  const logLine = `[${timestamp}] [${type}] ${message}`;
  
  systemLogs.push(logLine);
  if (systemLogs.length > 50) {
    systemLogs.shift();
  }

  try {
    fs.appendFileSync(logFilePath, logLine + '\n', 'utf8');
  } catch (err) {
    // Silencioso si falla escritura
  }
}

// Loguear errores estructurados
function logSystemError(code, message, err = null) {
  const errMsg = err ? ` | Detalle: ${err.message || err}` : '';
  console.error(`[Código ${code}] ${message}${errMsg}`);
}

const originalConsoleLog = console.log;
const originalConsoleError = console.error;

console.log = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  originalConsoleLog(...args);
  writeToLogFile('INFO', msg);
};

console.error = (...args) => {
  const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ');
  originalConsoleError(...args);
  writeToLogFile('ERROR', msg);
};

// -------------------------------------------------------------
// OBTENER IP LOCAL DE LA RED PARA EL QR MÓVIL
// -------------------------------------------------------------
function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1'; // Fallback
}

const localIp = getLocalIpAddress();

// -------------------------------------------------------------
// DESCARGA AUTOMÁTICA DE YT-DLP
// -------------------------------------------------------------
async function downloadYtDlp() {
  if (fs.existsSync(ytDlpPath)) {
    return ytDlpPath;
  }
  console.log('Descargando yt-dlp.exe para garantizar la transmisión de audio sin bloqueos...');
  
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(ytDlpPath);
    const download = (url) => {
      https.get(url, (response) => {
        if (response.statusCode === 302 || response.statusCode === 301) {
          download(response.headers.location);
          return;
        }
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('yt-dlp.exe descargado exitosamente.');
          resolve(ytDlpPath);
        });
      }).on('error', (err) => {
        fs.unlink(ytDlpPath, () => {});
        reject(err);
      });
    };
    download('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe');
  });
}

// -------------------------------------------------------------
// EXTRAER ENLACE DIRECTO DE STREAM CON YT-DLP
// -------------------------------------------------------------
async function getDirectAudioUrl(youtubeUrl) {
  try {
    const { stdout } = await execPromise(`"${ytDlpPath}" -f bestaudio -g "${youtubeUrl}"`);
    return stdout.trim();
  } catch (error) {
    logSystemError('ERR-01', 'Fallo al extraer stream de YouTube con yt-dlp.exe', error);
    throw error;
  }
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
      logSystemError('ERR-02', 'La API de Spotify rechazó la renovación del token de acceso.', new Error(JSON.stringify(data)));
    }
  } catch (error) {
    logSystemError('ERR-02', 'Excepción de red al renovar token de Spotify.', error);
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
// VARIABLES GLOBALES DEL CONTROLADOR DEL PANEL WEB
// -------------------------------------------------------------
let currentVolume = 0.5; // Rango de 0 a 1.0 (50% por defecto)
let currentSpeed = 1.0;  // Velocidad de reproducción (1.0 por defecto)
let currentAudioResource = null;
let currentPlaybackState = {
  title: 'Ninguna canción',
  artist: 'Spotify inactivo',
  coverUrl: 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500',
  progressMs: 0,
  durationMs: 0,
  isPlaying: false,
  volume: 50,
  speed: 1.0,
  queue: [],
  guildCount: 0,
  voiceConnected: false,
  guildName: null
};

// -------------------------------------------------------------
// SERVIDOR WEB EXPRESS
// -------------------------------------------------------------
const app = express();
const loginUrl = `http://${localIp}:${PORT}/login`;

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/login', (req, res) => {
  const scopes = 'user-read-playback-state user-read-currently-playing user-modify-playback-state';
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
    logSystemError('ERR-02', 'Error en el callback de intercambio de Spotify.', error);
    res.status(500).send('Error interno del servidor');
  }
});

// Endpoints del Dashboard
app.get('/api/state', (req, res) => {
  if (currentPlaybackState.isPlaying && currentPlaybackState.progressMs < currentPlaybackState.durationMs) {
    const elapsed = Date.now() - lastSyncTimestamp;
    currentPlaybackState.progressMs = Math.min(
      currentPlaybackState.durationMs,
      lastSyncProgressMs + Math.round(elapsed * currentSpeed)
    );
  }
  
  currentPlaybackState.guildCount = client.guilds.cache.size;
  currentPlaybackState.voiceConnected = voiceConnection !== null;
  currentPlaybackState.guildName = lastTextChannel ? lastTextChannel.guild.name : (voiceConnection ? client.guilds.cache.get(voiceConnection.joinConfig.guildId)?.name : null);
  
  res.json(currentPlaybackState);
});

app.post('/api/volume', (req, res) => {
  const { volume } = req.body;
  if (typeof volume === 'number' && volume >= 0 && volume <= 100) {
    currentVolume = volume / 100;
    currentPlaybackState.volume = volume;
    if (currentAudioResource && currentAudioResource.volume) {
      currentAudioResource.volume.setVolume(currentVolume);
    }
    console.log(`[API] Volumen cambiado a: ${volume}%`);
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Volumen inválido.' });
});

app.post('/api/speed', async (req, res) => {
  const { speed } = req.body;
  if (typeof speed === 'number' && speed >= 0.5 && speed <= 2.0) {
    currentSpeed = speed;
    currentPlaybackState.speed = speed;
    console.log(`[API] Velocidad cambiada a: x${speed}`);
    
    if (currentYoutubeUrl && voiceConnection && audioPlayer) {
      isSyncing = true;
      await streamYoutubeAtProgress(currentYoutubeUrl, currentPlaybackState.progressMs, currentPlaybackState.isPlaying);
      isSyncing = false;
    }
    return res.json({ success: true });
  }
  res.status(400).json({ error: 'Velocidad inválida.' });
});

app.post('/api/seek', async (req, res) => {
  const { seconds, targetMs } = req.body;
  let newProgressMs = currentPlaybackState.progressMs;
  
  if (typeof targetMs === 'number') {
    newProgressMs = targetMs;
  } else if (typeof seconds === 'number') {
    newProgressMs = Math.max(0, Math.min(currentPlaybackState.durationMs, newProgressMs + seconds * 1000));
  } else {
    return res.status(400).json({ error: 'Parámetros inválidos.' });
  }

  currentPlaybackState.progressMs = newProgressMs;
  lastSyncProgressMs = newProgressMs;
  lastSyncTimestamp = Date.now();

  console.log(`[API] Seek solicitado a: ${Math.round(newProgressMs / 1000)}s`);

  if (currentYoutubeUrl && voiceConnection && audioPlayer) {
    isSyncing = true;
    await streamYoutubeAtProgress(currentYoutubeUrl, newProgressMs, currentPlaybackState.isPlaying);
    isSyncing = false;
  }
  
  res.json({ success: true, progressMs: newProgressMs });
});

app.post('/api/play-pause', async (req, res) => {
  const token = await getValidAccessToken();
  if (!token) {
    logSystemError('ERR-02', 'Intento de reproducir/pausar música sin cuenta de Spotify vinculada.');
    return res.status(401).json({ error: 'No autenticado en Spotify.' });
  }

  try {
    const action = currentPlaybackState.isPlaying ? 'pause' : 'play';
    const response = await fetch(`https://api.spotify.com/v1/me/player/${action}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` }
    });

    if (response.ok || response.status === 204) {
      currentPlaybackState.isPlaying = !currentPlaybackState.isPlaying;
      if (currentPlaybackState.isPlaying) {
        audioPlayer?.unpause();
      } else {
        audioPlayer?.pause();
      }
      return res.json({ success: true, isPlaying: currentPlaybackState.isPlaying });
    }
    
    const errData = await response.json().catch(() => ({}));
    res.status(response.status).json(errData);
  } catch (error) {
    logSystemError('ERR-02', 'Error de red al alternar play/pause de Spotify.', error);
    res.status(500).json({ error: error.message });
  }
});

// Controles Saltar Canción de Spotify
app.post('/api/next', async (req, res) => {
  const token = await getValidAccessToken();
  if (!token) return res.status(401).json({ error: 'No autenticado.' });
  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/next', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.ok || response.status === 204) {
      return res.json({ success: true });
    }
    res.status(response.status).json({ error: 'Error al saltar' });
  } catch (e) {
    logSystemError('ERR-02', 'Fallo al saltar de canción en Spotify.', e);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/previous', async (req, res) => {
  const token = await getValidAccessToken();
  if (!token) return res.status(401).json({ error: 'No autenticado.' });
  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/previous', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.ok || response.status === 204) {
      return res.json({ success: true });
    }
    res.status(response.status).json({ error: 'Error al retroceder' });
  } catch (e) {
    logSystemError('ERR-02', 'Fallo al retroceder canción en Spotify.', e);
    res.status(500).json({ error: e.message });
  }
});

// Reproducir una canción específica inmediatamente
app.post('/api/play-track', async (req, res) => {
  const { uri } = req.body;
  const token = await getValidAccessToken();
  if (!token) return res.status(401).json({ error: 'No autenticado.' });
  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/play', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [uri] })
    });
    if (response.ok || response.status === 204) {
      return res.json({ success: true });
    }
    res.status(response.status).json({ error: 'Error al reproducir track' });
  } catch (e) {
    logSystemError('ERR-02', 'Fallo al forzar reproducción de track en Spotify.', e);
    res.status(500).json({ error: e.message });
  }
});

// Saltar hasta la canción en un index específico de la cola de Spotify
app.post('/api/skip-to-queue', async (req, res) => {
  const { index } = req.body;
  const token = await getValidAccessToken();
  if (!token) return res.status(401).json({ error: 'No autenticado.' });
  
  try {
    // Saltamos 'index + 1' veces para reproducir y remover las canciones en cola naturales de Spotify
    for (let i = 0; i <= index; i++) {
      await fetch('https://api.spotify.com/v1/me/player/next', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (i < index) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
    return res.json({ success: true });
  } catch (e) {
    logSystemError('ERR-02', 'Error al saltar al index de la cola en Spotify.', e);
    res.status(500).json({ error: e.message });
  }
});

// Enviar mensajes al canal con búsqueda activa de miembros por nombre en la API de Discord
app.post('/api/message', async (req, res) => {
  const { message, channelId } = req.body;
  if (!message) return res.status(400).json({ error: 'Mensaje vacío.' });

  const targetChannelId = channelId || (lastTextChannel ? lastTextChannel.id : null);
  if (!targetChannelId) {
    return res.status(400).json({ error: 'No se especificó canal de destino.' });
  }

  try {
    const channel = await client.channels.fetch(targetChannelId);
    if (channel) {
      let parsedMessage = message;

      if (channel.guild) {
        try {
          const mentionRegex = /@([a-zA-Z0-9_\-\.]+)/g;
          const matches = [...parsedMessage.matchAll(mentionRegex)];
          
          for (const m of matches) {
            const fullMatch = m[0]; // e.g. "@TheAngel07"
            const username = m[1].toLowerCase();
            
            const searchResults = await channel.guild.members.search({ query: username, limit: 5 });
            
            const member = searchResults.find(mbr => 
              mbr.user.username.toLowerCase() === username || 
              (mbr.nickname && mbr.nickname.toLowerCase() === username) ||
              mbr.displayName.toLowerCase() === username ||
              (mbr.user.globalName && mbr.user.globalName.toLowerCase() === username)
            ) || searchResults.first();
            
            if (member) {
              console.log(`[DISCORD CHAT] Reemplazando mención texto ${fullMatch} por ID de usuario <@${member.id}>`);
              parsedMessage = parsedMessage.replace(fullMatch, `<@${member.id}>`);
            }
          }
        } catch (err) {
          console.error('Error al resolver mención por búsqueda de Discord:', err);
        }
      }

      await channel.send({
        content: `**Panel**: ${parsedMessage}`,
        allowedMentions: { parse: ['users', 'roles', 'everyone'] }
      });
      lastTextChannel = channel;
      return res.json({ success: true });
    }
    res.status(404).json({ error: 'Canal no encontrado.' });
  } catch (e) {
    logSystemError('ERR-05', 'Fallo al escribir en canal de texto de Discord.', e);
    return res.status(500).json({ error: e.message });
  }
});

// Buscador de canciones en Spotify
app.get('/api/search', async (req, res) => {
  const { q } = req.query;
  const token = await getValidAccessToken();
  if (!token) return res.status(401).json({ error: 'No autenticado en Spotify.' });
  if (!q) return res.json([]);

  try {
    const response = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=5`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.ok) {
      const data = await response.json();
      const results = data.tracks.items.map(item => ({
        id: item.id,
        uri: item.uri,
        title: item.name,
        artist: item.artists.map(a => a.name).join(', '),
        coverUrl: item.album.images[0]?.url || ''
      }));
      return res.json(results);
    }
    res.status(response.status).json({ error: 'Error al buscar en Spotify.' });
  } catch (e) {
    logSystemError('ERR-02', 'Error en consulta de búsqueda a Spotify.', e);
    res.status(500).json({ error: e.message });
  }
});

// Encolar canción en Spotify
app.post('/api/queue', async (req, res) => {
  const { uri } = req.body;
  const token = await getValidAccessToken();
  if (!token) return res.status(401).json({ error: 'No autenticado en Spotify.' });
  if (!uri) return res.status(400).json({ error: 'Falta la URI del track.' });

  try {
    const response = await fetch('https://api.spotify.com/v1/me/player/queue?uri=' + encodeURIComponent(uri), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    });
    if (response.ok || response.status === 204) {
      return res.json({ success: true });
    }
    const errData = await response.json().catch(() => ({}));
    res.status(response.status).json(errData);
  } catch (error) {
    logSystemError('ERR-02', 'Fallo al encolar canción en Spotify.', error);
    res.status(500).json({ error: error.message });
  }
});

// Obtener todos los canales de texto de Discord del bot
app.get('/api/channels', async (req, res) => {
  try {
    const channelsList = [];
    for (const [guildId, guild] of client.guilds.cache) {
      const guildChannels = await guild.channels.fetch();
      for (const [channelId, channel] of guildChannels) {
        if (channel.isTextBased() && channel.type !== 2 && channel.type !== 13) {
          channelsList.push({
            id: channel.id,
            name: channel.name,
            guildName: guild.name
          });
        }
      }
    }
    res.json(channelsList);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Obtener mensajes de un canal incluyendo el avatar URL de cada autor
app.get('/api/channels/:id/messages', async (req, res) => {
  const { id } = req.params;
  try {
    const channel = await client.channels.fetch(id);
    if (!channel || !channel.isTextBased()) {
      return res.status(404).json({ error: 'Canal de texto no encontrado.' });
    }
    const messages = await channel.messages.fetch({ limit: 15 });
    const formatted = messages.map(msg => ({
      id: msg.id,
      author: msg.author.username,
      avatar: msg.author.displayAvatarURL({ size: 64 }),
      content: msg.content,
      timestamp: msg.createdAt,
      isMe: msg.author.id === client.user.id
    })).reverse();
    res.json(formatted);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Obtener los miembros del servidor de un canal específico con sistema de fallbacks robusto y avatar
app.get('/api/channels/:id/members', async (req, res) => {
  const { id } = req.params;
  try {
    const channel = await client.channels.fetch(id);
    if (!channel || !channel.guild) {
      return res.json([]);
    }
    
    let membersList = [];
    try {
      // Intentar fetch directo de miembros del servidor
      const members = await channel.guild.members.fetch({ limit: 80 });
      membersList = members.map(m => ({
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.user.displayAvatarURL({ size: 64 })
      }));
    } catch (fetchErr) {
      // Fallback 1: Usar la caché rápida local
      membersList = channel.guild.members.cache.map(m => ({
        username: m.user.username,
        displayName: m.displayName,
        avatar: m.user.displayAvatarURL({ size: 64 })
      }));
    }
    
    // Fallback 2: Si la lista sigue vacía, cargamos los autores únicos de los últimos 50 mensajes del canal
    if (membersList.length === 0) {
      try {
        const messages = await channel.messages.fetch({ limit: 50 });
        const uniqueAuthors = new Map();
        messages.forEach(msg => {
          if (!msg.author.bot) {
            uniqueAuthors.set(msg.author.id, {
              username: msg.author.username,
              displayName: msg.member ? msg.member.displayName : msg.author.username,
              avatar: msg.author.displayAvatarURL({ size: 64 })
            });
          }
        });
        membersList = Array.from(uniqueAuthors.values());
      } catch (msgErr) {
        console.error('Error al recuperar miembros vía mensajes:', msgErr);
      }
    }

    res.json(membersList);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint para leer archivo bot.log
app.get('/api/log-file', (req, res) => {
  try {
    if (fs.existsSync(logFilePath)) {
      const content = fs.readFileSync(logFilePath, 'utf8');
      return res.send(content);
    }
    res.send('El archivo bot.log está vacío.');
  } catch (e) {
    res.status(500).send('Error al leer log: ' + e.message);
  }
});

// Endpoint para vaciar archivo bot.log
app.post('/api/log-file/clear', (req, res) => {
  try {
    fs.writeFileSync(logFilePath, '', 'utf8');
    systemLogs = [];
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Endpoint de Logs en vivo
app.get('/api/logs', (req, res) => {
  res.json(systemLogs);
});

app.get('/terms', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});

app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});

app.get('/linked-roles', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'linked-roles.html'));
});

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

// Descargar yt-dlp e iniciar servidor Express
downloadYtDlp().then(() => {
  app.listen(PORT, () => {
    console.log(`\n============================================================`);
    console.log(`Servidor web activo para autenticación de Spotify y URLs de Discord.`);
    console.log(`- Enlace de login (Spotify): ${loginUrl}`);
    console.log(`- Términos de Servicio y Donaciones: http://${localIp}:${PORT}/terms`);
    console.log(`- Política de Privacidad: http://${localIp}:${PORT}/privacy`);
    console.log(`- Verificación de Roles: http://${localIp}:${PORT}/linked-roles`);
    console.log(`- Endpoint de Interacciones: http://${localIp}:${PORT}/interactions`);
    console.log(`============================================================\n`);
    
    qrcode.generate(loginUrl, { small: true });
  });
}).catch(err => {
  console.error('Fallo crítico: No se pudo descargar yt-dlp.exe:', err);
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
let inactivityTimeoutId = null;
let lastTextChannel = null;

let currentYoutubeUrl = null;
let activeFfmpegProcess = null;
let isSyncing = false;

// Enviar un mensaje de respuesta al rol Developer en canal, o redirigir auditoría al canal de testeo
async function replyDeveloperOrPrivate(message, text) {
  const member = message.member;
  
  // Buscar si el usuario tiene el rol 'Developer'
  const hasDevRole = member && member.roles.cache.some(role => role.name.toLowerCase() === 'developer');

  if (hasDevRole) {
    // Si tiene el rol Developer, se responde en el chat de texto normal (se borra en 20 segundos)
    try {
      const msg = await message.reply(text);
      setTimeout(() => msg.delete().catch(() => {}), 20000);
    } catch (e) {
      console.error('Error al responder en canal publico:', e);
    }
  } else {
    // Si no es developer, borramos su comando disparador de inmediato
    await message.delete().catch(() => {});
    
    // Y redirigimos la alerta al canal de testeo (ID: 1523120310809792713)
    try {
      const testingChannel = await client.channels.fetch(TESTING_CHANNEL_ID);
      if (testingChannel) {
        testingChannel.send(`⚠️ **Auditoría (No-Developer)**: El usuario **${member ? member.displayName : 'Desconocido'}** intentó ejecutar una acción.\n*Resultado:* Acción procesada en silencio.\n*Detalle:* ${text}`);
      }
    } catch (e) {
      console.error('Error al notificar al canal de testeo:', e);
    }
  }
}

client.on('ready', async () => {
  console.log(`Bot de Discord listo como: ${client.user.tag}`);

  // Anuncio al regresar de cambios directo al canal de testeo solicitado (1523120310809792713)
  if (fs.existsSync(stateFilePath)) {
    try {
      fs.unlinkSync(stateFilePath);

      const channel = await client.channels.fetch(TESTING_CHANNEL_ID);
      if (channel) {
        channel.send(`¡**He vuelto**! 🚀 He realizado los siguientes cambios en mi sistema:
🛠️ **Sincronización robusta**: Enrutada vía \`yt-dlp.exe\` para evitar bloqueos.
🔊 **Audio activado**: Integrado \`opusscript\` para resolver los silencios al cantar.
⏱️ **Inactividad**: Desconexión automática tras 2 minutos sin sonar música.
📱 **Panel Web y Móvil**: ¡Lanzado un panel de control interactivo en tu navegador local (http://localhost:5000) o escaneando el código QR de la consola de administración del bot para bajar volumen, buscar, añadir a la cola y mensajear!`);
      }
    } catch (e) {
      console.error('Error al enviar anuncio de reinicio al canal de testeo:', e);
    }
  }
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const content = message.content.trim();

  if (content === '!joinS') {
    const member = message.member;
    if (!message.member.voice.channel) {
      return replyDeveloperOrPrivate(message, 'Debes estar en un canal de voz para usar este comando.');
    }

    try {
      lastTextChannel = message.channel;

      voiceConnection = joinVoiceChannel({
        channelId: member.voice.channel.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
      });

      voiceConnection.on('stateChange', (oldState, newState) => {
        console.log(`[CONEXIÓN DISCORD] Estado: ${oldState.status} -> ${newState.status}`);
      });

      audioPlayer = createAudioPlayer();
      voiceConnection.subscribe(audioPlayer);

      audioPlayer.on('stateChange', async (oldState, newState) => {
        console.log(`[REPRODUCTOR AUDIO] Estado: ${oldState.status} -> ${newState.status}`);
        
        if (newState.status === AudioPlayerStatus.Idle) {
          const token = await getValidAccessToken();
          if (token && currentPlaybackState.isPlaying && currentYoutubeUrl && !isSyncing) {
            logSystemError('ERR-01', 'Pérdida de red o Connection Reset de YouTube (10054). Iniciando reconexión auto-sanable...');
            isSyncing = true;
            setTimeout(async () => {
              try {
                await streamYoutubeAtProgress(currentYoutubeUrl, currentPlaybackState.progressMs, true);
              } catch (e) {
                logSystemError('ERR-01', 'Fallo al auto-reconectar el flujo tras caída de YouTube.', e);
              } finally {
                isSyncing = false;
              }
            }, 1000);
          }
        }
      });

      audioPlayer.on('error', error => {
        logSystemError('ERR-04', 'Error controlado en el reproductor de audio de voz.', error);
      });

      let joinMsg = '';
      if (spotifyAccessToken) {
        joinMsg = `¡Me he unido al canal de voz **${member.voice.channel.name}**! Sincronización en tiempo real activa.\nPuedes abrir el panel de control en tu navegador local (http://localhost:5000) o escaneando el código QR de la consola de administración.`;
      } else {
        joinMsg = `¡Me he unido al canal de voz **${member.voice.channel.name}**!\n⚠️ **Sincronización pausada**: Aún no has conectado tu cuenta de Spotify.\nPor favor, vincula tu cuenta abriendo el enlace de login generado en tu consola (http://localhost:5000/login) o escaneando el código QR.`;
      }

      await replyDeveloperOrPrivate(message, joinMsg);
      startSyncLoop(message.guild.id);
    } catch (error) {
      logSystemError('ERR-04', 'Excepción crítica al unirse al canal de voz de Discord.', error);
      await replyDeveloperOrPrivate(message, 'No pude unirme al canal de voz.');
    }
  }

  if (content === '!leaveS') {
    cleanupAndLeave();
    await replyDeveloperOrPrivate(message, 'He salido del canal de voz y la sincronización se ha detenido.');
  }
});

function cleanupAndLeave() {
  stopSyncLoop();
  stopActiveFfmpeg();
  if (inactivityTimeoutId) {
    clearTimeout(inactivityTimeoutId);
    inactivityTimeoutId = null;
  }
  
  if (voiceConnection) {
    try {
      voiceConnection.destroy();
    } catch (e) {
      console.error('Error al desconectar el canal de voz:', e);
    }
  }
  
  voiceConnection = null;
  audioPlayer = null;
  currentTrackId = null;
}

function stopActiveFfmpeg() {
  if (activeFfmpegProcess) {
    try {
      activeFfmpegProcess.kill('SIGKILL');
    } catch (e) {}
    activeFfmpegProcess = null;
  }
}

// -------------------------------------------------------------
// BUCLE DE SINC
// -------------------------------------------------------------
function startSyncLoop(guildId) {
  stopSyncLoop();
  console.log('Iniciando el bucle de sincronización con Spotify...');
  syncIntervalId = setInterval(() => syncSpotifyPlayback(guildId), 3000);
}

function stopSyncLoop() {
  if (syncIntervalId) {
    clearInterval(syncIntervalId);
    syncIntervalId = null;
    console.log('Bucle de sincronización con Spotify detenido.');
  }
}

async function syncSpotifyPlayback(guildId) {
  if (isSyncing) return;

  const token = await getValidAccessToken();
  if (!token || !audioPlayer) {
    checkInactivity(guildId, false);
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
      currentPlaybackState.isPlaying = false;
      checkInactivity(guildId, false);
      return;
    }

    const playback = await response.json();
    if (!playback || !playback.item) {
      currentPlaybackState.isPlaying = false;
      checkInactivity(guildId, false);
      return;
    }

    const trackId = playback.item.id;
    const isPlayingOnSpotify = playback.is_playing;
    const progressMs = playback.progress_ms;
    const trackName = playback.item.name;
    const artistName = playback.item.artists.map(a => a.name).join(', ');
    const coverUrl = playback.item.album.images[0]?.url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?w=500';
    const durationMs = playback.item.duration_ms;

    // Obtener la cola de reproducción actual de Spotify
    let queueList = [];
    try {
      const queueResponse = await fetch('https://api.spotify.com/v1/me/player/queue', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (queueResponse.ok) {
        const queueData = await queueResponse.json();
        if (queueData && queueData.queue) {
          queueList = queueData.queue.slice(0, 5).map(item => ({
            title: item.name,
            artist: item.artists.map(a => a.name).join(', '),
            coverUrl: item.album.images[0]?.url || '',
            uri: item.uri
          }));
        }
      }
    } catch (e) {
      logSystemError('ERR-02', 'Error al consultar lista de cola a la API de Spotify.', e);
    }

    // Actualizar estado del panel web
    currentPlaybackState = {
      title: trackName,
      artist: artistName,
      coverUrl: coverUrl,
      progressMs: progressMs,
      durationMs: durationMs,
      isPlaying: isPlayingOnSpotify,
      volume: Math.round(currentVolume * 100),
      speed: currentSpeed,
      queue: queueList
    };

    checkInactivity(guildId, isPlayingOnSpotify);

    if (trackId !== currentTrackId) {
      console.log(`Nueva canción detectada: "${trackName}" de ${artistName}`);
      currentTrackId = trackId;
      isSyncing = true;
      await playNewTrack(trackName, artistName, progressMs, isPlayingOnSpotify);
      isSyncing = false;
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
      const expectedProgress = lastSyncProgressMs + Math.round(timeSinceLastSync * currentSpeed);
      const drift = Math.abs(progressMs - expectedProgress);

      if (drift > 15000) {
        console.log(`Desfase mayor a 15s detectado (${drift}ms). Ajustando reproducción de Discord al segundo: ${Math.round(progressMs / 1000)}s.`);
        isSyncing = true;
        await streamYoutubeAtProgress(currentYoutubeUrl, progressMs, isPlayingOnSpotify);
        isSyncing = false;
      } else {
        lastSyncProgressMs = progressMs;
        lastSyncTimestamp = Date.now();
      }
    }
  } catch (error) {
    logSystemError('ERR-02', 'Excepción en el bucle de sincronización con Spotify.', error);
    isSyncing = false;
  }
}

// Control de inactividad
function checkInactivity(guildId, isPlaying) {
  if (isPlaying) {
    if (inactivityTimeoutId) {
      console.log('Reproducción reanudada. Temporizador de inactividad cancelado.');
      clearTimeout(inactivityTimeoutId);
      inactivityTimeoutId = null;
    }
  } else {
    if (!inactivityTimeoutId && voiceConnection) {
      console.log('Inactividad detectada (Spotify pausado o inactivo). El bot se desconectará en 2 minutos si no se detecta música.');
      inactivityTimeoutId = setTimeout(() => {
        console.log('Desconectando del canal de voz por inactividad de 2 minutos.');
        if (lastTextChannel) {
          lastTextChannel.send('⚠️ Me he desconectado del canal de voz por inactividad (2 minutos sin reproducir música).');
        }
        cleanupAndLeave();
      }, 120000);
    }
  }
}

async function playNewTrack(trackName, artistName, progressMs, isPlayingOnSpotify) {
  try {
    const searchQuery = `${trackName} ${artistName} official audio`;
    console.log(`Buscando en YouTube: "${searchQuery}"`);
    const searchResults = await play.search(searchQuery, { limit: 1 });

    if (searchResults.length === 0) {
      logSystemError('ERR-03', `No se encontraron resultados en YouTube para: ${searchQuery}`);
      return;
    }

    currentYoutubeUrl = searchResults[0].url;
    console.log(`Stream de YouTube encontrado: ${currentYoutubeUrl}`);
    await streamYoutubeAtProgress(currentYoutubeUrl, progressMs, isPlayingOnSpotify);
  } catch (error) {
    logSystemError('ERR-03', 'Error crítico en búsqueda de YouTube.', error);
  }
}

async function streamYoutubeAtProgress(url, progressMs, isPlayingOnSpotify) {
  try {
    stopActiveFfmpeg();

    const seekSeconds = Math.floor(progressMs / 1000);
    console.log(`Obteniendo flujo de audio directo de YouTube...`);
    const directAudioUrl = await getDirectAudioUrl(url);

    console.log(`Abriendo proceso FFmpeg para transmitir desde el segundo ${seekSeconds} (PCM Crudo, Velocidad: x${currentSpeed})...`);
    
    const ffmpegArgs = [
      '-ss', seekSeconds.toString(),
      '-i', directAudioUrl,
      '-f', 's16le',
      '-ar', '48000',
      '-ac', '2'
    ];

    if (currentSpeed !== 1.0) {
      ffmpegArgs.push('-af', `atempo=${currentSpeed}`);
    }

    ffmpegArgs.push('pipe:1');

    activeFfmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    activeFfmpegProcess.stderr.on('data', (data) => {
      // Ignorado
    });

    activeFfmpegProcess.on('exit', (code, signal) => {
      console.log(`[FFMPEG PROCESO] Salida del proceso. Codigo: ${code}, Senal: ${signal}`);
    });

    currentAudioResource = createAudioResource(activeFfmpegProcess.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true
    });
    
    currentAudioResource.volume.setVolume(currentVolume);
    
    audioPlayer.play(currentAudioResource);
    
    if (!isPlayingOnSpotify) {
      audioPlayer.pause();
    }

    lastSyncProgressMs = progressMs;
    lastSyncTimestamp = Date.now();
  } catch (error) {
    logSystemError('ERR-01', 'Fallo al abrir o decodificar flujo de audio con FFmpeg.', error);
  }
}

// -------------------------------------------------------------
// SALIDA LIMPIA Y CONTROLADA (GRACEFUL SHUTDOWN)
// -------------------------------------------------------------
const handleShutdown = async () => {
  console.log('\nApagando el bot de forma segura y saliendo de los canales de voz...');
  
  if (lastTextChannel) {
    try {
      fs.writeFileSync(stateFilePath, JSON.stringify({ channelId: lastTextChannel.id }), 'utf8');
      
      // Anuncio de reinicio redirigido directamente al canal de testeo
      const testingChannel = await client.channels.fetch(TESTING_CHANNEL_ID);
      if (testingChannel) {
        testingChannel.send('⚠️ Me apagaré temporalmente porque mi desarrollador hará algunos ajustes. ¡Vuelvo enseguida!');
      }
    } catch (e) {
      console.error('Error al guardar estado de salida:', e);
    }
  }
  
  cleanupAndLeave();
  
  setTimeout(() => {
    process.exit(0);
  }, 1000);
};

process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Iniciar sesión en Discord
client.login(DISCORD_TOKEN);
