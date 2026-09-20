chrome.storage.local.get(
  ['ff_last_sync', 'ff_sync_error', 'ff_league_count'],
  (data) => {
    const statusEl = document.getElementById('status');
    const hintEl = document.getElementById('hint');

    if (data.ff_sync_error) {
      statusEl.className = 'status err';
      statusEl.textContent = data.ff_sync_error;
      hintEl.textContent = 'Make sure you are logged in to Yahoo Fantasy and the dashboard server is running (pm2 status).';
    } else if (data.ff_last_sync) {
      const mins = Math.round((Date.now() - data.ff_last_sync) / 60_000);
      statusEl.className = 'status ok';
      statusEl.textContent = `✓ Synced ${mins < 1 ? 'just now' : mins + 'm ago'} · ${data.ff_league_count || 0} league(s)`;
      hintEl.textContent = 'Dashboard receives fresh data automatically each time you visit Yahoo Fantasy.';
    } else {
      statusEl.className = 'status idle';
      statusEl.textContent = 'Not synced yet';
      hintEl.textContent = 'Visit football.fantasysports.yahoo.com to trigger the first sync.';
    }
  }
);
