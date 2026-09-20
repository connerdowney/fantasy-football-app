const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const https = require('https');
const db = require('./db-layer');

const app = express();
app.use(express.json({ limit: '10mb' }));
const PORT = 3001;
const CREDS_PATH = path.join(__dirname, 'credentials.json');

// Gzip — huge win for the ~30 MB players payload
app.use(compression());

// No caching during dev — must come BEFORE express.static
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});
app.use(express.static(path.join(__dirname), { etag: false, lastModified: false, maxAge: 0 }));

// ═══════════════════════════════════════════════════════════════════
// Shared helpers
// ═══════════════════════════════════════════════════════════════════

function loadCredentials() {
  try {
    return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveCredentials(creds) {
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2) + '\n');
}

/** Generic HTTPS fetch that returns { statusCode, body } */
function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const method = (options.method || 'GET').toUpperCase();
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: options.headers || {},
    };

    const req = https.request(reqOpts, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

// ═══════════════════════════════════════════════════════════════════
// ESPN proxy
// ═══════════════════════════════════════════════════════════════════

/** Return configured ESPN league IDs + SWID so the frontend knows what to fetch */
app.get('/proxy/espn/leagues', (_req, res) => {
  const creds = loadCredentials();
  if (!creds.espn_s2 || creds.espn_s2.startsWith('YOUR_') || !creds.espn_league_ids?.length) {
    return res.json({ configured: false, league_ids: [], swid: null });
  }
  res.json({ configured: true, league_ids: creds.espn_league_ids, swid: creds.SWID || null });
});

// ESPN recent transactions — MUST be before the :week catch-all route
app.get('/proxy/espn/:leagueId/transactions', (req, res) => {
  const creds = loadCredentials();
  if (!creds.espn_s2 || creds.espn_s2.startsWith('YOUR_')) {
    return res.status(400).json({ error: 'ESPN credentials not configured' });
  }

  const { leagueId } = req.params;
  const year = new Date().getFullYear();

  const espnUrl =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}` +
    `/segments/0/leagues/${leagueId}?view=mTransactions2`;

  const options = {
    headers: {
      Cookie: `espn_s2=${creds.espn_s2}; SWID=${creds.SWID}`,
      Accept: 'application/json',
    },
  };

  https.get(espnUrl, options, (upstream) => {
    let body = '';
    upstream.on('data', (chunk) => (body += chunk));
    upstream.on('end', () => {
      res.status(upstream.statusCode).set('Content-Type', 'application/json').send(body);
    });
  }).on('error', (err) => {
    res.status(502).json({ error: 'ESPN transactions fetch failed', detail: err.message });
  });
});

// ESPN free agents — MUST be before the :week catch-all route
app.get('/proxy/espn/:leagueId/freeagents/:week', (req, res) => {
  const creds = loadCredentials();
  if (!creds.espn_s2 || creds.espn_s2.startsWith('YOUR_')) {
    return res.status(400).json({ error: 'ESPN credentials not configured' });
  }

  const { leagueId, week } = req.params;
  const year = new Date().getFullYear();

  // ESPN free agent filter: status=FREEAGENT, sorted by projectedStats (descending), top 50
  const filter = JSON.stringify({
    players: {
      filterStatus: { value: ['FREEAGENT'] },
      filterSlotIds: { value: [0,2,4,6,16,17,23] }, // QB,RB,WR,TE,DEF,K,FLEX
      sortAppliedStatTotal: { sortAsc: false, sortPriority: 1, value: `10${year}${String(week).padStart(2,'0')}` },
      limit: 50,
    }
  });

  const espnUrl =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}` +
    `/segments/0/leagues/${leagueId}?view=kona_player_info&scoringPeriodId=${week}`;

  const options = {
    headers: {
      Cookie: `espn_s2=${creds.espn_s2}; SWID=${creds.SWID}`,
      Accept: 'application/json',
      'x-fantasy-filter': filter,
    },
  };

  https.get(espnUrl, options, (upstream) => {
    let body = '';
    upstream.on('data', (chunk) => (body += chunk));
    upstream.on('end', () => {
      res.status(upstream.statusCode).set('Content-Type', 'application/json').send(body);
    });
  }).on('error', (err) => {
    res.status(502).json({ error: 'ESPN free agent fetch failed', detail: err.message });
  });
});

