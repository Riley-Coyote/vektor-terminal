# ⏀ Vektor Terminal

Native desktop interface for [OpenClaw](https://github.com/openclaw) agents.

## Features

- **Multi-agent support** — Switch between agents with unique identities, glyphs, and color themes
- **Thread management** — Persistent conversation threads with auto-archival
- **Memory system** — Per-agent memory files with live viewer
- **Journal** — Agent journal/thought stream viewer
- **Skills browser** — Browse and manage agent skills
- **Cross-agent context** — Shared context across multiple agents
- **Detached mode** — Floating glass window mode for overlay use
- **Electron desktop app** — Native macOS application

## Quick Start

1. Clone and install:
   ```bash
   git clone https://github.com/your-username/vektor-terminal.git
   cd vektor-terminal
   npm install
   ```

2. Configure your agent(s):
   ```bash
   cp agents.example.json agents.json
   cp .env.example .env
   # Edit agents.json with your agent configuration
   # Edit .env with your gateway URL
   ```

3. Start the server:
   ```bash
   npm start
   ```

4. Open `http://localhost:8088` in your browser.

### Electron (Desktop App)

```bash
npm run electron:dev
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OPENCLAW_GATEWAY` | `http://127.0.0.1:18789` | OpenClaw gateway URL |
| `ANTHROPIC_API_KEY` | — | Direct Anthropic API key (bypasses gateway) |
| `VEKTOR_USER_NAME` | `User` | Display name for the human user |
| `PORT` | `8088` | Server port |
| `OPENCLAW_DIR` | `~/.openclaw` | OpenClaw configuration directory |
| `VEKTOR_ARCHIVE_DIR` | `./data/archive` | Conversation archive directory |

### Agent Configuration (`agents.json`)

Define your agents in `agents.json` (see `agents.example.json` for the full schema):

```json
[
  {
    "id": "main",
    "name": "Agent",
    "glyph": "⏀",
    "accent": "#8EC3E3",
    "workspace": "~/projects",
    "memoryFile": "~/projects/MEMORY.md",
    "skillDirs": [
      { "path": "~/.openclaw/skills", "source": "community" }
    ]
  }
]
```

Each agent can have:
- **id** — Unique identifier
- **name** — Display name
- **glyph** — Unicode symbol for the agent
- **accent/accentDim/accentGlow** — Theme colors
- **workspace** — Agent's working directory
- **memoryFile** — Path to agent's memory markdown file
- **memoryDir** — Directory for agent's auto-memory files
- **skillDirs** — Array of skill directory paths
- **journalPath** — Path to agent's journal file (optional)

## Architecture

- `server.mjs` — Express server handling API routes, WebSocket streaming, thread management
- `index.html` — Single-file frontend application
- `electron/` — Electron wrapper for desktop app
- `data/` — Local data storage (threads, artifacts, uploads)

## License

MIT
