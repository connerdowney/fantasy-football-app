# Fantasy Football Dashboard

Self-hosted fantasy football dashboard (Node/Express/SQLite on Mac, single-file frontend).

## Project Management

Work is managed like a 1-person sprint. Sprint board and architecture docs live in the Claude project (not this repo):

- **Roadmap & Sprint Board**: https://claude.ai/artifact/M1CPaVR1axyxZdak4N67g9
- **Architecture**: https://claude.ai/artifact/AhACitLBbP7dG1BjNdnACQ

Start every session by checking the Roadmap -- Bugs and Next Up sections first. Ask what to pick up before building. Conner ideates a lot -- confirm scope before writing code. Token efficiency matters.

When you finish work, update the Roadmap doc -- check off completed items, add new bugs discovered.

## Codebase vs. League Data

The git repo is application code only. Never commit personal league data (scores, rosters, team names, performance logs, scoring rules). League data lives in Claude project docs (week-logs.md, league-scoring-summary.md) and in the SQLite database (gitignored).

## Key Files

| File | Lines | Notes |
|------|-------|-------|
| `index.html` | ~8297 | Single-file frontend. Edit with exact-string Python scripts, never retype |
| `server.js` | ~1033 | Express server with debug logging |
| `db-layer.js` | ~958 | SQLite data layer |
| `fantasy-data.db` | | SQLite DB, gitignored |
| `credentials.json` | | ESPN/Yahoo tokens. NEVER expose, log, or commit |
| `chrome-extension/` | | Yahoo data extension |
| `logs/` | | Daily debug logs: `server-YYYY-MM-DD.log` |
| `ecosystem.config.js` | | pm2 config (watch disabled to avoid boot-loop) |

## Editing index.html

Always use a Python exact-string-replacement script. The file is ~8300 lines -- never retype from memory (truncation risk).

```python
f = 'index.html'
content = open(f).read()
old = """exact string from the file"""
assert old in content, "marker not found"
new = """replacement string"""
content = content.replace(old, new, 1)
open(f, 'w').write(content)
```

## Running the Server

```bash
# Start
pm2 start ecosystem.config.js

# Restart after code changes
pm2 restart server

# View logs
pm2 logs server

# Debug logs (file-based)
tail -f logs/server-$(date +%Y-%m-%d).log
```

pm2 watch is disabled -- restart manually after changes. The `logs/` dir triggers a boot-loop if watch is on.

## Key Gotchas

- Cloud/remote containers cannot reach ESPN APIs -- all ESPN calls run on this Mac server only
- Yahoo data priority: extension cache > OAuth > stale cache
- FantasyPros name normalization: lowercase, strip suffixes (Jr/Sr/II-V), strip non-alphanum
- Never average scores across leagues -- scoring systems differ (PPR vs non-PPR, bonus structures)
- Trends: ESPN/Yahoo populate via `autoSnapshotToServer()` on dashboard refresh. Only Sleeper has backfill (`POST /api/backfill`)

## Security

- Never expose, log, or commit `credentials.json`
- No Cloudflare Workers or external proxies
- Yahoo extension: never POST cookies outside Yahoo domains; never store tokens; always MAIN world content script