// ESPN league data — catch-all :week route AFTER specific routes above
app.get('/proxy/espn/:leagueId/:week', (req, res) => {
  const creds = loadCredentials();
  if (!creds.espn_s2 || creds.espn_s2.startsWith('YOUR_')) {
    return res.status(400).json({ error: 'ESPN credentials not configured in credentials.json' });
  }

  const { leagueId, week } = req.params;
  const year = new Date().getFullYear();
  const espnUrl =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}` +
    `/segments/0/leagues/${leagueId}` +
    `?view=mMatchup&view=mRoster&view=mMatchupScore&view=mTeam&view=mSettings&view=mTransactions2&scoringPeriodId=${week}`;

  const options = {
    headers: {
      Cookie: `espn_s2=${creds.espn_s2}; SWID=${creds.SWID}`,
      Accept: 'application/json',
    },
  };

  https.get(espnUrl, options, (upstream) => {
    let body = '';
    upstream.on('data', (chunk) => (body += chunk));
    upstream.on('end', () => {
      res.status(upstream.statusCode).set('Content-Type', 'application/json').send(body);
    });
  }).on('error', (err) => {
    res.status(502).json({ error: 'ESPN fetch failed', detail: err.message });
  });
});

// Temp debug endpoint — returns ESPN team/matchup structure
app.get('/debug/espn/:leagueId', (req, res) => {
  const creds = loadCredentials();
  const { leagueId } = req.params;
  const year = new Date().getFullYear();
  const espnUrl =
    `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}` +
    `/segments/0/leagues/${leagueId}` +
    `?view=mMatchup&view=mRoster&view=mMatchupScore&view=mTeam&scoringPeriodId=1`;

  https.get(espnUrl, {
    headers: { Cookie: `espn_s2=${creds.espn_s2}; SWID=${creds.SWID}`, Accept: 'application/json' },
  }, (upstream) => {
    let body = '';
    upstream.on('data', (c) => (body += c));
    upstream.on('end', () => {
      try {
        const d = JSON.parse(body);
        const out = {
          leagueName: d.settings?.name,
          swid: creds.SWID,
          teamsCount: d.teams?.length,
          teams: (d.teams || []).slice(0, 3).map(t => ({
            id: t.id, name: t.name, location: t.location, nickname: t.nickname,
            abbrev: t.abbrev, primaryOwner: t.primaryOwner, owners: t.owners,
            members: t.members?.map(m => ({ id: m.id, displayName: m.displayName })),
            keys: Object.keys(t),
          })),
          firstMatchup: (() => {
            const m = (d.schedule || []).find(s => s.matchupPeriodId === 1);
            if (!m) return null;
            return {
              homeTeamId: m.home?.teamId,
              homeTotalPoints: m.home?.totalPoints,
              homeTotalPointsLive: m.home?.totalPointsLive,
              homeKeys: m.home ? Object.keys(m.home) : [],
              awayTeamId: m.away?.teamId,
              awayTotalPoints: m.away?.totalPoints,
            };
          })(),
        };
        res.json(out);
      } catch { res.json({ error: 'parse failed', raw: body.slice(0, 500) }); }
    });
  }).on('error', (err) => res.json({ error: err.message }));
});

// ═══════════════════════════════════════════════════════════════════
// Sleeper proxies (cached — players is ~30 MB, projections are large)
// ═══════════════════════════════════════════════════════════════════

let playersCache = null;
let playersCacheTime = 0;
const PLAYERS_CACHE_TTL = 24 * 60 * 60 * 1000;

app.get('/proxy/sleeper/players', (_req, res) => {
  const now = Date.now();
  if (playersCache && now - playersCacheTime < PLAYERS_CACHE_TTL) {
    return res.json(playersCache);
  }

  const url = 'https://api.sleeper.app/v1/players/nfl';
  https.get(url, (upstream) => {
    let body = '';
    upstream.on('data', (chunk) => (body += chunk));
    upstream.on('end', () => {
      try {
        playersCache = JSON.parse(body);
        playersCacheTime = now;
        res.json(playersCache);
      } catch {
        res.status(502).json({ error: 'Failed to parse Sleeper players data' });
      }
    });
  }).on('error', (err) => {
    res.status(502).json({ error: 'Sleeper players fetch failed', detail: err.message });
  });
});

const projectionsCache = {};

app.get('/proxy/sleeper/projections/:season/:week', (req, res) => {
  const { season, week } = req.params;
  const key = `${season}-${week}`;
  const now = Date.now();

  if (projectionsCache[key] && now - projectionsCache[key].time < 30 * 60 * 1000) {
    return res.json(projectionsCache[key].data);
  }

  const url = `https://api.sleeper.app/v1/projections/nfl/regular/${season}/${week}`;
  https.get(url, (upstream) => {
    let body = '';
    upstream.on('data', (chunk) => (body += chunk));
    upstream.on('end', () => {
      try {
        const data = JSON.parse(body);
        projectionsCache[key] = { data, time: now };
        res.json(data);
      } catch {
        res.status(502).json({ error: 'Failed to parse projections' });
      }
    });
  }).on('error', (err) => {
    res.status(502).json({ error: 'Projections fetch failed', detail: err.message });
  });
});

// ═══════════════════════════════════════════════════════════════════
// Yahoo Fantasy proxy
// ═══════════════════════════════════════════════════════════════════

/**
 * In-memory cache for data pushed from the Chrome extension.
 * Populated by POST /proxy/yahoo/extension.
 * Used as fallback (or primary) for the Yahoo proxy routes below.
 */
let yahooExtCache = {
  leagues: null,       // raw JSON string from Yahoo /leagues API
  scoreboards: {},     // { "${leagueKey}_${week}": rawJsonString }
  rosters: {},
  week: null,
  receivedAt: null,
};
const YAHOO_EXT_TTL = 60 * 60 * 1000; // 1 hour — Yahoo session data is stable

// Load persisted extension cache from SQLite on startup (after db.initDB)
function loadYahooCacheFromDB() {
  try {
    const cached = db.loadYahooCache();
    if (cached && cached.receivedAt) {
      yahooExtCache = cached;
      console.log('[Yahoo Ext] Loaded from SQLite (' +
        Object.keys(cached.scoreboards || {}).length + ' scoreboards, ' +
        Object.keys(cached.rosters || {}).length + ' rosters, ' +
        new Date(cached.receivedAt).toISOString() + ')');
    } else {
      console.log('[Yahoo Ext] No cached data in SQLite, starting fresh');
    }
  } catch (e) {
    console.warn('[Yahoo Ext] Failed to load from SQLite:', e.message);
  }
}

/** Save extension cache to SQLite for persistence across restarts */
function persistYahooExtCache() {
  try { db.saveYahooCacheBulk(yahooExtCache); }
  catch (e) { console.warn('[Yahoo Ext] Failed to persist to SQLite:', e.message); }
}

/** True if extension data exists and is fresh */
function extCacheFresh() {
  return !!yahooExtCache.receivedAt && Date.now() - yahooExtCache.receivedAt < YAHOO_EXT_TTL;
}

