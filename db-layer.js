/**
 * db-layer.js — SQLite historical data storage for the Fantasy Football Dashboard
 *
 * This module uses `better-sqlite3`, a synchronous SQLite driver for Node.js.
 * Synchronous means every call returns its result immediately (no promises/callbacks),
 * which keeps the code simple and is perfectly fine for a local dashboard.
 *
 * Usage in server.js:
 *   const db = require('./db-layer');
 *   db.initDB();                          // call once at startup
 *   app.use(db.routes);                   // mount the /api/history/* routes
 *   // inside your refresh cycle:
 *   db.autoSnapshot(allLeaguesData);       // persist the latest data
 */

const Database = require('better-sqlite3');
const path = require('path');
const express = require('express');

// ---------------------------------------------------------------------------
// Database connection (module-level so every function shares one handle)
// ---------------------------------------------------------------------------
let db;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
-- weekly_snapshots: one row per league per week, storing matchup results.
-- The UNIQUE constraint means we can "upsert" — insert if new, update if exists.
CREATE TABLE IF NOT EXISTS weekly_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  platform TEXT NOT NULL,           -- 'sleeper', 'espn', 'yahoo'
  league_id TEXT NOT NULL,
  league_name TEXT NOT NULL,
  my_team TEXT,
  opp_team TEXT,
  my_score REAL DEFAULT 0,
  opp_score REAL DEFAULT 0,
  my_proj REAL,
  opp_proj REAL,
  result TEXT,                      -- 'W', 'L', 'T', or null (not yet played)
  snapshot_data TEXT,               -- JSON blob with full matchup detail
  captured_at INTEGER NOT NULL,     -- Unix timestamp in seconds
  UNIQUE(season, week, platform, league_id)
);

-- roster_snapshots: full roster for a team in a given week.
-- Storing the roster as JSON keeps the schema simple while still letting us
-- query individual players via the player_scores table below.
CREATE TABLE IF NOT EXISTS roster_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  platform TEXT NOT NULL,
  league_id TEXT NOT NULL,
  team_key TEXT NOT NULL,
  team_name TEXT,
  roster_data TEXT NOT NULL,        -- JSON array of players
  optimal_data TEXT,                -- JSON of optimal lineup analysis
  captured_at INTEGER NOT NULL,
  UNIQUE(season, week, platform, league_id, team_key)
);

-- player_scores: one row per player per week per league.
-- Broken out from the roster so we can query trends for a single player.
CREATE TABLE IF NOT EXISTS player_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  platform TEXT NOT NULL,
  league_id TEXT NOT NULL,
  player_name TEXT NOT NULL,
  pos TEXT,                         -- 'QB', 'RB', 'WR', 'TE', etc.
  team TEXT,                        -- NFL team abbreviation
  slot TEXT,                        -- lineup slot: 'QB', 'RB', 'FLEX', 'BN', etc.
  points REAL DEFAULT 0,
  projected REAL DEFAULT 0,
  is_starter INTEGER DEFAULT 0,    -- 1 = in a starting slot, 0 = bench
  captured_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_player_scores_lookup
  ON player_scores(season, week, player_name);

-- decision_log: actionable alerts (bench a starter, grab a waiver wire player, etc.)
CREATE TABLE IF NOT EXISTS decision_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  season INTEGER NOT NULL,
  week INTEGER NOT NULL,
  platform TEXT NOT NULL,
  league_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,         -- 'bench_starter', 'injury', 'waiver'
  priority INTEGER DEFAULT 0,      -- higher number = more urgent
  title TEXT NOT NULL,
  detail TEXT,
  player_name TEXT,
  action_taken TEXT,                -- null until user acts on it
  created_at INTEGER NOT NULL,
  dismissed_at INTEGER              -- timestamp when dismissed, null if active
);

