#!/usr/bin/env node
const readline = require('readline');
const yahoo = require('./yahoo-oauth');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

console.log('\n=== Yahoo Fantasy OAuth Setup ===\n');
console.log('1. Open this URL in your browser:\n');
console.log('   ' + yahoo.getAuthURL());
console.log('\n2. Log in and authorize the app.');
console.log('3. You\'ll be redirected to a page that may not load.');
console.log('   Copy the "code" parameter from the URL bar.\n');
console.log('   Example: https://localhost:3002?code=THIS_PART_HERE\n');

rl.question('Paste the authorization code: ', async (code) => {
  try {
    const tokens = await yahoo.exchangeCode(code.trim());
    console.log('\nSuccess! Yahoo OAuth is now configured.');
    console.log('Access token expires in', tokens.expires_in, 'seconds.');
    console.log('Refresh token stored — will auto-renew on server.\n');

    // Quick test
    console.log('Testing API access...');
    const data = await yahoo.yahooAPI('/users;use_login=1/games;game_keys=nfl/leagues');
    const leagues = data?.fantasy_content?.users?.[0]?.user?.[1]?.games?.[0]?.game?.[1]?.leagues;
    if (leagues) {
      const count = leagues.count || Object.keys(leagues).filter(k => k !== 'count').length;
      console.log(`Found ${count} Yahoo Fantasy league(s). You're all set!\n`);
    } else {
      console.log('API responded but no leagues found (may be offseason).\n');
    }
  } catch (e) {
    console.error('\nError:', e.message);
  }
  rl.close();
});
