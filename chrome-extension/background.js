/**
 * FF Dashboard – Yahoo Bridge background service worker
 * Receives Yahoo data from content.js and relays it to the local dashboard server.
 * Background workers can make cross-origin requests without CORS restrictions
 * as long as the target host is listed in host_permissions.
 */

const DASHBOARD_ENDPOINT = 'http://localhost:3001/proxy/yahoo/extension';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'FF_YAHOO_SYNC') return false;

  fetch(DASHBOARD_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msg.payload),
  })
    .then(async (res) => {
      const data = await res.json().catch(() => ({}));
      sendResponse({ ok: res.ok, data });
    })
    .catch((err) => {
      console.warn('[FF Bridge BG] POST to dashboard failed:', err.message);
      sendResponse({ ok: false, error: err.message });
    });

  return true; // keep channel open for async sendResponse
});

// ── Periodic re-sync via alarms ───────────────────────────────────────────────
// Every 10 minutes: if a Yahoo Fantasy tab is open, re-inject content.js
chrome.alarms.create('ff-yahoo-periodic', { periodInMinutes: 10 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'ff-yahoo-periodic') return;
  try {
    const tabs = await chrome.tabs.query({ url: '*://football.fantasysports.yahoo.com/*' });
    for (const tab of tabs) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js'],
        world: 'MAIN',
      }).catch(() => {}); // ignore tabs that have become inaccessible
    }
  } catch (e) {
    // No Yahoo Fantasy tabs open — that's fine
  }
});
