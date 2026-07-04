# SpotBOT 🎵

SpotBOT es un bot de Discord que se conecta y sincroniza en tiempo real con tu reproducción activa de **Spotify** o tu **Spotify Jam (sesión grupal)**. El bot detecta de inmediato cambios de canciones, pausas, reanudaciones y rebobinados (seeks) en Spotify, y los replica en el canal de voz de Discord transmitiendo directamente desde YouTube.

## 🚀 Características
- **Sincronización en tiempo real:** Pollea tu estado de reproducción de Spotify cada 3 segundos.
- **Detección de Spotify Jams:** Sigue el ritmo del grupo de forma automática si entras en una Jam.
- **Ajuste de tiempos (Seek):** Si adelantas o atrasas la canción en Spotify, el bot se sincronizará automáticamente.
- **Fácil inicio de sesión:** Muestra un código QR en consola para iniciar sesión desde tu móvil al instante.
- **Listo para producción:** Cuenta con endpoints para políticas legales y de interacciones verificadas por firma criptográfica ed25519.

## 🛠️ Requisitos de Configuración
Crea un archivo `.env` en la raíz del proyecto basándote en [.env.example](.env.example):

```env
DISCORD_TOKEN=tu_token_de_bot
DISCORD_CLIENT_ID=1523074738157518909
DISCORD_PUBLIC_KEY=8bb737c75b152009ab06e1043ae22b45d1900f0341a8a16a515fd586649cd59d
DISCORD_CLIENT_SECRET=tu_discord_client_secret

SPOTIFY_CLIENT_ID=tu_spotify_client_id
SPOTIFY_CLIENT_SECRET=tu_spotify_client_secret
SPOTIFY_REDIRECT_URI=http://localhost:3000/callback
PORT=3000
```

## 💻 Instalación y Ejecución
1. Instala las dependencias:
   ```bash
   npm install
   ```
2. Enciende el bot:
   ```bash
   npm start
   ```
3. Escanea el código QR que aparece en la consola para conectar tu Spotify.
4. En Discord, usa los comandos:
   - `!joinS` - El bot se une a tu canal de voz y empieza a sincronizar.
   - `!leaveS` - El bot abandona el canal y apaga la sincronización.

## 📄 Enlaces Legales
- [Condiciones de Servicio y Donaciones](TERMS.md)
- [Política de Privacidad](PRIVACY.md)

---
Desarrollado con ❤️ por [iJahir](https://github.com/iJahir)
