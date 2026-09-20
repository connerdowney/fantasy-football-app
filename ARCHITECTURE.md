# Architecture

## System Overview

```
Browser (localhost:3001)
    │
    ├── index.html (single-file frontend)
    │     ├── CSS design tokens + component styles
    │     ├── HTML layout (header, ticker, scoreboards, league cards, widgets)
    │     └── JavaScript (state management, rendering, API calls)
    │
    └── Express Server (server.js, port 3001)
          ├── Static file serving (index.html with cache disabled)
          ├── API proxy routes
          │     ├── /proxy/sleeper/*     → api.sleeper.app (public, no auth)
          │     ├── /proxy/espn/*        → lm-api-reads.fantasy.espn.com (cookie auth)
          │     ├── /proxy/yahoo/*       → extension cache (Chrome extension pushes data)
          │     └── /api/fantasypros/*   → fantasypros.com (server-side scrape)
          ├── Data aggregation
          │     └── /api/all-leagues     → combined response from all platforms
          ├── Yahoo extension endpoint
          │     └── POST /proxy/yahoo/extension  → receives live data from Chrome ext
          └── Database layer (db-layer.js)
                └── SQLite (fantasy-data.db via better-sqlite3)
```

## Frontend Architecture

### Design Token System

All visual properties flow through CSS custom properties defined on `:root`:

- **Surfaces**: `--surface-0` (page bg, beige) → `--surface-1` (cards, white) → `--surface-2` (subtle bg) → `--surface-3` (borders)
- **Platform accents**: `--accent-sleeper` (blue), `--accent-espn` (red), `--accent-yahoo` (purple)
- **Spacing**: `--space-xs` through `--space-xl` (4px to 32px scale)
- **Radii**: `--radius-sm` (6px), `--radius-md` (10px), `--radius-lg` (14px)

Dark mode overrides these tokens under `[data-theme="dark"]`.

### State Management

A global `STATE` object holds all fetched data:

```javascript
STATE = {
  week: Number,              // Current NFL week
  sleeperLeagues: Array,     // Sleeper league data with matchups
  espnLeagues: Array,        // ESPN league data with rosters
  yahooLeagues: Array,       // Yahoo league data (from extension)
  players: Object,           // Sleeper player database (keyed by player_id)
  news: Array,               // Aggregated news items
  fantasyPros: Object,       // ECR rankings data
  hiddenLeagues: Array,      // User-hidden league IDs
  // ...
}
```

### Rendering Pipeline

1. `refreshAll()` fetches data from all API endpoints in parallel
2. Platform-specific parsers normalize data into `STATE`
3. `renderScoreboard()` builds the mini-score strip
4. `renderTicker()` builds the scrolling top performers ticker
5. `renderLeagues()` builds expandable league cards via `scoreCard()`
6. Widget sections (roster alerts, power rankings, etc.) render independently

### View System

Six main views controlled by `switchMainView()`:
- **Home**: Scoreboard + ticker + league cards + widgets
- **Scores**: Full matchup details
- **Widgets**: Roster alerts, power rankings, weekly recap, waiver wire
- **News**: Aggregated player news
- **Trends**: Historical performance charts
- **Decisions**: Start/sit recommendations with ECR data

## Server Architecture

### API Proxy Routes

The server proxies all external API calls to avoid CORS issues and to keep credentials server-side:

| Route | Upstream | Auth |
|-------|----------|------|
| `/proxy/sleeper/leagues/:username` | `api.sleeper.app` | None |
| `/proxy/sleeper/matchups/:leagueId/:week` | `api.sleeper.app` | None |
| `/proxy/espn/scoreboard/:leagueId` | `lm-api-reads.fantasy.espn.com` | espn_s2 + SWID cookies |
| `/proxy/yahoo/leagues` | Extension cache | Chrome extension |
| `/api/fantasypros/projections/:week` | `fantasypros.com` | Server-side scrape |
| `/api/all-leagues` | All platforms | Combined |

### Caching Strategy

- **FantasyPros**: 30-minute TTL in-memory cache per week+scoring combo
- **Yahoo extension**: In-memory cache with staleness tracking (10-minute fresh window)
- **ESPN/Sleeper**: No server-side cache (frontend handles refresh timing)
- **Express static**: Caching disabled (`etag: false, lastModified: false, maxAge: 0`)

### Database (db-layer.js)

SQLite via `better-sqlite3` (synchronous, file-based):

- **weekly_snapshots**: Weekly matchup scores by league
- **player_snapshots**: Individual player performance per week
- **Auto-snapshot**: Runs on data fetch, creates point-in-time records

## Chrome Extension (Yahoo)

The extension uses a MAIN world content script to access Yahoo's page context and read fantasy data through Yahoo's own JavaScript APIs. Data is POSTed to `localhost:3001/proxy/yahoo/extension`.

Key constraints:
- Must use MAIN world injection (not isolated world) to access Yahoo's JS objects
- Never sends cookies or tokens outside Yahoo's domains
- Runs an auth probe before each data fetch
- Stale cache serves as fallback when extension data is unavailable

## Deployment

- **Process manager**: pm2 with `--watch` (auto-restarts on file changes)
- **Port**: 3001
- **Remote access**: Tailscale (private network, no port forwarding)
- **HTTPS**: Self-signed certs in `.certs/` for Tailscale HTTPS
