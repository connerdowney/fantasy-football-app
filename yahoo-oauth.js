const https = require('https');
const fs = require('fs');
const path = require('path');
const querystring = require('querystring');

const CREDS_PATH = path.join(__dirname, 'credentials.json');
const YAHOO_API_BASE = 'https://fantasysports.yahooapis.com/fantasy/v2';

function loadCredentials() {
  return JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
}

function saveCredentials(creds) {
  fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2) + '\n');
}

function getAuthURL() {
  const creds = loadCredentials();
  return 'https://api.login.yahoo.com/oauth2/request_auth?' + querystring.stringify({
    client_id: creds.yahoo_client_id,
    redirect_uri: creds.yahoo_redirect_uri,
    response_type: 'code',
    scope: 'fspt-r',
    language: 'en-us',
  });
}

function httpsRequest(url, options, postData) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch { resolve({ status: res.statusCode, data: body }); }
      });
    });
    req.on('error', reject);
    if (postData) req.write(postData);
    req.end();
  });
}

async function exchangeCode(code) {
  const creds = loadCredentials();
  const postData = querystring.stringify({
    grant_type: 'authorization_code',
    redirect_uri: creds.yahoo_redirect_uri,
    code,
  });
  const auth = Buffer.from(`${creds.yahoo_client_id}:${creds.yahoo_client_secret}`).toString('base64');
  const { status, data } = await httpsRequest('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
  }, postData);

  if (status !== 200 || !data.access_token) {
    throw new Error(`Token exchange failed (${status}): ${JSON.stringify(data)}`);
  }

  creds.yahoo_access_token = data.access_token;
  creds.yahoo_refresh_token = data.refresh_token;
  creds.yahoo_token_expiry = Date.now() + (data.expires_in * 1000) - 60000;
  creds.yahoo_guid = data.xoauth_yahoo_guid;
  saveCredentials(creds);
  console.log('[Yahoo OAuth] Tokens saved. GUID:', data.xoauth_yahoo_guid);
  return data;
}

async function refreshTokens() {
  const creds = loadCredentials();
  if (!creds.yahoo_refresh_token) throw new Error('No refresh token stored');

  const postData = querystring.stringify({
    grant_type: 'refresh_token',
    redirect_uri: creds.yahoo_redirect_uri,
    refresh_token: creds.yahoo_refresh_token,
  });
  const auth = Buffer.from(`${creds.yahoo_client_id}:${creds.yahoo_client_secret}`).toString('base64');
  const { status, data } = await httpsRequest('https://api.login.yahoo.com/oauth2/get_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`,
    },
  }, postData);

  if (status !== 200 || !data.access_token) {
    throw new Error(`Token refresh failed (${status}): ${JSON.stringify(data)}`);
  }

  creds.yahoo_access_token = data.access_token;
  creds.yahoo_refresh_token = data.refresh_token;
  creds.yahoo_token_expiry = Date.now() + (data.expires_in * 1000) - 60000;
  saveCredentials(creds);
  console.log('[Yahoo OAuth] Tokens refreshed, expires in', data.expires_in, 's');
  return data;
}

async function getAccessToken() {
  const creds = loadCredentials();
  if (!creds.yahoo_access_token) return null;
  if (Date.now() >= (creds.yahoo_token_expiry || 0)) {
    try {
      await refreshTokens();
      return loadCredentials().yahoo_access_token;
    } catch (e) {
      console.error('[Yahoo OAuth] Refresh failed:', e.message);
      return null;
    }
  }
  return creds.yahoo_access_token;
}

async function yahooAPI(endpoint, format = 'json') {
  const token = await getAccessToken();
  if (!token) throw new Error('Yahoo OAuth not configured');

  const sep = endpoint.includes('?') ? '&' : '?';
  const url = `${YAHOO_API_BASE}${endpoint}${sep}format=json`;

  const { status, data } = await httpsRequest(url, {
    method: 'GET',
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (status === 401) {
    console.log('[Yahoo API] 401, attempting token refresh...');
    await refreshTokens();
    const newToken = loadCredentials().yahoo_access_token;
    const retry = await httpsRequest(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${newToken}` },
    });
    if (retry.status !== 200) throw new Error(`Yahoo API ${retry.status}: ${JSON.stringify(retry.data)}`);
    return retry.data;
  }

  if (status !== 200) throw new Error(`Yahoo API ${status}: ${JSON.stringify(data)}`);
  return data;
}

function isConfigured() {
  const creds = loadCredentials();
  return !!(creds.yahoo_access_token && creds.yahoo_refresh_token);
}

let refreshTimer = null;

function startAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    try {
      const creds = loadCredentials();
      if (creds.yahoo_token_expiry && Date.now() > creds.yahoo_token_expiry - 120000) {
        await refreshTokens();
      }
    } catch (e) {
      console.error('[Yahoo OAuth] Auto-refresh failed:', e.message);
    }
  }, 5 * 60 * 1000);
}

module.exports = {
  getAuthURL,
  exchangeCode,
  refreshTokens,
  getAccessToken,
  yahooAPI,
  isConfigured,
  startAutoRefresh,
};
