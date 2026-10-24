// Pre-flight for a live demo: fills the verified-profile cache and the Bright
// Data source snapshot so nothing on stage waits on a 25-second unlock.
// Usage: npm run prewarm   (with the server already running)
const base = process.env.PATCHWORK_URL || 'http://127.0.0.1:4173';

const bootstrap = await fetch(`${base}/api/bootstrap`).then(response => response.json()).catch(() => null);
if (!bootstrap) {
  console.error(`Could not reach ${base}. Start the server first with: npm start`);
  process.exit(1);
}

console.log(`Graph mode : ${bootstrap.graph.mode}${bootstrap.graph.mode === 'falkordb' ? '' : '   <-- NOT FalkorDB'}`);
console.log(`Bright Data: ${bootstrap.brightDataConfigured ? 'configured' : 'NOT CONFIGURED'}`);
console.log(`Catalog    : ${bootstrap.sessions.length} sessions, ${bootstrap.speakers.length} speakers\n`);

let verified = 0;
let unverified = 0;
for (const speaker of bootstrap.speakers) {
  const started = Date.now();
  try {
    const result = await fetch(`${base}/api/speakers/enrich`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ speakerId: speaker.id })
    }).then(response => response.json());
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.verified) { verified += 1; console.log(`  ok    ${speaker.name.padEnd(24)} ${result.headline?.slice(0, 54) || ''} (${seconds}s${result.cached ? ', cached' : ''})`); }
    else { unverified += 1; console.log(`  --    ${speaker.name.padEnd(24)} not confirmed (${seconds}s)`); }
  } catch (error) {
    unverified += 1;
    console.log(`  fail  ${speaker.name.padEnd(24)} ${error.message}`);
  }
}

console.log(`\n${verified} profiles verified and cached, ${unverified} left unconfirmed.`);
console.log(verified ? 'Cached lookups are instant, so the demo will not wait on LinkedIn.' : 'Nothing cached — check BRIGHTDATA_API_KEY and the unlocker zone.');
