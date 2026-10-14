#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Yahoo Fantasy OAuth2 — one-time authorization
//
// Usage:  node scripts/yahoo-auth.js
//
// 1. Generates a self-signed cert for the HTTPS callback
// 2. Prints the Yahoo login URL — open it in a browser
// 3. Spins up a temp HTTPS server on :3002 to catch the redirect
// 4. Exchanges the auth code for tokens
// 5. Saves access_token, refresh_token, token_expiry to credentials.json
// ═══════════════════════════════════════════════════════════════════

const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execSync } = require('child_process');

const REDIRECT_URI = 'https://localhost:3002';
const SCOPE = 'fspt-w';

const CREDS_PATH = path.join(__dirname, '..', 'credentials.json');
const CERT_DIR = path.join(__dirname, '..', '.certs');

let existingCreds = {};
try {
  existingCreds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
} catch { /* first run */ }

const CLIENT_ID = process.env.YAHOO_CLIENT_ID || existingCreds.yahoo_client_id;
const CLIENT_SECRET = process.env.YAHOO_CLIENT_SECRET || existingCreds.yahoo_client_secret;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    'Missing Yahoo client credentials.\n' +
    'Set YAHOO_CLIENT_ID and YAHOO_CLIENT_SECRET env vars, or add\n' +
    '"yahoo_client_id" / "yahoo_client_secret" to credentials.json first.'
  );
  process.exit(1);
}

// ── Generate self-signed cert ───────────────────────────────────────
function ensureCerts() {
  if (!fs.existsSync(CERT_DIR)) fs.mkdirSync(CERT_DIR, { recursive: true });

  const keyPath = path.join(CERT_DIR, 'key.pem');
  const certPath = path.join(CERT_DIR, 'cert.pem');

  if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
    console.log('Generating self-signed certificate for localhost...\n');
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" ` +
      `-days 365 -nodes -subj "/CN=localhost" 2>/dev/null`
    );
  }

  return {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  };
}

// ── Build auth URL ──────────────────────────────────────────────────
const authUrl =
  `https://api.login.yahoo.com/oauth2/request_auth` +
  `?client_id=${encodeURIComponent(CLIENT_ID)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&response_type=code` +
  `&scope=${encodeURIComponent(SCOPE)}`;

const certs = ensureCerts();

console.log('╔══════════════════════════════════════════════════════╗');
console.log('║  Yahoo Fantasy — One-Time Authorization             ║');
console.log('╚══════════════════════════════════════════════════════╝\n');
console.log('Open this URL in your browser:\n');
console.log(`  ${authUrl}\n`);
console.log('Waiting for redirect on https://localhost:3002 ...');
console.log('(Your browser will warn about the self-signed cert — click "Advanced" then "Proceed")\n');

// ── Temp HTTPS server to catch the redirect ─────────────────────────
const server = https.createServer(certs, async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');

  if (!code) {
    res.writeHead(400, { 'Content-Type': 'text/html' });
    res.end('<h2>Error: no authorization code in redirect.</h2><p>Try again.</p>');
    return;
  }

  console.log('Auth code received. Exchanging for tokens...');

  try {
    const tokens = await exchangeCode(code);

    // Read existing credentials and merge
    let creds = {};
    try {
      creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
    } catch { /* first run */ }

    creds.yahoo_access_token = tokens.access_token;
    creds.yahoo_refresh_token = tokens.refresh_token;
    creds.yahoo_token_expiry = Math.floor(Date.now() / 1000) + tokens.expires_in;
    creds.yahoo_client_id = CLIENT_ID;
    creds.yahoo_client_secret = CLIENT_SECRET;

    fs.writeFileSync(CREDS_PATH, JSON.stringify(creds, null, 2) + '\n');

    console.log('Tokens saved to credentials.json');
    console.log(`  access_token:  ${tokens.access_token.slice(0, 20)}...`);
    console.log(`  refresh_token: ${tokens.refresh_token.slice(0, 20)}...`);
    console.log(`  expires_in:    ${tokens.expires_in}s\n`);

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<h2 style="font-family:system-ui;">Yahoo Fantasy authorized!</h2>' +
      '<p>You can close this tab and return to the terminal.</p>'
    );
  } catch (err) {
    console.error('Token exchange failed:', err.message);
    res.writeHead(500, { 'Content-Type': 'text/html' });
    res.end(`<h2>Token exchange failed</h2><pre>${err.message}</pre>`);
  }

  // Shut down after a short delay so the response flushes
  setTimeout(() => {
    server.close();
    process.exit(0);
  }, 500);
});

server.listen(3002, () => {});

// ── Token exchange ──────────────────────────────────────────────────
function exchangeCode(code) {
  return new Promise((resolve, reject) => {
    const body =
      `grant_type=authorization_code` +
      `&code=${encodeURIComponent(code)}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

    const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');

    const options = {
      hostname: 'api.login.yahoo.com',
      path: '/oauth2/get_token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${basic}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(`${json.error}: ${json.error_description}`));
          else resolve(json);
        } catch {
          reject(new Error(`Unexpected response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}