-- yahoo_cache: persistent storage for Yahoo extension data
-- Survives server restarts and browser disconnects
CREATE TABLE IF NOT EXISTS yahoo_cache (
  cache_key TEXT PRIMARY KEY,        -- 'leagues', 'scoreboard:<key>', 'roster:<key>'
  data TEXT NOT NULL,                -- raw JSON string from Yahoo API
  received_at INTEGER NOT NULL,      -- Unix timestamp ms when data was received
  week INTEGER                       -- NFL week number (null for leagues)
);
`;

// ---------------------------------------------------------------------------
// Initialization
// ---------------------------------------------------------------------------

/**
 * Open (or create) the SQLite database file and run the schema.
 *
 * `better-sqlite3` creates the file automatically if it doesn't exist.
 * The WAL (Write-Ahead Logging) journal mode is faster for concurrent reads
 * and writes because readers don't block writers and vice versa.
 */
function initDB() {
  const dbPath = path.join(__dirname, 'fantasy-data.db');

  // Open the database. { verbose: console.log } can be passed for debugging.
  db = new Database(dbPath);

  // WAL mode: better performance for a server that reads and writes frequently.
  // This is a one-time setting that persists in the database file itself.
  db.pragma('journal_mode = WAL');

  // Run every CREATE TABLE / CREATE INDEX statement in our schema.
  // `exec` runs raw SQL that can contain multiple statements separated by ";".
  db.exec(SCHEMA);

  console.log('[db] SQLite initialized at', dbPath);
}

// ---------------------------------------------------------------------------
// Helper: current Unix timestamp in seconds
// ---------------------------------------------------------------------------
function now() {
  return Math.floor(Date.now() / 1000);
}

// ---------------------------------------------------------------------------
// Weekly Snapshots
// ---------------------------------------------------------------------------

/**
 * Save (or update) a weekly matchup snapshot.
 *
 * We use INSERT ... ON CONFLICT ... DO UPDATE (an "upsert") so that:
 *   - First call for a (season, week, platform, league_id) inserts a new row.
 *   - Later calls update the existing row with fresh scores/result.
 *
 * `db.prepare(sql)` compiles the SQL once; `.run(params)` executes it.
 * The `?` placeholders are bound positionally from the arguments array.
 */
function saveWeeklySnapshot(season, week, platform, leagueId, leagueName, matchupData) {
  const stmt = db.prepare(`
    INSERT INTO weekly_snapshots
      (season, week, platform, league_id, league_name,
       my_team, opp_team, my_score, opp_score, my_proj, opp_proj,
       result, snapshot_data, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season, week, platform, league_id) DO UPDATE SET
      league_name   = excluded.league_name,
      my_team       = excluded.my_team,
      opp_team      = excluded.opp_team,
      my_score      = excluded.my_score,
      opp_score     = excluded.opp_score,
      my_proj       = excluded.my_proj,
      opp_proj      = excluded.opp_proj,
      result        = excluded.result,
      snapshot_data = excluded.snapshot_data,
      captured_at   = excluded.captured_at
  `);

  // `excluded` refers to the values we tried to INSERT — SQLite's way of
  // saying "use the new values" inside the ON CONFLICT UPDATE clause.
  stmt.run(
    season, week, platform, leagueId, leagueName,
    matchupData.myTeam || null,
    matchupData.oppTeam || null,
    matchupData.myScore || 0,
    matchupData.oppScore || 0,
    matchupData.myProj || null,
    matchupData.oppProj || null,
    matchupData.result || null,
    JSON.stringify(matchupData),   // store the full object as a JSON string
    now()
  );
}

/**
 * Get all weekly snapshots for a specific week across all leagues.
 *
 * `.all()` returns an array of row objects (one per matching row).
 * If nothing matches, it returns an empty array — never null.
 */
function getWeekSnapshots(season, week) {
  const stmt = db.prepare(`
    SELECT * FROM weekly_snapshots
    WHERE season = ? AND week = ?
    ORDER BY platform, league_name
  `);
  return stmt.all(season, week);
}

/**
 * Get a single league's history across all weeks in a season.
 * Useful for the "trends" view — shows how your record evolved over time.
 */
function getLeagueHistory(season, platform, leagueId) {
  const stmt = db.prepare(`
    SELECT * FROM weekly_snapshots
    WHERE season = ? AND platform = ? AND league_id = ?
    ORDER BY week ASC
  `);
  return stmt.all(season, platform, leagueId);
}

// ---------------------------------------------------------------------------
// Roster Snapshots
// ---------------------------------------------------------------------------

/**
 * Save (or update) a roster snapshot. Same upsert pattern as above.
 */
function saveRosterSnapshot(season, week, platform, leagueId, teamKey, teamName, rosterData, optimalData) {
  const stmt = db.prepare(`
    INSERT INTO roster_snapshots
      (season, week, platform, league_id, team_key, team_name,
       roster_data, optimal_data, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(season, week, platform, league_id, team_key) DO UPDATE SET
      team_name    = excluded.team_name,
      roster_data  = excluded.roster_data,
      optimal_data = excluded.optimal_data,
      captured_at  = excluded.captured_at
  `);

  stmt.run(
    season, week, platform, leagueId, teamKey, teamName,
    JSON.stringify(rosterData),
    optimalData ? JSON.stringify(optimalData) : null,
    now()
  );
}

/**
 * Get roster snapshots. All parameters after `week` are optional filters.
 *
 * We build the WHERE clause dynamically so one function handles:
 *   - All rosters for a week
 *   - Rosters for a specific league
 *   - A specific team's roster
 */
function getRosterSnapshots(season, week, platform, leagueId, teamKey) {
  let sql = 'SELECT * FROM roster_snapshots WHERE season = ? AND week = ?';
  const params = [season, week];

  if (platform) {
    sql += ' AND platform = ?';
    params.push(platform);
  }
  if (leagueId) {
    sql += ' AND league_id = ?';
    params.push(leagueId);
  }
  if (teamKey) {
    sql += ' AND team_key = ?';
    params.push(teamKey);
  }

  sql += ' ORDER BY platform, league_id, team_key';

  // For dynamic SQL we still use prepare() — it's safe from injection because
  // user values go through `?` placeholders, never string concatenation.
  return db.prepare(sql).all(...params);
}

// ---------------------------------------------------------------------------
// Player Scores
// ---------------------------------------------------------------------------

/**
 * Save a batch of player scores for one league/week.
 *
 * We delete existing rows first, then insert fresh ones. This avoids duplicates
 * when re-snapshotting (e.g., scores update during a game).
 *
 * Wrapping both operations in a TRANSACTION means they either both succeed or
 * both roll back — we never end up with a half-deleted, half-inserted state.
 *
 * `db.transaction(fn)` returns a new function that, when called, runs `fn`
 * inside BEGIN/COMMIT. If `fn` throws, it automatically rolls back.
 *
 * @param {Array} players - Array of { playerName, pos, team, slot, points, projected, isStarter }
 */
function savePlayerScores(season, week, platform, leagueId, players) {
  if (!players || players.length === 0) return;

  const deleteStmt = db.prepare(`
    DELETE FROM player_scores
    WHERE season = ? AND week = ? AND platform = ? AND league_id = ?
  `);

  const insertStmt = db.prepare(`
    INSERT INTO player_scores
      (season, week, platform, league_id, player_name,
       pos, team, slot, points, projected, is_starter, captured_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // The transaction function: delete old rows, insert new ones.
  const saveBatch = db.transaction((playerList) => {
    deleteStmt.run(season, week, platform, leagueId);

    const ts = now();
    for (const p of playerList) {
      insertStmt.run(
        season, week, platform, leagueId,
        p.playerName || p.name || 'Unknown',
        p.pos || null,
        p.team || null,
        p.slot || null,
        p.points || p.pts || 0,
        p.projected || p.proj || 0,
        p.isStarter !== undefined ? (p.isStarter ? 1 : 0) : (p.slot && p.slot !== 'BN' && p.slot !== 'IR' ? 1 : 0),
        ts
      );
    }
  });

  saveBatch(players);
}

/**
 * Get a player's scores across all weeks in a season.
 * Returns one row per week/league so you can chart their trajectory.
 */
function getPlayerTrends(season, playerName) {
  const stmt = db.prepare(`
    SELECT ps.*, ws.league_name
    FROM player_scores ps
    LEFT JOIN weekly_snapshots ws
      ON ps.season = ws.season
      AND ps.week = ws.week
      AND ps.platform = ws.platform
      AND ps.league_id = ws.league_id
    WHERE ps.season = ? AND ps.player_name = ?
    ORDER BY ps.week ASC, ps.platform, ps.league_id
  `);

  // LEFT JOIN brings in the league name from weekly_snapshots so the caller
  // knows which league each score came from.
  return stmt.all(season, playerName);
}

// ---------------------------------------------------------------------------
// Season Trends (aggregate stats per week)
// ---------------------------------------------------------------------------

/**
 * Build a season-level performance summary: for each week, aggregate
 * total points scored, total projected, wins, losses, and optimal lineup %.
 *
 * This powers the "Trends" tab on the dashboard.
 */
function getSeasonTrends(season) {
  // Step 1: aggregate matchup results per week from weekly_snapshots
  const weeklyStats = db.prepare(`
    SELECT
      week,
      SUM(my_score) AS totalPoints,
      SUM(my_proj)  AS totalProjPoints,
      SUM(CASE WHEN result = 'W' THEN 1 ELSE 0 END) AS wins,
      SUM(CASE WHEN result = 'L' THEN 1 ELSE 0 END) AS losses,
      SUM(CASE WHEN result = 'T' THEN 1 ELSE 0 END) AS ties
    FROM weekly_snapshots
    WHERE season = ?
    GROUP BY week
    ORDER BY week ASC
  `).all(season);

  // Step 2: for each week, check if we have optimal lineup data in roster_snapshots
  // and compute an average optimal percentage.
  const optimalStmt = db.prepare(`
    SELECT optimal_data FROM roster_snapshots
    WHERE season = ? AND week = ?
  `);

  return weeklyStats.map((row) => {
    let optimalPct = null;

    const rosters = optimalStmt.all(season, row.week);
    if (rosters.length > 0) {
      let totalActual = 0;
      let totalOptimal = 0;
      let counted = 0;

      for (const r of rosters) {
        if (!r.optimal_data) continue;
        try {
          const opt = JSON.parse(r.optimal_data);
          if (opt.actualTotal != null && opt.optimalTotal != null && opt.optimalTotal > 0) {
            totalActual += opt.actualTotal;
            totalOptimal += opt.optimalTotal;
            counted++;
          }
        } catch {
          // skip unparseable rows
        }
      }

      if (counted > 0 && totalOptimal > 0) {
        // optimalPct: how close your actual lineups were to the best possible
        optimalPct = Math.round((totalActual / totalOptimal) * 1000) / 10;
      }
    }

    return {
      week: row.week,
      totalPoints: row.totalPoints || 0,
      totalProjPoints: row.totalProjPoints || 0,
      wins: row.wins || 0,
      losses: row.losses || 0,
      ties: row.ties || 0,
      optimalPct,
    };
  });
}

// ---------------------------------------------------------------------------
// Decision Alerts
// ---------------------------------------------------------------------------

/**
 * Save a new decision alert to the log.
 * Returns the inserted row's id (useful for dismissing later).
 *
 * `.run()` returns an info object with `changes` (rows affected) and
 * `lastInsertRowid` (the AUTOINCREMENT id of the new row).
 */
function saveDecisionAlert(season, week, platform, leagueId, alertType, priority, title, detail, playerName) {
  const stmt = db.prepare(`
    INSERT INTO decision_log
      (season, week, platform, league_id, alert_type, priority,
       title, detail, player_name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    season, week, platform, leagueId,
    alertType, priority || 0,
    title, detail || null, playerName || null,
    now()
  );

  return info.lastInsertRowid;
}

/**
 * Get all active (non-dismissed) alerts for a given week.
 * Ordered by priority descending so the most urgent appear first.
 */
function getActiveAlerts(season, week) {
  const stmt = db.prepare(`
    SELECT * FROM decision_log
    WHERE season = ? AND week = ? AND dismissed_at IS NULL
    ORDER BY priority DESC, created_at DESC
  `);
  return stmt.all(season, week);
}

/**
 * Dismiss an alert by setting its dismissed_at timestamp.
 * The row stays in the database for historical reference.
 */
function dismissAlert(alertId) {
  const stmt = db.prepare(`
    UPDATE decision_log
    SET dismissed_at = ?
    WHERE id = ?
  `);
  return stmt.run(now(), alertId);
}

// ---------------------------------------------------------------------------
// Week Selector Support
// ---------------------------------------------------------------------------

/**
 * Get a list of weeks that have cached snapshot data for a season.
 * Used to populate the week-selector dropdown on the dashboard.
 *
 * DISTINCT ensures each week appears only once even if multiple leagues exist.
 */
function getAvailableWeeks(season) {
  const stmt = db.prepare(`
    SELECT DISTINCT week FROM weekly_snapshots
    WHERE season = ?
    ORDER BY week ASC
  `);
  // `.all()` returns [{week: 1}, {week: 2}, ...], so we map to a flat array.
  return stmt.all(season).map((r) => r.week);
}

/**
 * Get all data for a specific prior week — snapshots and rosters bundled together.
 * This is the main endpoint for the week selector / history viewer.
 */
function getWeekData(season, week) {
  return {
    snapshots: getWeekSnapshots(season, week),
    rosters: getRosterSnapshots(season, week),
  };
}

// ---------------------------------------------------------------------------
// Auto-Snapshot Hook
// ---------------------------------------------------------------------------

/**
 * Called from the existing refresh cycle with the aggregated league data.
 * Persists matchup snapshots and player scores for every league in one go.
 *
 * This is the main integration point: after the dashboard fetches live data
 * from Sleeper/ESPN/Yahoo, it passes the result here to archive it.
 *
 * @param {Object} allLeaguesData - Shape: { season, week, leagues: [...] }
 */
function autoSnapshot(allLeaguesData) {
  if (!db) {
    console.warn('[db] autoSnapshot called before initDB — skipping');
    return;
  }

  const { season, week, leagues } = allLeaguesData;
  if (!season || !week || !Array.isArray(leagues)) {
    console.warn('[db] autoSnapshot received invalid data — skipping');
    return;
  }

  // Wrap everything in a single transaction for speed and atomicity.
  // Without this, each INSERT would be its own transaction (slow for many rows).
  const snapshotAll = db.transaction(() => {
    for (const league of leagues) {
      if (!league.leagueId) continue; // skip leagues with no ID
      // 1. Save the weekly matchup snapshot
      saveWeeklySnapshot(season, week, league.platform, league.leagueId, league.name, {
        myTeam: league.myName,
        oppTeam: league.oppName,
        myScore: league.myScore,
        oppScore: league.oppScore,
        myProj: league.myProj,
        oppProj: league.oppProj,
        result: league.result,
      });

      // 2. Save "my" roster snapshot if roster data is available
      if (Array.isArray(league.myRoster) && league.myRoster.length > 0) {
        const myKey = league.myName || 'my_team';
        saveRosterSnapshot(
          season, week, league.platform, league.leagueId,
          myKey, league.myName, league.myRoster, null
        );

        // 3. Save individual player scores from my roster
        savePlayerScores(season, week, league.platform, league.leagueId, league.myRoster);
      }

      // 4. Save opponent roster snapshot if available
      if (Array.isArray(league.oppRoster) && league.oppRoster.length > 0) {
        const oppKey = league.oppName || 'opp_team';
        saveRosterSnapshot(
          season, week, league.platform, league.leagueId,
          oppKey, league.oppName, league.oppRoster, null
        );
      }
    }
  });

  try {
    snapshotAll();
    console.log(`[db] Auto-snapshot saved: season ${season}, week ${week}, ${leagues.length} league(s)`);
  } catch (err) {
    console.error('[db] Auto-snapshot failed:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Express API Routes
// ---------------------------------------------------------------------------

const routes = express.Router();

// GET /api/history/weeks/:season
// Returns an array of week numbers that have stored data.
routes.get('/api/history/weeks/:season', (req, res) => {
  try {
    const season = parseInt(req.params.season, 10);
    const weeks = getAvailableWeeks(season);
    res.json({ season, weeks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/week/:season/:week
// Returns the full data bundle for a specific week (snapshots + rosters).
routes.get('/api/history/week/:season/:week', (req, res) => {
  try {
    const season = parseInt(req.params.season, 10);
    const week = parseInt(req.params.week, 10);
    const data = getWeekData(season, week);
    res.json({ season, week, ...data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/league/:season/:platform/:leagueId
// Returns all weekly snapshots for one league (for charting win/loss trends).
routes.get('/api/history/league/:season/:platform/:leagueId', (req, res) => {
  try {
    const { season, platform, leagueId } = req.params;
    const history = getLeagueHistory(parseInt(season, 10), platform, leagueId);
    res.json({ season: parseInt(season, 10), platform, leagueId, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/trends/:season
// Returns the aggregated season trends (points, wins, optimal % per week).
routes.get('/api/history/trends/:season', (req, res) => {
  try {
    const season = parseInt(req.params.season, 10);
    const trends = getSeasonTrends(season);
    res.json({ season, trends });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/history/player/:season/:playerName
// Returns a player's week-by-week scoring across all leagues.
routes.get('/api/history/player/:season/:playerName', (req, res) => {
  try {
    const season = parseInt(req.params.season, 10);
    const playerName = decodeURIComponent(req.params.playerName);
    const trends = getPlayerTrends(season, playerName);
    res.json({ season, playerName, trends });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/alerts/:season/:week
// Returns all active (non-dismissed) decision alerts for the given week.
routes.get('/api/alerts/:season/:week', (req, res) => {
  try {
    const season = parseInt(req.params.season, 10);
    const week = parseInt(req.params.week, 10);
    const alerts = getActiveAlerts(season, week);
    res.json({ season, week, alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/alerts/:alertId/dismiss
// Marks an alert as dismissed (sets dismissed_at to the current timestamp).
routes.post('/api/alerts/:alertId/dismiss', (req, res) => {
  try {
    const alertId = parseInt(req.params.alertId, 10);
    const result = dismissAlert(alertId);
    // result.changes tells us how many rows were updated (should be 0 or 1).
    if (result.changes === 0) {
      res.status(404).json({ error: 'Alert not found or already dismissed' });
    } else {
      res.json({ success: true, alertId });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/snapshot
// Trigger a manual snapshot. Expects the same allLeaguesData shape in the body.
// Requires express.json() middleware to be active on the server.
routes.post('/api/snapshot', (req, res) => {
  try {
    const data = req.body;
    if (!data || !data.season || !data.week || !Array.isArray(data.leagues)) {
      return res.status(400).json({
        error: 'Request body must include season, week, and leagues array',
      });
    }
    autoSnapshot(data);
    res.json({
      success: true,
      season: data.season,
      week: data.week,
      leagueCount: data.leagues.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Yahoo Extension Cache (SQLite-backed)
// ---------------------------------------------------------------------------

/**
 * Save Yahoo extension data to SQLite.
 * @param {string} key - Cache key ('leagues', 'scoreboard:key_week', 'roster:key')
 * @param {string} data - Raw JSON string from Yahoo API
 * @param {number} receivedAt - Unix timestamp ms
 * @param {number|null} week - NFL week number
 */
function saveYahooCache(key, data, receivedAt, week) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO yahoo_cache (cache_key, data, received_at, week)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(key, data, receivedAt, week || null);
}

/**
 * Save all Yahoo extension data in a single transaction.
 * @param {Object} cache - { leagues, scoreboards, rosters, week, receivedAt }
 */
function saveYahooCacheBulk(cache) {
  if (!db) return;
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO yahoo_cache (cache_key, data, received_at, week)
    VALUES (?, ?, ?, ?)
  `);
  const ts = cache.receivedAt || Date.now();
  const week = cache.week || null;

  const txn = db.transaction(() => {
    if (cache.leagues) {
      stmt.run('leagues', cache.leagues, ts, week);
    }
    if (cache.scoreboards) {
      for (const [k, v] of Object.entries(cache.scoreboards)) {
        stmt.run('scoreboard:' + k, v, ts, week);
      }
    }
    if (cache.rosters) {
      for (const [k, v] of Object.entries(cache.rosters)) {
        stmt.run('roster:' + k, v, ts, week);
      }
    }
  });
  txn();
}

/**
 * Load all Yahoo cache data from SQLite.
 * Returns object matching the in-memory cache shape.
 */
function loadYahooCache() {
  if (!db) return null;
  const rows = db.prepare('SELECT cache_key, data, received_at, week FROM yahoo_cache').all();
  if (!rows.length) return null;

  const cache = {
    leagues: null,
    scoreboards: {},
    rosters: {},
    week: null,
    receivedAt: null,
  };

  for (const row of rows) {
    if (row.cache_key === 'leagues') {
      cache.leagues = row.data;
      cache.receivedAt = row.received_at;
      cache.week = row.week;
    } else if (row.cache_key.startsWith('scoreboard:')) {
      const key = row.cache_key.slice('scoreboard:'.length);
      cache.scoreboards[key] = row.data;
      if (!cache.receivedAt || row.received_at > cache.receivedAt) {
        cache.receivedAt = row.received_at;
      }
    } else if (row.cache_key.startsWith('roster:')) {
      const key = row.cache_key.slice('roster:'.length);
      cache.rosters[key] = row.data;
    }
  }

  return cache;
}

/**
 * Get the most recent receivedAt timestamp from Yahoo cache.
 */
function getYahooCacheTimestamp() {
  if (!db) return null;
  const row = db.prepare('SELECT MAX(received_at) as ts FROM yahoo_cache').get();
  return row ? row.ts : null;
}

module.exports = {
  // Lifecycle
  initDB,
  autoSnapshot,

  // Weekly snapshots
  saveWeeklySnapshot,
  getWeekSnapshots,
  getLeagueHistory,

  // Roster snapshots
  saveRosterSnapshot,
  getRosterSnapshots,

  // Player scores
  savePlayerScores,
  getPlayerTrends,

  // Season trends
  getSeasonTrends,

  // Week data bundle
  getWeekData,
  getAvailableWeeks,

  // Decision alerts
  saveDecisionAlert,
  getActiveAlerts,
  dismissAlert,

  // Yahoo cache
  saveYahooCache,
  saveYahooCacheBulk,
  loadYahooCache,
  getYahooCacheTimestamp,

  // Express router (mount with app.use(db.routes))
  routes,
};