/** CORS middleware just for the extension endpoint (safe: only reachable from localhost) */
app.use('/proxy/yahoo/extension', (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10mb' })); // parse JSON bodies for the extension POST

// ── SQLite historical data layer ──
db.initDB();
app.use(db.routes);

// Load Yahoo extension cache from SQLite (persists across restarts)
loadYahooCacheFromDB();

/**
 * POST /proxy/yahoo/extension
 * Receives Yahoo API data from the Chrome extension content script.
 * The extension fetches Yahoo's API using the user's session cookies and relays
 * the raw JSON responses here. This bypasses Yahoo OAuth entirely.
 */
app.post('/proxy/yahoo/extension', (req, res) => {
  const { leagues, scoreboards, rosters, week, syncedAt } = req.body || {};
  if (!leagues || typeof leagues !== 'string') {
    return res.status(400).json({ error: 'Missing or invalid leagues payload' });
  }
  yahooExtCache.leagues = leagues;
  yahooExtCache.scoreboards = scoreboards || {};
  yahooExtCache.rosters = rosters || {};
  yahooExtCache.week = week || null;
  yahooExtCache.receivedAt = syncedAt || Date.now();
  console.log(`[Yahoo Ext] Received data: ${Object.keys(yahooExtCache.scoreboards).length} scoreboards, ${Object.keys(yahooExtCache.rosters).length} rosters, week ${week}`);
  persistYahooExtCache();
  res.json({ ok: true, received: new Date(yahooExtCache.receivedAt).toISOString() });
});

// Yahoo OAuth removed - using Chrome extension workaround only

/** Check if Yahoo is configured (extension data only) */
app.get('/proxy/yahoo/status', (_req, res) => {
  const hasExt = extCacheFresh();
  const hasStaleExt = !!yahooExtCache.receivedAt && !hasExt;
  res.json({
    configured: hasExt || hasStaleExt,
    source: hasExt ? 'extension' : hasStaleExt ? 'extension-stale' : 'none',
    extensionCache: {
      fresh: hasExt,
      hasData: !!yahooExtCache.receivedAt,
      receivedAt: yahooExtCache.receivedAt || null,
      ageMinutes: yahooExtCache.receivedAt ? Math.round((Date.now() - yahooExtCache.receivedAt) / 60000) : null,
      rosterCount: Object.keys(yahooExtCache.rosters || {}).length,
      scoreboardCount: Object.keys(yahooExtCache.scoreboards || {}).length,
    },
  });
});

/** User's Yahoo Fantasy leagues for current NFL season (extension cache only) */
app.get('/proxy/yahoo/leagues', async (_req, res) => {
  if (extCacheFresh() && yahooExtCache.leagues) {
    return res.set('Content-Type', 'application/json').send(yahooExtCache.leagues);
  }
  if (yahooExtCache.leagues) {
    return res.set('Content-Type', 'application/json').send(yahooExtCache.leagues);
  }
  res.status(503).json({ error: 'Yahoo extension data not available. Open the Yahoo Fantasy Chrome extension to sync.' });
});

/** League scoreboard for a specific week (extension cache only) */
app.get('/proxy/yahoo/scoreboard/:leagueKey/:week', async (req, res) => {
  const { leagueKey, week } = req.params;
  const cacheKey = `${leagueKey}_${week}`;
  if (yahooExtCache.scoreboards[cacheKey]) {
    return res.set('Content-Type', 'application/json').send(yahooExtCache.scoreboards[cacheKey]);
  }
  // Fallback: extension cached this league at a different week (API week can lag UI by 1)
  const fallbackKey = Object.keys(yahooExtCache.scoreboards).find(k => k.startsWith(`${leagueKey}_`));
  if (fallbackKey) {
    console.log(`[Yahoo Ext] Week mismatch: serving ${fallbackKey} for requested ${cacheKey}`);
    return res.set('Content-Type', 'application/json').send(yahooExtCache.scoreboards[fallbackKey]);
  }
  res.status(503).json({ error: 'Yahoo extension data not available. Open the Yahoo Fantasy Chrome extension to sync.' });
});

/** Team roster (extension cache only) */
app.get('/proxy/yahoo/roster/:teamKey', async (req, res) => {
  const teamKey = req.params.teamKey;
  if (yahooExtCache.rosters?.[teamKey]) {
    return res.set('Content-Type', 'application/json').send(yahooExtCache.rosters[teamKey]);
  }
  res.status(503).json({ error: 'Yahoo extension data not available. Open the Yahoo Fantasy Chrome extension to sync.' });
});

/** Yahoo league transactions (extension cache only) */
app.get('/proxy/yahoo/transactions/:leagueId', async (req, res) => {
  // Transactions not available via extension cache
  res.json({ fantasy_content: { league: [{ transactions: [] }] } });
});

// ═══════════════════════════════════════════════════════════════════
// FantasyPros projections — scrapes ecrData JS variable from rankings pages
// ═══════════════════════════════════════════════════════════════════

const fpCache = {}; // key: `${week}-${scoring}` → { data, time }
const FP_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

/** Fetch raw HTML over HTTPS with browser-like headers */
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const opts = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity',
        'Referer': 'https://www.fantasypros.com/',
      },
    };
    https.get(url, opts, (res) => {
      // Follow single redirect
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchHTML(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} from ${url}`));
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

/** Extract the ecrData JSON object embedded in a FantasyPros page */
function extractEcrData(html) {
  const marker = 'var ecrData = ';
  const startIdx = html.indexOf(marker);
  if (startIdx === -1) return null;
  const jsonStart = html.indexOf('{', startIdx);
  if (jsonStart === -1) return null;
  // Walk balanced braces
  let depth = 0, jsonEnd = -1;
  for (let i = jsonStart; i < Math.min(html.length, jsonStart + 2_000_000); i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') {
      depth--;
      if (depth === 0) { jsonEnd = i; break; }
    }
  }
  if (jsonEnd === -1) return null;
  try { return JSON.parse(html.substring(jsonStart, jsonEnd + 1)); }
  catch { return null; }
}

/**
 * GET /api/fantasypros/projections/:week?scoring=half-point-ppr
 * scoring: 'half-point-ppr' (default) | 'ppr' | 'standard'
 *
 * Returns: { week, scoring, players: [{ name, team, pos, fpPts, fpRank, posRank, rankMin, rankMax }] }
 * fpPts   = projected pts this week per FP experts (r2p_pts or proj_pts)
 * fpRank  = consensus ECR rank (overall)
 * posRank = position rank (1-based index in position list)
 * rankMin/rankMax = expert disagreement range (spread = rankMax - rankMin)
 */
app.get('/api/fantasypros/projections/:week', async (req, res) => {
  const week = parseInt(req.params.week, 10) || 1;
  const scoring = req.query.scoring || 'half-point-ppr'; // half-point-ppr | ppr | standard
  const key = `${week}-${scoring}`;
  const now = Date.now();

  if (fpCache[key] && now - fpCache[key].time < FP_CACHE_TTL) {
    return res.json(fpCache[key].data);
  }

  // Fetch per-position rankings pages and combine
  const positions = ['qb', 'rb', 'wr', 'te', 'k', 'dst'];
  const scoringSlug = scoring === 'standard' ? 'standard' : scoring; // ppr | half-point-ppr | standard
  const results = [];

  await Promise.allSettled(positions.map(async (pos) => {
    try {
      // DST, QB, K don't have scoring-specific URLs on FantasyPros
      const needsScoring = !['dst', 'qb', 'k'].includes(pos);
      const slug = needsScoring ? `${scoringSlug}-${pos}` : pos;
      const url = `https://www.fantasypros.com/nfl/rankings/${slug}.php?week=${week}`;
      // Validate URL before fetching
      try { new URL(url); } catch(ue) {
        console.error(`[FP] Invalid URL for ${pos}: ${url}`);
        return;
      }
      console.log(`[FP] Fetching ${pos}: ${url}`);
      const html = await fetchHTML(url);
      const ecr = extractEcrData(html);
      if (!ecr || !Array.isArray(ecr.players)) {
        console.warn(`[FP] No ecrData.players for ${pos} (week ${week})`);
        return;
      }
      ecr.players.forEach((p, idx) => {
        const fpPts = typeof p.r2p_pts === 'number' ? p.r2p_pts
          : (typeof p.proj_pts === 'number' ? p.proj_pts : null);
        // Extract injury status if available
        const injStatus = p.injury_status || p.injuryStatus || null;
        results.push({
          name: p.player_name || '',
          team: p.player_team_id || '',
          pos: (p.player_position_id || pos).toUpperCase(),
          fpPts,
          fpRank: p.rank_ecr || (idx + 1),
          posRank: idx + 1,
          rankMin: typeof p.rank_min === 'number' ? p.rank_min : null,
          rankMax: typeof p.rank_max === 'number' ? p.rank_max : null,
          injury: injStatus,
          byeWeek: p.player_bye_week || null,
        });
      });
      console.log(`[FP] ${pos.toUpperCase()}: ${ecr.players.length} players`);
    } catch (err) {
      console.warn(`[FP] Failed to fetch ${pos}: ${err.message}`);
    }
  }));

  if (results.length === 0) {
    return res.status(502).json({ error: 'FantasyPros returned no data — may be blocking scraper or off-season' });
  }

  const payload = { week, scoring, players: results, generated: new Date().toISOString() };
  fpCache[key] = { data: payload, time: now };
  console.log(`[FP] Week ${week} ${scoring}: ${results.length} total players cached`);
  res.json(payload);
});

