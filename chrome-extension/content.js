/**
 * FF Dashboard – Yahoo Bridge content script
 * Runs in MAIN world on football.fantasysports.yahoo.com
 * MAIN world required for implicit HttpOnly cookie sending.
 * chrome.* APIs go through relay.js via window.postMessage (Yahoo overwrites window.chrome).
 */
(async function ffYahooBridge() {
  'use strict';
  const API_BASE = 'https://pub-api-ro.fantasysports.yahoo.com/fantasy/v2';
  const DEBOUNCE_KEY = '__ff_bridge_running__';
  if (window[DEBOUNCE_KEY]) return;
  window[DEBOUNCE_KEY] = true;
  setTimeout(() => { delete window[DEBOUNCE_KEY]; }, 60_000);

  function setStatus(payload) { window.postMessage({ type: 'FF_YAHOO_STATUS', payload }, '*'); }

  async function yFetch(path) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`${API_BASE}${path}${sep}format=json`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Yahoo API ${path}: HTTP ${res.status}`);
    return res;
  }

  try {
    // 1. Auth probe
    const probeRes = await yFetch('/users;use_login=1/games;game_keys=nfl');
    const probeData = await probeRes.json();
    const guid = probeData?.fantasy_content?.users?.['0']?.user?.[0]?.guid;
    if (!guid) { setStatus({ ff_sync_error: 'Not logged in to Yahoo Fantasy' }); return; }

    // 2. Leagues
    const leaguesRes = await yFetch('/users;use_login=1/games;game_keys=nfl/leagues');
    const leaguesText = await leaguesRes.text();
    const leaguesData = JSON.parse(leaguesText);
    const leagueKeys = [];
    let currentWeek = 1;
    try {
      const games = leaguesData.fantasy_content.users['0'].user[1].games;
      const gCount = games.count || 0;
      for (let g = 0; g < gCount; g++) {
        const gameArr = games[String(g)]?.game;
        if (!gameArr) continue;
        if (gameArr[0]?.current_week) currentWeek = parseInt(gameArr[0].current_week, 10);
        const leaguesObj = gameArr[1]?.leagues;
        if (!leaguesObj) continue;
        for (let l = 0; l < (leaguesObj.count || 0); l++) {
          const lk = leaguesObj[String(l)]?.league?.[0]?.league_key;
          if (lk) leagueKeys.push(lk);
        }
      }
    } catch (e) { console.warn('[FF Bridge] League extraction error:', e.message); }

    if (!leagueKeys.length) { setStatus({ ff_sync_error: 'No active Yahoo leagues' }); return; }

    // 3. Scoreboards — omit week param so Yahoo returns authoritative current week
    const scoreboards = {};
    await Promise.allSettled(leagueKeys.map(async (key) => {
      try {
        const sbText = await (await yFetch(`/league/${key}/scoreboard`)).text();
        let sbWeek = currentWeek;
        try { const w = JSON.parse(sbText)?.fantasy_content?.league?.[1]?.scoreboard?.week; if (w) sbWeek = parseInt(w, 10); } catch (_) {}
        scoreboards[`${key}_${sbWeek}`] = sbText;
        if (sbWeek !== currentWeek) currentWeek = sbWeek;
      } catch (e) { console.warn(`[FF Bridge] Scoreboard ${key}:`, e.message); }
    }));

    // 4. Rosters — get all teams per league then fetch each roster
    const rosters = {};
    await Promise.allSettled(leagueKeys.map(async (lKey) => {
      try {
        const teamsData = JSON.parse(await (await yFetch(`/league/${lKey}/teams`)).text());
        const teamsObj = teamsData?.fantasy_content?.league?.[1]?.teams;
        const teamKeys = [];
        for (let t = 0; t < (teamsObj?.count || 0); t++) {
          const tk = teamsObj[String(t)]?.team?.[0]?.[0]?.team_key;
          if (tk) teamKeys.push(tk);
        }
        await Promise.allSettled(teamKeys.map(async (tk) => {
          try { rosters[tk] = await (await yFetch(`/team/${tk}/roster`)).text(); }
          catch (e) { console.warn(`[FF Bridge] Roster ${tk}:`, e.message); }
        }));
      } catch (e) { console.warn(`[FF Bridge] Teams fetch ${lKey}:`, e.message); }
    }));

    // 5. Send everything via relay
    const payload = { leagues: leaguesText, scoreboards, rosters, week: currentWeek, syncedAt: Date.now() };
    const onResponse = (event) => {
      if (event.source !== window || event.data?.type !== 'FF_YAHOO_SYNC_RESPONSE') return;
      window.removeEventListener('message', onResponse);
      const response = event.data.response;
      if (response?.ok) {
        console.log(`[FF Bridge] Synced ${leagueKeys.length} leagues, ${Object.keys(rosters).length} rosters, week ${currentWeek}`);
        setStatus({ ff_last_sync: Date.now(), ff_league_count: leagueKeys.length, ff_sync_error: null });
      } else {
        console.warn('[FF Bridge] Dashboard unreachable:', response?.error);
        setStatus({ ff_sync_error: 'Dashboard offline – is server.js running?' });
      }
    };
    window.addEventListener('message', onResponse);
    window.postMessage({ type: 'FF_YAHOO_SYNC', payload }, '*');

  } catch (err) {
    console.warn('[FF Bridge] Sync error:', err.message);
    setStatus({ ff_sync_error: err.message });
  }
})();