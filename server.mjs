import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
async function loadLocalEnv() {
  for (const fileName of ['.env', 'brightdata.env']) {
    try {
      const localEnv = await readFile(resolve(root, fileName), 'utf8');
      for (const line of localEnv.split(/\r?\n/)) {
        const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (!match || process.env[match[1]]) continue;
        process.env[match[1]] = match[2].replace(/^("|')(.*)\1$/, '$2');
      }
    } catch {}
  }
}
await loadLocalEnv();
const seed = JSON.parse(await readFile(resolve(root, 'data/seed.json'), 'utf8'));
const port = Number(process.env.PORT || 4173);
const graphName = 'conference_companion';
const sqlitePath = resolve(root, 'data/patchwork.sqlite');
const graphState = { mode: 'sqlite-graph', detail: 'Persistent SQLite graph database connected.' };
let graph = null;
let falkorClient = null;
let lastRefresh = null;

function sqlText(value) { return `'${String(value ?? '').replaceAll("'", "''")}'`; }

function sqlite(sql, json = false) {
  const result = spawnSync('sqlite3', [...(json ? ['-json'] : []), sqlitePath], { input: sql, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr.trim() || `sqlite3 exited with status ${result.status}`);
  return json && result.stdout.trim() ? JSON.parse(result.stdout) : result.stdout.trim();
}

function upsertNode(id, label, properties) {
  sqlite(`INSERT INTO graph_nodes(id,label,properties) VALUES(${sqlText(id)},${sqlText(label)},${sqlText(JSON.stringify(properties))}) ON CONFLICT(id) DO UPDATE SET label=excluded.label, properties=json_patch(graph_nodes.properties,excluded.properties);`);
}

function readGraphRecords(label) {
  return sqlite(`SELECT properties FROM graph_nodes WHERE label=${sqlText(label)} ORDER BY id;`, true).map(row => JSON.parse(row.properties));
}

function upsertEdge(from, relation, to) {
  sqlite(`INSERT OR IGNORE INTO graph_edges(from_id,relation,to_id) VALUES(${sqlText(from)},${sqlText(relation)},${sqlText(to)});`);
}

function syncSqliteGraph() {
  sqlite(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS graph_nodes(id TEXT PRIMARY KEY,label TEXT NOT NULL,properties TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS graph_edges(from_id TEXT NOT NULL,relation TEXT NOT NULL,to_id TEXT NOT NULL,PRIMARY KEY(from_id,relation,to_id));
    CREATE TABLE IF NOT EXISTS app_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS graph_edges_relation_from ON graph_edges(relation,from_id);
    CREATE INDEX IF NOT EXISTS graph_edges_relation_to ON graph_edges(relation,to_id);`);
  // Remove profiles written by earlier prototypes before rebuilding the public catalog.
  sqlite(`DELETE FROM graph_edges
    WHERE relation IN ('INTERESTED_IN','MET')
      OR from_id IN (SELECT id FROM graph_nodes WHERE label='Attendee')
      OR to_id IN (SELECT id FROM graph_nodes WHERE label='Attendee');
    DELETE FROM graph_nodes WHERE label='Attendee';`);
  upsertNode('github-universe-2026', 'Event', seed.event);
  upsertNode(seed.source.id, 'Source', seed.source);
  for (const topic of seed.topics) upsertNode(`topic:${topic}`, 'Topic', { name: topic });
  for (const speaker of seed.speakers) upsertNode(speaker.id, 'Speaker', speaker);
  for (const sourceId of new Set(seed.sessions.map(session => session.sourceId || seed.source.id))) {
    const session = seed.sessions.find(item => (item.sourceId || seed.source.id) === sourceId);
    upsertNode(sourceId, 'Source', sourceId === seed.source.id ? seed.source : { id: sourceId, name: 'GitHub Universe schedule launch article', publisher: 'GitHub Blog', url: session.sourceUrl || seed.source.url });
  }
  for (const session of seed.sessions) {
    upsertNode(session.id, 'Session', session);
    upsertEdge('github-universe-2026', 'HAS_SESSION', session.id);
    upsertEdge(session.id, 'SOURCED_FROM', session.sourceId || seed.source.id);
    for (const topic of session.topics) upsertEdge(session.id, 'COVERS', `topic:${topic}`);
    for (const speakerId of session.speakers) upsertEdge(session.id, 'PRESENTS', speakerId);
  }
  sqlite(`INSERT INTO app_metadata(key,value) VALUES('seed_synced_at',${sqlText(new Date().toISOString())}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
  const integrity = sqlite('PRAGMA integrity_check;');
  if (integrity !== 'ok') throw new Error(`SQLite integrity check failed: ${integrity}`);
  const counts = sqlite("SELECT (SELECT count(*) FROM graph_nodes) AS nodes,(SELECT count(*) FROM graph_edges) AS edges;", true)[0];
  graphState.detail = `SQLite graph database verified (integrity_check=ok): ${counts.nodes} nodes and ${counts.edges} relationships persisted at data/patchwork.sqlite.`;
}

syncSqliteGraph();
try {
  const storedRefresh = sqlite("SELECT value FROM app_metadata WHERE key='last_brightdata_refresh';", true)[0]?.value;
  if (storedRefresh) lastRefresh = JSON.parse(storedRefresh);
} catch {}

function sqliteSpeakerPaths(interestTopics, metSpeakerIds) {
  const topicsJson = sqlText(JSON.stringify(interestTopics));
  const metIdsJson = sqlText(JSON.stringify(metSpeakerIds));
  return sqlite(`SELECT p.id AS speakerId,json_extract(p.properties,'$.name') AS speakerName,json_extract(p.properties,'$.organization') AS organization,
      group_concat(DISTINCT json_extract(t.properties,'$.name')) AS reasons,
      group_concat(DISTINCT s.id) AS sessionIds,count(DISTINCT t.id) AS pathCount
    FROM json_each(${topicsJson}) requested
    JOIN graph_nodes t ON t.label='Topic' AND json_extract(t.properties,'$.name')=requested.value
    JOIN graph_edges covers ON covers.to_id=t.id AND covers.relation='COVERS'
    JOIN graph_nodes s ON s.id=covers.from_id AND s.label='Session'
    JOIN graph_edges presents ON presents.from_id=s.id AND presents.relation='PRESENTS'
    JOIN graph_nodes p ON p.id=presents.to_id AND p.label='Speaker'
    WHERE p.id NOT IN (SELECT value FROM json_each(${metIdsJson}))
    GROUP BY p.id ORDER BY pathCount DESC,p.id LIMIT 12;`, true);
}

async function initFalkorDB() {
  if (!process.env.FALKORDB_URL && !process.env.FALKORDB_HOST) return;
  const url = process.env.FALKORDB_URL ? (() => { try { return new URL(process.env.FALKORDB_URL); } catch { return null; } })() : null;
  if (process.env.FALKORDB_URL && !url) {
    graphState.detail = 'FALKORDB_URL is not a valid connection URL; refusing to connect.';
    return;
  }
  const configuredHost = process.env.FALKORDB_HOST || url?.hostname || '';
  const hostname = configuredHost.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  const urlUsesTls = url?.protocol === 'rediss:';
  const tlsEnabled = process.env.FALKORDB_TLS === 'true' || urlUsesTls;
  if (!isLoopback && !tlsEnabled && process.env.FALKORDB_ALLOW_INSECURE !== 'true') {
    graphState.detail = 'Refusing a remote FalkorDB connection without TLS, including FALKORDB_URL connections. Enable TLS or explicitly opt in after reviewing the risk.';
    return;
  }
  try {
    const { FalkorDB } = await import('falkordb');
    const connection = {
      username: process.env.FALKORDB_USERNAME || undefined,
      password: process.env.FALKORDB_PASSWORD || undefined,
      ...(process.env.FALKORDB_HOST
        ? { socket: { host: process.env.FALKORDB_HOST, port: Number(process.env.FALKORDB_PORT || 6379), tls: tlsEnabled, connectTimeout: 10000 } }
        : { url: process.env.FALKORDB_URL, ...(tlsEnabled ? { socket: { tls: true, connectTimeout: 10000 } } : {}) })
    };
    falkorClient = await FalkorDB.connect(connection);
    graph = falkorClient.selectGraph(graphName);
    // Older builds stored attendee profiles and could relabel seeded IDs on collisions.
    await graph.query('MATCH (a:Attendee) DETACH DELETE a');
    await graph.query('MERGE (:Event {id:$id, name:$name, url:$url})', { params: { id: 'github-universe-2026', name: seed.event.name, url: seed.event.url } });
    await graph.query('MERGE (src:Source {id:$id, name:$name, url:$url, publisher:$publisher})', { params: { id: seed.source.id, name: seed.source.name, url: seed.source.url, publisher: seed.source.publisher } });
    for (const topicName of seed.topics) {
      await graph.query('MERGE (:Topic {name:$name})', { params: { name: topicName } });
    }
    for (const speaker of seed.speakers) {
      await graph.query('MERGE (p:Speaker {id:$id}) SET p.name=$name, p.organization=$organization', { params: { id: speaker.id, name: speaker.name, organization: speaker.organization } });
    }
    for (const sourceId of new Set(seed.sessions.map(session => session.sourceId || seed.source.id))) {
      const session = seed.sessions.find(item => (item.sourceId || seed.source.id) === sourceId);
      const source = sourceId === seed.source.id ? seed.source : { id: sourceId, name: 'GitHub Universe schedule launch article', publisher: 'GitHub Blog', url: session.sourceUrl || seed.source.url };
      await graph.query('MERGE (:Source {id:$id, name:$name, url:$url, publisher:$publisher})', { params: { id: source.id, name: source.name, url: source.url, publisher: source.publisher } });
    }
    for (const session of seed.sessions) {
      await graph.query('MERGE (s:Session {id:$id}) SET s.title=$title, s.summary=$summary, s.sourceAnchor=$sourceAnchor', { params: { id: session.id, title: session.title, summary: session.summary, sourceAnchor: session.sourceAnchor } });
      await graph.query('MATCH (e:Event {id:$eventId}), (s:Session {id:$sessionId}), (src:Source {id:$sourceId}) MERGE (e)-[:HAS_SESSION]->(s) MERGE (s)-[:SOURCED_FROM]->(src)', { params: { eventId: 'github-universe-2026', sessionId: session.id, sourceId: session.sourceId || seed.source.id } });
      for (const topic of session.topics) {
        await graph.query('MATCH (s:Session {id:$sessionId}), (t:Topic {name:$topic}) MERGE (s)-[:COVERS]->(t)', { params: { sessionId: session.id, topic } });
      }
      for (const speakerId of session.speakers) {
        await graph.query('MATCH (s:Session {id:$sessionId}), (p:Speaker {id:$speakerId}) MERGE (s)-[:PRESENTS]->(p)', { params: { sessionId: session.id, speakerId } });
      }
    }
    const check = await graph.query('MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY label');
    const rows = check.data || check.result_set || [];
    if (!rows.length) throw new Error('The graph health query returned no seeded nodes.');
    const counts = Object.fromEntries(rows.map(row => {
      const [label, count] = Array.isArray(row) ? row : [row.label, row.count];
      return [label, Number(count)];
    }));
    graphState.mode = 'falkordb';
    graphState.detail = `Connected to FalkorDB graph “${graphName}”; graph query verified ${Object.values(counts).reduce((sum, count) => sum + count, 0)} nodes (${Object.entries(counts).map(([label, count]) => `${count} ${label}`).join(', ')}).`;
  } catch (error) {
    graph = null;
    graphState.mode = 'sqlite-graph';
    const rawReason = String(error?.message || error?.code || error?.name || 'connection/query error');
    const reason = rawReason
      .replaceAll(process.env.FALKORDB_PASSWORD || '\u0000', '[redacted]')
      .replaceAll(process.env.FALKORDB_URL || '\u0000', '[endpoint]')
      .slice(0, 180);
    graphState.detail = `FalkorDB connection or seed check failed (${reason}); using the persistent SQLite graph database verified at startup.`;
  }
}

await initFalkorDB();

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const MAX_JSON_BODY_BYTES = 64 * 1024;

function bodyJson(req) {
  return new Promise((resolve, reject) => {
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
      req.resume();
      reject(new HttpError(413, 'Request body is too large.'));
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on('data', chunk => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        settled = true;
        chunks.length = 0;
        req.resume();
        reject(new HttpError(413, 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try {
        const value = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'Expected a JSON object.');
        resolve(value);
      } catch (error) {
        reject(error instanceof HttpError ? error : new HttpError(400, 'Malformed JSON request body.'));
      }
    });
    req.on('error', error => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function cleanWords(text) {
  const stopWords = new Set(['and', 'the', 'for', 'that', 'with', 'from', 'this', 'into', 'have', 'your', 'you', 'our', 'are', 'was', 'not', 'but', 'who', 'can', 'how', 'what', 'when', 'where', 'which', 'their', 'they', 'them', 'its', 'all', 'any', 'other', 'more', 'than', 'then', 'while', 'across', 'using', 'about', 'through', 'will', 'does', 'has', 'had', 'into', 'open', 'pull', 'meet']);
  return new Set((String(text || '').toLowerCase().match(/[a-z0-9]+/g) || []).filter(word => word.length > 2 && !stopWords.has(word)));
}

function overlapScore(a, b) {
  const aa = cleanWords(a);
  const bb = cleanWords(b);
  let n = 0;
  for (const word of aa) if (word.length > 2 && bb.has(word)) n += 1;
  return n;
}

function findTopicMatches(text) {
  return seed.topics.filter(topic => overlapScore(text, topic) > 0 || topicTerms[topic]?.some(term => String(text).toLowerCase().includes(term)));
}

const topicTerms = {
  'Agent harnesses': ['agent', 'harness', 'agents', 'delegat'],
  'MCP security': ['mcp', 'security', 'secure', 'authorization', 'permission'],
  'Model evaluation': ['evaluation', 'evaluat', 'benchmark', 'model', 'regression'],
  'AI adoption': ['adoption', 'adopt', 'fluency', 'enterprise'],
  'Open source': ['open source', 'opensource', 'maintainer'],
  'Developer workflows': ['workflow', 'developer', 'pull request', 'copilot', 'coding'],
  'Agent authorization': ['authorization', 'authz', 'identity', 'permission'],
  'Community building': ['community', 'contributors', 'contribution']
};

function profileAndMatches(payload) {
  const interests = String(payload.interests || '').slice(0, 500);
  const knownSpeakerIds = new Set(seed.speakers.map(speaker => speaker.id));
  const metSpeakerIds = [...new Set((Array.isArray(payload.metSpeakerIds) ? payload.metSpeakerIds : [])
    .slice(0, seed.speakers.length)
    .map(id => String(id).slice(0, 100))
    .filter(id => knownSpeakerIds.has(id)))];
  const matchedTopics = findTopicMatches(interests);
  const sessions = seed.sessions.map(session => {
    const matched = session.topics.filter(topic => matchedTopics.includes(topic));
    const keywordScore = overlapScore(interests, `${session.title} ${session.summary}`);
    return { ...session, matchedTopics: matched, score: matched.length * 3 + keywordScore };
  });
  const missedSession = seed.sessions.find(session => session.id === payload.missedSessionId) || null;
  return { interests, metSpeakerIds, matchedTopics, sessions, missedSession };
}

async function speakerPaths(interestTopics, metSpeakerIds) {
  if (!interestTopics.length) return [];
  if (!graph) return sqliteSpeakerPaths(interestTopics, metSpeakerIds);
  const result = await graph.query(
    'UNWIND $topics AS topicName MATCH (t:Topic {name:topicName})<-[:COVERS]-(s:Session)-[:PRESENTS]->(p:Speaker) RETURN p.id AS speakerId, p.name AS speakerName, p.organization AS organization, collect(DISTINCT t.name) AS reasons, collect(DISTINCT s.id) AS sessionIds, count(DISTINCT t) AS pathCount ORDER BY pathCount DESC LIMIT 12',
    { params: { topics: interestTopics } }
  );
  const rows = result.data || result.result_set || [];
  const met = new Set(metSpeakerIds);
  return rows.filter(row => {
    const speakerId = Array.isArray(row) ? row[0] : row.speakerId;
    return !met.has(speakerId);
  });
}

async function recommend(payload) {
  const { metSpeakerIds, matchedTopics, sessions, missedSession: missed } = profileAndMatches(payload);
  const sortedSessions = sessions.filter(session => session.score > 0).sort((a, b) => b.score - a.score);
  const speakerScores = new Map();
  for (const row of await speakerPaths(matchedTopics, metSpeakerIds)) {
    const [speakerId, speakerName, organization, reasons, sessionIds, pathCount] = Array.isArray(row)
      ? row
      : [row.speakerId, row.speakerName, row.organization, row.reasons, row.sessionIds, row.pathCount];
    if (!speakerId || metSpeakerIds.includes(speakerId)) continue;
    const speaker = seed.speakers.find(item => item.id === speakerId) || { id: speakerId, name: speakerName || 'Conference speaker', organization: organization || 'GitHub Universe' };
    const relatedSessions = (Array.isArray(sessionIds) ? sessionIds : String(sessionIds || '').split(',')).map(id => seed.sessions.find(session => session.id === id)).filter(Boolean).map(session => ({ id: session.id, title: session.title }));
    const normalizedReasons = Array.isArray(reasons) ? reasons : String(reasons || '').split(',').filter(Boolean);
    speakerScores.set(speakerId, { speaker, score: Number(pathCount) || 1, reasons: normalizedReasons, relatedSessions });
  }
  if (missed) {
    for (const speakerId of missed.speakers) {
      const speaker = seed.speakers.find(item => item.id === speakerId);
      if (!speaker || metSpeakerIds.includes(speakerId)) continue;
      const existing = speakerScores.get(speakerId) || { speaker, score: 0, reasons: [], relatedSessions: [] };
      existing.score += 2;
      existing.reasons.push(...missed.topics.filter(topic => matchedTopics.includes(topic)));
      existing.relatedSessions.push({ id: missed.id, title: missed.title });
      speakerScores.set(speakerId, existing);
    }
  }
  const speakers = [...speakerScores.values()].sort((a, b) => b.score - a.score).slice(0, 4).map(item => ({
    ...item,
    reasons: [...new Set(item.reasons)],
    relatedSessions: item.relatedSessions.filter((session, index, all) => all.findIndex(other => other.id === session.id) === index)
  }));
  return { matchedTopics, recommendedSessions: sortedSessions.slice(0, 4), speakers, missedSession: missed, graphMode: graphState.mode };
}

async function refreshWithBrightData() {
  await loadLocalEnv();
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!apiKey || !zone) {
    return { ok: false, configured: false, message: 'Set BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE to make a live request. The prototype’s sourced sample graph remains available.' };
  }
  const response = await fetch('https://api.brightdata.com/request', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      zone,
      url: seed.source.url,
      format: 'raw',
      data_format: 'markdown'
    }),
    signal: AbortSignal.timeout(35000)
  });
  const result = await response.text();
  if (!response.ok) return { ok: false, configured: true, status: response.status, message: `Bright Data returned HTTP ${response.status}: ${result.slice(0, 240)}` };
  const normalizeText = text => String(text).replace(/<[^>]+>/g, ' ').replace(/\\u003c/g, '<').replace(/\\n/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const normalized = ` ${normalizeText(result)} `;
  const matches = seed.sessions.filter(session => {
    const title = normalizeText(session.title);
    return title.length > 0 && normalized.includes(` ${title} `);
  });
  const sections = result.split(/(?=^#{2,3}\s)/m);
  const verifiedAt = new Date().toISOString();
  // A successful fetch is a replacement snapshot, so unmatched sessions lose old live claims.
  for (const session of seed.sessions) {
    delete session.liveSourceExcerpt;
    delete session.sourceVerifiedAt;
  }
  sqlite("UPDATE graph_nodes SET properties=json_remove(properties,'$.liveSourceExcerpt','$.sourceVerifiedAt') WHERE label='Session';");
  const scrapedRecords = matches.map(session => {
    const title = normalizeText(session.title);
    const section = sections.find(candidate => normalizeText(candidate).includes(title)) || '';
    const excerpt = section
      .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&amp;|&quot;|&#39;|&apos;/g, ' ')
      .replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1400);
    session.liveSourceExcerpt = excerpt;
    session.sourceVerifiedAt = verifiedAt;
    upsertNode(session.id, 'Session', session);
    return { sessionId: session.id, title: session.title, excerpt, sourceUrl: seed.source.url };
  });
  const found = matches.map(session => session.id);
  lastRefresh = { at: verifiedAt, target: seed.source.name, sourceUrl: seed.source.url, returnedChars: result.length, foundSessions: found.length, foundSessionIds: found, extractedRecords: scrapedRecords.length };
  sqlite(`INSERT INTO app_metadata(key,value) VALUES('live_scraped_records',${sqlText(JSON.stringify(scrapedRecords))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
  sqlite(`INSERT INTO app_metadata(key,value) VALUES('last_brightdata_refresh',${sqlText(JSON.stringify(lastRefresh))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
  return {
    ok: true,
    configured: true,
    status: response.status,
      message: found.length
      ? `Bright Data fetched GitHub’s official 2026 talk roundup live, verified ${found.length} titles, and extracted ${scrapedRecords.length} source records into SQLite.`
      : 'Bright Data reached GitHub’s official talk roundup, but no session titles matched the local catalog.',
    foundSessions: found.length,
    sampleMatches: found,
    returnedChars: result.length,
    at: lastRefresh.at
  };
}

const staticRoot = resolve(root, 'public');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'OPTIONS') return send(res, 405, { error: 'Cross-origin requests are not supported.' });
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      return send(res, 200, {
        event: seed.event,
        source: seed.source,
        topics: seed.topics,
        sessions: readGraphRecords('Session'),
        speakers: readGraphRecords('Speaker'),
        graph: graphState,
        lastRefresh,
        brightDataConfigured: Boolean(process.env.BRIGHTDATA_API_KEY && process.env.BRIGHTDATA_UNLOCKER_ZONE)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/recommend') {
      return send(res, 200, await recommend(await bodyJson(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      const remoteAddress = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      const origin = req.headers.origin;
      const allowedLocalHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
      let allowedOrigin = false;
      try {
        const originUrl = new URL(origin || '');
        allowedOrigin = originUrl.protocol === 'http:'
          && allowedLocalHosts.has(originUrl.hostname.toLowerCase())
          && originUrl.host === req.headers.host;
      } catch {}
      if (!['127.0.0.1', '::1'].includes(remoteAddress) || !allowedOrigin) {
        return send(res, 403, { error: 'Bright Data refresh is available only from this local app.' });
      }
      return send(res, 200, await refreshWithBrightData());
    }
    if (req.method === 'POST' && url.pathname === '/api/graph-query') {
      const { matchedTopics, metSpeakerIds } = profileAndMatches(await bodyJson(req));
      const cypher = 'UNWIND $topics AS topicName MATCH (t:Topic {name:topicName})<-[:COVERS]-(s:Session)-[:PRESENTS]->(p:Speaker) RETURN p.name, t.name, s.title ORDER BY p.name';
      const rows = await speakerPaths(matchedTopics, metSpeakerIds);
      return send(res, 200, {
        graphMode: graphState.mode,
        graph: graphName,
        detail: graphState.detail,
        query: graph ? `${cypher}\nParameters: topics = ${JSON.stringify(matchedTopics)}` : `SQLite graph path query: requested topics → sessions → speakers, excluding met speaker IDs. Topics: ${JSON.stringify(matchedTopics)}`,
        rows: rows.length
      });
    }
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const path = resolve(staticRoot, `.${relative}`);
    if (!path.startsWith(staticRoot + sep) && path !== resolve(staticRoot, 'index.html')) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    const data = await readFile(path);
    return send(res, 200, data, mimeTypes[extname(path)] || 'application/octet-stream');
  } catch (error) {
    return send(res, error.status || 500, { error: error.status ? error.message : 'Unexpected server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Conference Companion is running at http://127.0.0.1:${port}`);
  console.log(graphState.detail);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    if (falkorClient) await falkorClient.close();
    process.exit(0);
  });
}
