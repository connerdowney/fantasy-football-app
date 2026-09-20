/**
 * FF Dashboard – Yahoo Bridge relay script
 * Runs in ISOLATED world (default) at document_start.
 *
 * Yahoo's page JS overwrites window.chrome, so chrome.runtime and
 * chrome.storage are undefined in the MAIN world content script.
 * This relay listens for window.postMessage from content.js and
 * forwards to the real chrome APIs that are only accessible here.
 */
window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data?.type) return;

  const { type, payload } = event.data;

  // Relay sync payload to background service worker
  if (type === 'FF_YAHOO_SYNC') {
    chrome.runtime.sendMessage({ type, payload }, (response) => {
      const err = chrome.runtime.lastError;
      window.postMessage({
        type: 'FF_YAHOO_SYNC_RESPONSE',
        response: err ? { ok: false, error: err.message } : response,
      }, '*');
    });
  }

  // Relay storage writes (status, errors, last sync time)
  if (type === 'FF_YAHOO_STATUS') {
    chrome.storage.local.set(payload);
  }
});