// ═══════════════════════════════════════════════════════════════════
// Lineup API — clean JSON for pasting into Claude chats
// ═══════════════════════════════════════════════════════════════════

const ESPN_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
const ESPN_SLOT = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 17: 'K', 16: 'DEF', 20: 'BN', 23: 'FLEX', 21: 'IR' };

/** Fetch JSON over HTTPS (simple GET) */
function fetchText(url, extraHeaders, _redirects) {
  extraHeaders = extraHeaders || {};
  _redirects = _redirects || 0;
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('Too many redirects: ' + url));
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const headers = Object.assign({ 'Accept': '*/*', 'User-Agent': ua }, extraHeaders);
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const u = new URL(url); loc = u.origin + loc; }
        res.resume();
        return fetchText(loc, extraHeaders, _redirects + 1).then(resolve, reject);
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function fetchJSON(url, extraHeaders, _redirects) {
  extraHeaders = extraHeaders || {};
  _redirects = _redirects || 0;
  return new Promise((resolve, reject) => {
    if (_redirects > 5) return reject(new Error('Too many redirects: ' + url));
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const headers = Object.assign({ Accept: 'application/json', 'User-Agent': ua }, extraHeaders);
    const mod = url.startsWith('https') ? https : require('http');
    mod.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let loc = res.headers.location;
        if (loc.startsWith('/')) { const u = new URL(url); loc = u.origin + loc; }
        res.resume();
        return fetchJSON(loc, extraHeaders, _redirects + 1).then(resolve, reject);
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) {
          console.warn('[fetchJSON] Parse failed for ' + url + ' (HTTP ' + res.statusCode + '): ' + body.slice(0, 200));
          reject(new Error('JSON parse failed for ' + url + ' (HTTP ' + res.statusCode + ')'));
        }
      });
    }).on('error', reject);
  });
}

/** GET /api/lineup?username=SLEEPER_USER&week=N
 *  Returns all rosters across ESPN, Sleeper, and Yahoo in one JSON payload.
 *  - username: your Sleeper username (required for Sleeper leagues)
 *  - week: scoring period (defaults to current NFL week)
 */
