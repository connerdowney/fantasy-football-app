# Fantasy Football Dashboard

A self-hosted fantasy football dashboard that aggregates data across Sleeper, ESPN, and Yahoo into a single real-time view. Built for personal use on a Mac, managed with pm2, and accessible remotely via Tailscale.

## Features

- **Multi-platform support**: Sleeper (public API), ESPN (cookie auth), Yahoo (Chrome extension)
- **Live scoreboard**: Mini-score strip with win probability bars and live score updates
- **Scrolling ticker**: Top performers across all leagues with simple/2-line display toggle
- **Player rankings**: FantasyPros ECR data with consensus spread indicators
- **Roster alerts**: Start/sit recommendations, injury flags, bye week warnings
- **Matchup details**: Expandable league cards with full lineup breakdowns
- **Weekly trends**: Historical performance tracking and power rankings
- **News aggregation**: Player news from ESPN with roster-relevant filtering
- **Waiver wire**: Free agent analysis with add/drop recommendations
- **Dark mode**: Full theme support with design token system
- **Auto-refresh**: Configurable polling with visual status indicators

## Architecture

Single-file frontend (`index.html`) with all CSS, JavaScript, and HTML inline — no build step, no framework. The Node/Express backend (`server.js`) handles API proxying, data aggregation, and serves the frontend. SQLite (`fantasy-data.db`) stores weekly snapshots and historical data.

See [ARCHITECTURE.md](ARCHITECTURE.md) for detailed technical documentation.

## Quick Start

### Prerequisites

- Node.js 18+
- npm
- pm2 (`npm install -g pm2`)

### Setup

```bash
# Clone and install
git clone <repo-url> fantasy-dashboard
cd fantasy-dashboard
npm install

# Configure credentials
cp credentials.example.json credentials.json
# Edit credentials.json with your ESPN espn_s2 and SWID cookies

# Start with pm2
pm2 start ecosystem.config.js

# Or run directly
node server.js
```

The dashboard will be available at `http://localhost:3001`.

### ESPN Setup

1. Log into ESPN Fantasy Football in your browser
2. Open DevTools > Application > Cookies
3. Copy `espn_s2` and `SWID` values
4. Add them to `credentials.json`

### Yahoo Setup

1. Load the Chrome extension from `chrome-extension/` as an unpacked extension
2. Sign into Yahoo Fantasy in Chrome
3. The extension automatically pushes data to the dashboard server

### Sleeper Setup

No configuration needed — Sleeper's API is public. The dashboard auto-discovers your leagues via your Sleeper username (configured in `server.js`).

## Configuration

### credentials.json

```json
{
  "espn_s2": "your-espn-s2-cookie",
  "swid": "{your-swid-cookie}",
  "sleeperUsername": "your-sleeper-username"
}
```

**Never commit this file.** It's in `.gitignore`.

### ecosystem.config.js

pm2 process manager config. Watches for file changes and auto-restarts the server. SQLite WAL files and cache files are excluded from watch to prevent restart loops.

## Project Structure

```
fantasy-dashboard/
├── index.html              # Frontend (all CSS/JS/HTML inline, ~300KB)
├── server.js               # Express server, API proxy, data aggregation
├── db-layer.js             # SQLite database layer (better-sqlite3)
├── credentials.json        # API credentials (gitignored)
├── ecosystem.config.js     # pm2 configuration
├── package.json            # Node dependencies
├── chrome-extension/       # Yahoo data Chrome extension
│   ├── manifest.json
│   ├── content.js
│   ├── popup.html
│   └── popup.js
├── .certs/                 # HTTPS certificates (for Tailscale)
└── scripts/                # Utility scripts
```

## Security

- `credentials.json` holds ESPN cookies and is never committed
- All ESPN API calls run server-side (the ESPN API blocks non-browser requests from cloud IPs)
- Yahoo Chrome extension never sends cookies or tokens outside Yahoo's domains
- No external proxies or Cloudflare Workers — all data flows through the local server
