# HCPSS Greeter & Voice Announcement Bot

This is the Discord Gateway companion bot for the School Status Worker (`ss-worker`).

## Why is this separate from `ss-worker`?
- **Cloudflare Workers (`ss-worker`)** is serverless HTTP. It cannot establish or maintain a persistent WebSocket Gateway connection to Discord, nor can it open UDP sockets for real-time Opus voice streaming.
- **`hcpss-greeter`** runs Node.js 24/7 with a persistent Discord Gateway connection. When a status change or weather alert occurs, `ss-worker` dispatches an internal bridge command, and `hcpss-greeter` joins active voice channels in the server, speaks the status update **3 times** using TTS audio, and disconnects.

## Quick Start (Local Windows)
1. In this directory (`hcpss-greeter`), open `.env` and set your `DISCORD_BOT_TOKEN`:
   ```env
   DISCORD_BOT_TOKEN=your_real_discord_bot_token_here
   ```
2. Double-click `start_greeter.bat` or run:
   ```bash
   npm start
   ```
3. Make sure the bot role has **Connect** and **Speak** permissions in your server's voice channels!

## Cloud / 24/7 Hosting (Render / Railway / VPS)
- **Render**: Connect this repository, create a Web Service or Background Worker with root directory `hcpss-greeter`, build command `npm install`, start command `npm start`, and environment variable `DISCORD_BOT_TOKEN`.
- **Railway / VPS**: Run with `pm2 start index.js --name "hcpss-greeter"`.
