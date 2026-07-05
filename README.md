# 🕹️ SpotBOT - Reproductor de Spotify Sincronizado en Discord con Panel Web

SpotBOT es un bot de Discord diseñado y desarrollado para retransmitir y sincronizar la música que estás escuchando en tu cuenta de Spotify (incluyendo Jams y listas de reproducción activas) directamente en un canal de voz de Discord con la máxima calidad de audio y cero latencia. 

Incluye un **Panel de Control Glassmorphic interactivo** optimizado para computadoras y celulares, consola en tiempo real, visor de logs, soundboard y programador de actividades.

---

## 🚀 Características Principales

* 🎵 **Sincronización Spotify en Tiempo Real**: Sincroniza la música de tu Spotify con un canal de voz de Discord. Si pausas, adelantas o cambias de canción en tu aplicación de Spotify, el bot lo imita en Discord.
* 📱 **Panel Web y Móvil Premium**: Controla el volumen, busca y encola canciones, cambia la velocidad de la música (x1.0, x1.5, x2.0) y chatea en Discord desde tu teléfono o computadora.
* 🔊 **Soundboard Integrado**: Reproduce los sonidos oficiales por defecto de Discord (`quack` 🦆, `airhorn` 📢, `cricket` 🦗, `golf clap` 👏, `sad horn` 📯 y `ba dum tss` 🥁) y los sonidos personalizados que la gente haya subido a tu servidor de Discord.
* ⏰ **Programador de Alertas**: Envía menciones programadas (`@everyone`, `@here` o miembros individuales) para avisar de sesiones de juego, cambiando automáticamente la presencia del bot en Discord por la duración que especifiques.
* 🟢 **Control de Presencia**: Ajusta el estado de conexión del bot (Online, Ausente, No Molestar) y su juego activo directamente desde la web.
* 🔒 **Rol Developer de Seguridad**: El bot responde públicamente a comandos de voz únicamente si el usuario tiene el rol `Developer`. Para los demás usuarios, procesa en silencio, elimina el mensaje disparador y envía una alerta de auditoría al canal de testeo.
* 🛡️ **Auto-Reconexión Auto-Sanable**: Detección inteligente de cortes de red en YouTube (`10054`) con reconexión y posicionamiento automático en menos de un segundo.

---

## 🛠️ Requisitos Previos

Antes de montar tu propio bot, asegúrate de tener instalado:
1. **Node.js** (Versión 18 o superior).
2. **FFmpeg**: El bot utiliza `ffmpeg-static` de npm por defecto, por lo que se instala automáticamente de forma local. No necesitas instalarlo en el sistema.

---

## ⚙️ Configuración y Credenciales (Archivo `.env`)

Crea un archivo llamado `.env` en la raíz del proyecto. Si deseas montar tu propio bot o experimentar con tus propias APIs, debes rellenar este archivo con tus credenciales de desarrollador obtenidas en los paneles de Discord y Spotify:

```env
# Token del Bot de Discord
DISCORD_TOKEN=tu_token_de_discord_aqui

# Credenciales de la Aplicación de Discord (Developer Portal)
DISCORD_CLIENT_ID=tu_client_id_de_discord
DISCORD_PUBLIC_KEY=tu_public_key_de_discord
DISCORD_CLIENT_SECRET=tu_client_secret_de_discord

# Credenciales de la Aplicación de Spotify (Spotify Developer Dashboard)
SPOTIFY_CLIENT_ID=tu_client_id_de_spotify
SPOTIFY_CLIENT_SECRET=tu_client_secret_de_spotify

# URI de redirección de Spotify para autenticación (Debe coincidir con la de Spotify Dashboard)
SPOTIFY_REDIRECT_URI=http://localhost:5000/callback

# Puerto donde se ejecuta el servidor del panel web
PORT=5000
```

### 1. Cómo obtener las credenciales de Discord:
1. Ve al [Discord Developer Portal](https://discord.com/developers/applications).
2. Crea una nueva aplicación y copia el **Application ID** (`DISCORD_CLIENT_ID`) y la **Public Key** (`DISCORD_PUBLIC_KEY`).
3. Ve a la pestaña **Bot**, genera un token para el bot (`DISCORD_TOKEN`) y activa los **Privileged Gateway Intents**:
   * *Presence Intent*
   * *Server Members Intent*
   * *Message Content Intent*
4. En **OAuth2**, genera un *Client Secret* (`DISCORD_CLIENT_SECRET`).
5. Ve a la sección **OAuth2 -> General** e ingresa en **Redirects** tu URL de interacciones si planeas usar slash commands (opcional).

### 2. Cómo obtener las credenciales de Spotify:
1. Ve al [Spotify Developer Dashboard](https://developer.spotify.com/dashboard).
2. Crea una aplicación, ponle un nombre y copia el **Client ID** (`SPOTIFY_CLIENT_ID`) y **Client Secret** (`SPOTIFY_CLIENT_SECRET`).
3. Haz clic en **Edit Settings** y en **Redirect URIs** añade la dirección URI de tu bot (ej: `http://localhost:5000/callback` o `http://192.168.1.95:5000/callback` utilizando tu IP local). Asegúrate de que coincida exactamente con `SPOTIFY_REDIRECT_URI` de tu archivo `.env`.

---

## 📦 Instalación y Despliegue Local

1. Instala todas las dependencias del proyecto ejecutando:
   ```bash
   npm install
   ```
2. Inicia el bot:
   ```bash
   npm start
   ```
3. El bot te mostrará tu enlace local en la consola y dibujará un código QR.
4. **Abrir el Panel:**
   * **En PC (Ctrl+Clic):** Abre `http://localhost:5000` en tu navegador.
   * **En Celular (Móvil):** Escanea el código QR que se muestra en tu terminal (ambos dispositivos deben estar conectados al mismo Wi-Fi).
5. **Vincular Spotify:** En el panel, haz clic en **Vincular Spotify** o entra a `http://localhost:5000/login` e inicia sesión con la cuenta de Spotify que vas a retransmitir.

---

## 🎮 Comandos de Discord

El bot escucha los siguientes comandos escritos en cualquier canal de texto de tu servidor:

* `!joinS`: Conecta el bot a tu canal de voz actual de Discord e inicia la sincronización de Spotify en tiempo real.
* `!leaveS`: Desconecta al bot del canal de voz y detiene el streaming.
* `!creador`: Muestra quién es el creador del bot.
* `!nowplaying`: Muestra detalles de la canción reproduciéndose ahora en Discord.
* `!queue`: Lista las siguientes 5 canciones en la cola de Spotify.
* `!fav`: Muestra o guarda favoritos.
* `!historial` o `!history`: Lista los últimos 5 temas reproducidos.
* `!loop`: Cambia el modo de bucle (none / track / queue).

---

## 💎 Créditos de Desarrollo

Este bot fue conceptualizado, diseñado y creado con ❤️ por **iJahir_x503**.
