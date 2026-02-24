# Vektor Terminal

A native web UI for interacting with [OpenClaw](https://github.com/openclaw) agents running on the Clawdbot gateway. Built with vanilla HTML/JS and an Express backend, with optional Electron packaging for a desktop app.

## Features

- **Chat** — streaming conversation with SSE, full markdown rendering, syntax-highlighted code blocks
- **Multi-agent support** — switch between agents on the fly
- **Skills panel** — browse and invoke agent skills
- **Memory viewer** — inspect agent memory entries
- **Journal** — filterable, sortable journal with pagination
- **Session log** — real-time session event stream
- **Tasks** — view and manage agent tasks
- **Files** — upload and browse agent files
- **Notifications** — live notification feed via WebSocket
- **Threads** — create, rename, delete, and switch conversation threads
- **Electron desktop app** — native macOS wrapper with system title bar integration

## Prerequisites

- **Node.js** 18+
- A running **Clawdbot / OpenClaw agent** accessible via the gateway (default `http://127.0.0.1:18789`)

## Installation

```bash
git clone https://github.com/your-org/vektor-terminal.git
cd vektor-terminal
npm install
```

## Usage

Start the web server:

```bash
npm start
```

Then open `http://localhost:8088` in your browser.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8088` | Server listen port |
| Gateway URL | `http://127.0.0.1:18789` | Hardcoded in `server.mjs` — edit to point at your gateway |

## Electron (Desktop App)

Run in development:

```bash
npm run electron:dev
```

Build a macOS `.dmg`:

```bash
npm run build:dmg
```

The built app targets Apple Silicon (`arm64`) and includes a custom icon at `build/icon.icns`.

## License

MIT