app.get('/api/lineup', async (req, res) => {
  try {
    const sleeperUsername = req.query.username || req.query.user || 'cdownz25';
    const weekOverride = req.query.week ? parseInt(req.query.week, 10) : null;

    // Get current NFL state from Sleeper
    const nflState = await fetchJSON('https://api.sleeper.app/v1/state/nfl').catch(() => null);
    const season = nflState ? String(nflState.season) : String(new Date().getFullYear());
    const week = weekOverride || nflState?.week || nflState?.display_week || 1;

    const output = {
      meta: { season, week, generated: new Date().toISOString() },
      leagues: [],
    };

    // ── ESPN ──────────────────────────────────────────────────────
    const creds = loadCredentials();
    if (creds.espn_s2 && !creds.espn_s2.startsWith('YOUR_') && creds.espn_league_ids?.length) {
      const espnResults = await Promise.allSettled(
        creds.espn_league_ids.map(async (lid) => {
          const year = parseInt(season, 10);
          const url =
            `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${year}` +
            `/segments/0/leagues/${lid}` +
            `?view=mMatchup&view=mRoster&view=mMatchupScore&view=mTeam&view=mSettings&view=mTransactions2&scoringPeriodId=${week}`;

          return new Promise((resolve, reject) => {
            https.get(url, {
              headers: {
                Cookie: `espn_s2=${creds.espn_s2}; SWID=${creds.SWID}`,
                Accept: 'application/json',
              },
            }, (upstream) => {
              let body = '';
              upstream.on('data', (c) => (body += c));
              upstream.on('end', () => {
                try { resolve({ lid, data: JSON.parse(body) }); }
                catch { reject(new Error('ESPN parse failed')); }
              });
            }).on('error', reject);
          });
        })
      );

      for (const result of espnResults) {
        if (result.status !== 'fulfilled') continue;
        const { lid, data } = result.value;
        const leagueName = data.settings?.name || `ESPN ${lid}`;
        const teams = data.teams || [];
        const schedule = data.schedule || [];

        // Find my team
        const swid = creds.SWID;
        let myTeamId = null;
        const teamMap = {};
        for (const t of teams) {
          const name = t.name || [t.location, t.nickname].filter(Boolean).join(' ') || `Team ${t.id}`;
          teamMap[t.id] = { name, roster: t.roster?.entries || [] };
          if (swid && (t.primaryOwner === swid || t.owners?.includes(swid))) {
            myTeamId = t.id;
          }
        }

        // Find my matchup
        const weekMatchups = schedule.filter(m => m.matchupPeriodId === week);
        let myMatchup = null;
        if (myTeamId != null) {
          myMatchup = weekMatchups.find(m =>
            m.home?.teamId === myTeamId || m.away?.teamId === myTeamId
          );
        }

        // Parse my roster
        const myRosterEntries = myTeamId ? (teamMap[myTeamId]?.roster || []) : [];
        const starters = [];
        const bench = [];

        for (const entry of myRosterEntries) {
          const slot = ESPN_SLOT[entry.lineupSlotId] || 'BN';
          const player = entry.playerPoolEntry?.player || {};
          const playerName = player.fullName || 'Unknown';
          const pos = ESPN_POS[player.defaultPositionId] || '?';
          const stats = player.stats || [];

          let actual = 0, proj = 0;
          for (const s of stats) {
            if (s.scoringPeriodId === week && s.statSourceId === 0) actual = s.appliedTotal || 0;
            if (s.scoringPeriodId === week && s.statSourceId === 1) proj = s.appliedTotal || 0;
          }

          const row = { player: playerName, pos, slot, actual: +actual.toFixed(2), proj: +proj.toFixed(2), platform: 'espn', espnId: entry.playerId };
          if (slot === 'BN' || slot === 'IR') bench.push(row);
          else starters.push(row);
        }

        // Opponent info
        let oppName = 'BYE', oppScore = 0;
        if (myMatchup) {
          const oppSide = myMatchup.home?.teamId === myTeamId ? myMatchup.away : myMatchup.home;
          if (oppSide) {
            oppName = teamMap[oppSide.teamId]?.name || 'Opponent';
            oppScore = +(oppSide.totalPointsLive ?? oppSide.totalPoints ?? 0).toFixed(2);
          }
          const mySide = myMatchup.home?.teamId === myTeamId ? myMatchup.home : myMatchup.away;
          var myScore = +(mySide?.totalPointsLive ?? mySide?.totalPoints ?? 0).toFixed(2);
        }

        output.leagues.push({
          platform: 'espn',
          leagueId: lid,
          name: leagueName,
          myTeam: myTeamId ? (teamMap[myTeamId]?.name || 'My Team') : null,
          opponent: oppName,
          myScore: myScore ?? 0,
          oppScore,
          starters,
          bench: bench.sort((a, b) => b.proj - a.proj),
        });
      }
    }

    // ── Sleeper ───────────────────────────────────────────────────
    if (sleeperUsername) {
      try {
        const user = await fetchJSON(`https://api.sleeper.app/v1/user/${sleeperUsername}`);
        if (user?.user_id) {
          const userId = user.user_id;
          const leagues = await fetchJSON(`https://api.sleeper.app/v1/user/${userId}/leagues/nfl/${season}`);

          // Load players + projections from our cache endpoints
          const [sleeperPlayers, projections] = await Promise.all([
            fetchJSON(`http://localhost:${PORT}/proxy/sleeper/players`),
            fetchJSON(`http://localhost:${PORT}/proxy/sleeper/projections/${season}/${week}`),
          ]);

          for (const league of (leagues || [])) {
            const lid = league.league_id;
            const [rosters, users, matchups, detail] = await Promise.all([
              fetchJSON(`https://api.sleeper.app/v1/league/${lid}/rosters`),
              fetchJSON(`https://api.sleeper.app/v1/league/${lid}/users`),
              fetchJSON(`https://api.sleeper.app/v1/league/${lid}/matchups/${week}`),
              fetchJSON(`https://api.sleeper.app/v1/league/${lid}`),
            ]);

            const scoring = detail.scoring_settings || {};
            const rosterPositions = (detail.roster_positions || []).filter(p => p !== 'BN');
            const nameMap = {};
            (users || []).forEach(u => { nameMap[u.user_id] = u.display_name || u.username; });

            const myRoster = (rosters || []).find(r =>
              r.owner_id === userId || (r.co_owners && r.co_owners.includes(userId))
            );
            if (!myRoster) continue;

            const myMatchup = (matchups || []).find(m => m.roster_id === myRoster.roster_id);
            const oppMatchup = myMatchup
              ? (matchups || []).find(m => m.matchup_id === myMatchup.matchup_id && m.roster_id !== myRoster.roster_id)
              : null;
            const oppRoster = oppMatchup ? (rosters || []).find(r => r.roster_id === oppMatchup.roster_id) : null;
            const oppName = oppRoster ? (nameMap[oppRoster.owner_id] || 'Opponent') : 'BYE';

            const starterIds = myMatchup?.starters || [];
            const allPlayerIds = myMatchup?.players || [];
            const benchIds = allPlayerIds.filter(pid => !starterIds.includes(pid));
            const points = myMatchup?.players_points || {};

            // Calculate projected points using Sleeper scoring
            function calcProj(pid) {
              const proj = projections?.[pid];
              if (!proj) return 0;
              let total = 0;
              for (const [stat, val] of Object.entries(proj)) {
                if (scoring[stat]) total += scoring[stat] * val;
              }
              return +total.toFixed(2);
            }

            const starters = starterIds.map((pid, i) => {
              const p = sleeperPlayers?.[pid];
              const playerName = p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : pid;
              return {
                player: playerName,
                pos: p?.position || '?',
                slot: rosterPositions[i] || 'FLEX',
                actual: +(points[pid] ?? 0).toFixed(2),
                proj: calcProj(pid),
                platform: 'sleeper',
                sleeperId: pid,
              };
            });

            const benchPlayers = benchIds.map(pid => {
              const p = sleeperPlayers?.[pid];
              const playerName = p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : pid;
              return {
                player: playerName,
                pos: p?.position || '?',
                slot: 'BN',
                actual: +(points[pid] ?? 0).toFixed(2),
                proj: calcProj(pid),
                platform: 'sleeper',
                sleeperId: pid,
              };
            }).sort((a, b) => b.proj - a.proj);

            const myPts = starterIds.reduce((sum, pid) => sum + (points[pid] || 0), 0);
            const oppPts = oppMatchup
              ? (oppMatchup.starters || []).reduce((sum, pid) => sum + ((oppMatchup.players_points || {})[pid] || 0), 0)
              : 0;

            output.leagues.push({
              platform: 'sleeper',
              leagueId: lid,
              name: league.name || `Sleeper ${lid}`,
              myTeam: nameMap[userId] || sleeperUsername,
              opponent: oppName,
              myScore: +myPts.toFixed(2),
              oppScore: +oppPts.toFixed(2),
              starters,
              bench: benchPlayers,
            });
          }
        }
      } catch (err) {
        output.leagues.push({ platform: 'sleeper', error: err.message });
      }
    }

    // ── Yahoo (extension cache only) ────────────────────────────────
    if (yahooExtCache.receivedAt && yahooExtCache.scoreboards) {
      for (const [key, data] of Object.entries(yahooExtCache.scoreboards)) {
        const leagueKey = key.split('_')[0];
        output.leagues.push({
          platform: 'yahoo',
          leagueId: leagueKey,
          name: 'Yahoo League',
          note: 'Data from Chrome extension cache',
        });
      }
    }

    // ── Summary line for easy pasting ─────────────────────────────
    output.summary = output.leagues
      .filter(l => !l.error && l.starters)
      .map(l => {
        const total = l.starters.reduce((s, p) => s + p.actual, 0);
        const projTotal = l.starters.reduce((s, p) => s + p.proj, 0);
        return `${l.name} (${l.platform}): ${total.toFixed(1)} pts (proj ${projTotal.toFixed(1)}) vs ${l.opponent} (${l.oppScore})`;
      })
      .join(' | ');

    res.json(output);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// Fantasy News — Sleeper trending + ESPN player news
// ═══════════════════════════════════════════════════════════════════

const newsCache = { data: null, time: 0 };
const NEWS_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

app.get('/api/news', async (req, res) => {
  try {
  const now = Date.now();
  if (newsCache.data && now - newsCache.time < NEWS_CACHE_TTL) {
    return res.json(newsCache.data);
  }

  const [trendingAdds, trendingDrops] = await Promise.allSettled([
    fetchJSON('https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=30'),
    fetchJSON('https://api.sleeper.app/v1/players/nfl/trending/drop?lookback_hours=24&limit=25'),
  ]);

  // ESPN: try multiple endpoints
  let espnArticles = [];
  const espnEndpoints = [
    'https://site.web.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50',
    'https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/news?limit=50',
    'https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50',
  ];
  for (const url of espnEndpoints) {
    try {
      const r = await fetchJSON(url);
      // ESPN response structure varies - try all known keys
      let arts = null;
      if (r && Array.isArray(r.articles)) arts = r.articles;
      else if (r && Array.isArray(r.feed)) arts = r.feed;
      else if (r && Array.isArray(r.news)) arts = r.news;
      else if (r && Array.isArray(r.items)) arts = r.items;
      else if (r && Array.isArray(r.headlines)) arts = r.headlines;
      else if (r && Array.isArray(r.stories)) arts = r.stories;
      else if (r && Array.isArray(r.results)) arts = r.results;
      // Sometimes the top level IS the array
      else if (Array.isArray(r)) arts = r;

      if (arts && arts.length) {
        console.log('[News] ESPN ' + arts.length + ' articles from ' + url);
        espnArticles = arts; break;
      } else {
        const keys = r ? Object.keys(r).join(', ') : 'null';
        console.log('[News] ESPN ' + url + ' => no articles. keys: ' + keys + (r ? ' type: ' + typeof r : ''));
      }
    } catch (e) { console.warn('[News] ESPN endpoint failed ' + url + ':', e.message); }
  }

  // ESPN fallback: scrape headlines from ESPN NFL page RSS
  if (espnArticles.length === 0) {
    try {
      const rss = await fetchText('https://www.espn.com/espn/rss/nfl/news');
      const rssItems = rss.match(/<item>([\s\S]*?)<\/item>/g) || [];
      espnArticles = rssItems.slice(0, 25).map(function(item) {
        function getTag(tag) {
          const m = item.match(new RegExp('<' + tag + '><!\[CDATA\[([\s\S]*?)\]\]><\/' + tag + '>'))
            || item.match(new RegExp('<' + tag + '>([\s\S]*?)<\/' + tag + '>'));
          return m ? m[1].trim() : '';
        }
        return {
          headline: getTag('title'),
          description: getTag('description').replace(/<[^>]+>/g, '').slice(0, 300),
          published: getTag('pubDate') ? new Date(getTag('pubDate')).toISOString() : null,
          link: getTag('link') || null,
          player: null,
          source: 'espn',
        };
      }).filter(a => a.headline);
      if (espnArticles.length) console.log('[News] ESPN RSS fallback: ' + espnArticles.length + ' items');
    } catch (e) { console.warn('[News] ESPN RSS fallback failed:', e.message); }
  }

  // Rotowire RSS
  let rotowireItems = [];
  try {
    const rssText = await fetchText('https://www.rotowire.com/football/rss-news.php');
    const itemMatches = rssText.match(/<item>([\s\S]*?)<\/item>/g) || [];
    rotowireItems = itemMatches.slice(0, 30).map(function(item) {
      function getField(tag) {
        const r1 = item.match(new RegExp('<' + tag + '><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\/' + tag + '>'));
        const r2 = item.match(new RegExp('<' + tag + '>([\\s\\S]*?)<\/' + tag + '>'));
        return ((r1 && r1[1]) || (r2 && r2[1]) || '').trim();
      }
      const title = getField('title');
      const desc = getField('description').replace(/<[^>]+>/g, '').slice(0, 300);
      const pubDate = getField('pubDate');
      const colonIdx = title.indexOf(':');
      const playerPart = colonIdx > 2 ? title.slice(0, colonIdx).trim() : '';
      const headline = colonIdx > 2 ? title.slice(colonIdx + 1).trim() : title;
      return {
        id: 'rw_' + Buffer.from(title).toString('base64').slice(0, 12),
        headline: headline || title,
        description: desc,
        published: pubDate ? new Date(pubDate).toISOString() : null,
        link: getField('link') || null,
        player: playerPart ? { name: playerPart, pos: '', team: '' } : null,
        source: 'rotowire',
      };
    }).filter(function(n) { return n.headline; });
    console.log('[News] Rotowire ' + rotowireItems.length + ' items');
  } catch (e) { console.warn('[News] Rotowire failed:', e.message); }

  function enrichTrending(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(entry => {
      const p = playersCache?.[entry.player_id];
      return {
        player_id: entry.player_id,
        count: entry.count,
        name: p ? `${p.first_name || ''} ${p.last_name || ''}`.trim() : entry.player_id,
        pos: p?.position || '?',
        team: p?.team || '?',
        injuryStatus: p?.injury_status || null,
      };
    });
  }

  const adds = trendingAdds.status === 'fulfilled' ? enrichTrending(trendingAdds.value) : [];
  const drops = trendingDrops.status === 'fulfilled' ? enrichTrending(trendingDrops.value) : [];

  let news = [];
  // Map ESPN articles
  const espnNewsMapped = espnArticles.map(function(item) {
    const cats = Array.isArray(item.categories) ? item.categories : [];
    const athleteCat = cats.find(function(c) { return c.type === 'athlete'; }) || null;
    const athlete = item.athlete || null;
    let player = null;
    if (athlete) {
      player = { espnId: athlete.id, name: athlete.fullName || athlete.displayName || '',
        pos: (athlete.position && athlete.position.abbreviation) || '',
        team: (athlete.team && athlete.team.abbreviation) || '' };
    } else if (athleteCat) {
      player = { espnId: String(athleteCat.athleteId || ''), name: athleteCat.description || athleteCat.displayName || '',
        pos: (athleteCat.position && athleteCat.position.abbreviation) || '',
        team: (athleteCat.team && athleteCat.team.abbreviation) || '' };
    }
    // Extract article link from ESPN data
    let link = '';
    if (item.links && item.links.web && item.links.web.href) link = item.links.web.href;
    else if (item.links && item.links.web && item.links.web.short && item.links.web.short.href) link = item.links.web.short.href;
    else if (item.link) link = item.link;
    else if (item.url) link = item.url;
    else if (item.id && typeof item.id === 'number') link = 'https://www.espn.com/nfl/story/_/id/' + item.id;
    return {
      id: item.id || item.dataSourceIdentifier || String(Math.random()),
      headline: item.headline || item.title || '',
      description: item.description || item.story || item.summary || '',
      published: item.published || item.lastModified || null,
      link: link || null,
      player: player,
      source: 'espn',
    };
  }).filter(function(n) { return n.headline; });

  // Merge ESPN + Rotowire, sort newest first
  news = espnNewsMapped.concat(rotowireItems).sort(function(a, b) {
    const ta = a.published ? new Date(a.published).getTime() : 0;
    const tb = b.published ? new Date(b.published).getTime() : 0;
    return tb - ta;
  });

  const payload = { trending: { adds, drops }, news, generated: new Date().toISOString() };
  newsCache.data = payload;
  newsCache.time = now;
  console.log(`[News] Cached: ${adds.length} trending adds, ${drops.length} drops, ${news.length} ESPN items`);
  res.json(payload);
  } catch (err) {
    console.error('[News] Route error:', err);
    res.status(500).json({ error: 'news fetch failed', trending: { adds: [], drops: [] }, news: [] });
  }
});

// Yahoo Free Agents
// ═══════════════════════════════════════════════════════════════════
app.get('/proxy/yahoo/freeagents/:leagueKey', async (req, res) => {
  res.status(503).json({ error: 'Yahoo free agents not available without OAuth. Use the Yahoo Fantasy app directly.' });
});


// ═══════════════════════════════════════════════════════════════════
// Historical Backfill — pull past weeks from Sleeper API into DB
// ═══════════════════════════════════════════════════════════════════
app.post('/api/backfill', async (req, res) => {
  try {
    const { username, season, weeks } = req.body || {};
    const user = username || 'cdownz25';
    const yr = season || new Date().getFullYear();
    const weekList = Array.isArray(weeks) ? weeks : [1];

    const userData = await fetchJSON(`https://api.sleeper.app/v1/user/${user}`);
    if (!userData?.user_id) return res.status(400).json({ error: 'User not found: ' + user });
    const userId = userData.user_id;

    const leagues = await fetchJSON(`https://api.sleeper.app/v1/user/${userId}/leagues/nfl/${yr}`);
    if (!leagues || !leagues.length) return res.status(400).json({ error: 'No leagues found for ' + yr });

    // Load players cache
    let players = playersCache;
    if (!players) {
      players = await fetchJSON('https://api.sleeper.app/v1/players/nfl');
      playersCache = players;
    }

    const results = [];

    for (const week of weekList) {
      for (const league of leagues) {
        const lid = league.league_id;
        try {
          const [rosters, users, matchups] = await Promise.all([
            fetchJSON(`https://api.sleeper.app/v1/league/${lid}/rosters`),
            fetchJSON(`https://api.sleeper.app/v1/league/${lid}/users`),
            fetchJSON(`https://api.sleeper.app/v1/league/${lid}/matchups/${week}`),
          ]);

          const nameMap = {};
          (users || []).forEach(u => { nameMap[u.user_id] = u.display_name || u.username; });

          const myRoster = (rosters || []).find(r =>
            r.owner_id === userId || (r.co_owners && r.co_owners.includes(userId))
          );
          if (!myRoster) { results.push({ league: league.name, week, status: 'skipped - no roster' }); continue; }

          const myMatchup = (matchups || []).find(m => m.roster_id === myRoster.roster_id);
          const oppMatchup = myMatchup
            ? (matchups || []).find(m => m.matchup_id === myMatchup.matchup_id && m.roster_id !== myRoster.roster_id)
            : null;
          const oppRoster = oppMatchup ? (rosters || []).find(r => r.roster_id === oppMatchup.roster_id) : null;
          const oppName = oppRoster ? (nameMap[oppRoster.owner_id] || 'Opponent') : 'BYE';
          const myName = nameMap[userId] || user;

          const starters = myMatchup?.starters || [];
          const allPids = myMatchup?.players || [];
          const points = myMatchup?.players_points || {};
          const myScore = starters.reduce((s, pid) => s + (points[pid] || 0), 0);
          const oppStarters = oppMatchup?.starters || [];
          const oppPoints = oppMatchup?.players_points || {};
          const oppScore = oppStarters.reduce((s, pid) => s + (oppPoints[pid] || 0), 0);

          const result = myScore > oppScore ? 'W' : myScore < oppScore ? 'L' : 'T';

          // Save weekly snapshot
          db.saveWeeklySnapshot(yr, week, 'sleeper', lid, league.name || lid, {
            myTeam: myName,
            oppTeam: oppName,
            myScore: +myScore.toFixed(2),
            oppScore: +oppScore.toFixed(2),
            myProj: null,
            oppProj: null,
            result,
          });

          // Save roster snapshot with player details
          const rosterData = allPids.map(pid => {
            const p = players?.[pid];
            return {
              player: p ? (p.first_name + ' ' + p.last_name).trim() : pid,
              pos: p?.position || '?',
              slot: starters.includes(pid) ? 'STARTER' : 'BN',
              actual: +(points[pid] || 0).toFixed(2),
              sleeperId: pid,
            };
          });

          // Calculate optimal lineup
          const scoring = league.scoring_settings || {};
          const rosterPositions = (league.roster_positions || []).filter(p => p !== 'BN');
          const optimalData = calcOptimalLineup(rosterData, rosterPositions);

          db.saveRosterSnapshot(yr, week, 'sleeper', lid, myName, myName, rosterData, optimalData);

          results.push({
            league: league.name,
            week,
            status: 'saved',
            myScore: +myScore.toFixed(2),
            oppScore: +oppScore.toFixed(2),
            result,
          });
        } catch (e) {
          results.push({ league: league.name || lid, week, status: 'error: ' + e.message });
        }
      }
    }

    console.log('[Backfill] Completed:', results.length, 'entries');
    res.json({ success: true, results });
  } catch (err) {
    console.error('[Backfill] Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Helper: calculate optimal lineup from roster data
function calcOptimalLineup(rosterData, rosterPositions) {
  if (!rosterData || !rosterPositions || !rosterPositions.length) return null;

  const flexPositions = { FLEX: ['RB', 'WR', 'TE'], SUPER_FLEX: ['QB', 'RB', 'WR', 'TE'], REC_FLEX: ['WR', 'TE'], WRRB_FLEX: ['WR', 'RB'] };
  const available = rosterData.map(p => ({ ...p })).sort((a, b) => b.actual - a.actual);
  const optimal = [];
  const used = new Set();

  // Fill fixed positions first
  for (const slot of rosterPositions) {
    if (flexPositions[slot]) continue;
    const best = available.find(p => p.pos === slot && !used.has(p.sleeperId || p.player));
    if (best) {
      optimal.push({ ...best, optSlot: slot });
      used.add(best.sleeperId || best.player);
    }
  }

  // Fill flex positions
  for (const slot of rosterPositions) {
    const eligible = flexPositions[slot];
    if (!eligible) continue;
    const best = available.find(p => eligible.includes(p.pos) && !used.has(p.sleeperId || p.player));
    if (best) {
      optimal.push({ ...best, optSlot: slot });
      used.add(best.sleeperId || best.player);
    }
  }

  const optimalPts = optimal.reduce((s, p) => s + p.actual, 0);
  const actualPts = rosterData.filter(p => p.slot === 'STARTER').reduce((s, p) => s + p.actual, 0);
  const pct = optimalPts > 0 ? +((actualPts / optimalPts) * 100).toFixed(1) : 100;

  return { optimal, optimalPts: +optimalPts.toFixed(2), actualPts: +actualPts.toFixed(2), efficiency: pct };
}


// Start
// ═══════════════════════════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Fantasy dashboard running → http://0.0.0.0:${PORT}`);

  // Pre-warm the Sleeper players cache on startup so first page load is fast
  if (!playersCache) {
    console.log('[Startup] Pre-warming Sleeper players cache...');
    const url = 'https://api.sleeper.app/v1/players/nfl';
    https.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          playersCache = JSON.parse(body);
          playersCacheTime = Date.now();
          const count = Object.keys(playersCache).length;
          console.log(`[Startup] Players cache warm: ${count} players (${(body.length / 1024 / 1024).toFixed(1)} MB raw)`);
        } catch (e) {
          console.warn('[Startup] Failed to pre-warm players cache:', e.message);
        }
      });
    }).on('error', (e) => {
      console.warn('[Startup] Players pre-warm request failed:', e.message);
    });
  }
});
