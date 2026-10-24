import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import net from 'node:net';

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
const graphState = { mode: 'sqlite-graph', detail: 'Persistent SQLite graph database connected.', diagnostic: '' };
let sqliteDetail = graphState.detail;
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
  sqliteDetail = `SQLite graph database verified (integrity_check=ok): ${counts.nodes} nodes and ${counts.edges} relationships persisted at data/patchwork.sqlite.`;
  graphState.detail = sqliteDetail;
}

syncSqliteGraph();
try {
  const storedRefresh = sqlite("SELECT value FROM app_metadata WHERE key='last_brightdata_refresh';", true)[0]?.value;
  if (storedRefresh) lastRefresh = JSON.parse(storedRefresh);
} catch {}

function sqliteSpeakerPathQuery(interestTopics, metSpeakerIds) {
  const topicsJson = sqlText(JSON.stringify(interestTopics));
  const metIdsJson = sqlText(JSON.stringify(metSpeakerIds));
  return `SELECT p.id AS speakerId,json_extract(p.properties,'$.name') AS speakerName,json_extract(p.properties,'$.organization') AS organization,
      group_concat(DISTINCT json_extract(t.properties,'$.name')) AS reasons,
      group_concat(DISTINCT s.id) AS sessionIds,count(DISTINCT t.id) AS pathCount
    FROM json_each(${topicsJson}) requested
    JOIN graph_nodes t ON t.label='Topic' AND json_extract(t.properties,'$.name')=requested.value
    JOIN graph_edges covers ON covers.to_id=t.id AND covers.relation='COVERS'
    JOIN graph_nodes s ON s.id=covers.from_id AND s.label='Session'
    JOIN graph_edges presents ON presents.from_id=s.id AND presents.relation='PRESENTS'
    JOIN graph_nodes p ON p.id=presents.to_id AND p.label='Speaker'
    WHERE p.id NOT IN (SELECT value FROM json_each(${metIdsJson}))
    GROUP BY p.id ORDER BY pathCount DESC,p.id LIMIT 12;`;
}

function sqliteSpeakerPaths(interestTopics, metSpeakerIds) {
  return sqlite(sqliteSpeakerPathQuery(interestTopics, metSpeakerIds), true);
}

// Four hops: a speaker you saved <- their session -> a shared topic <- another
// session -> the speaker presenting it. This is the "who else should I meet"
// question, and it is only answerable by walking the graph.
function sqliteAlsoMeetQuery(savedIds, excludeIds) {
  const savedJson = sqlText(JSON.stringify(savedIds));
  const excludeJson = sqlText(JSON.stringify(excludeIds));
  return `SELECT other.id AS speakerId,
      json_extract(other.properties,'$.name') AS speakerName,
      json_extract(other.properties,'$.organization') AS organization,
      group_concat(DISTINCT json_extract(t.properties,'$.name')) AS sharedTopics,
      group_concat(DISTINCT json_extract(anchor.properties,'$.name')) AS viaSpeakers,
      group_concat(DISTINCT s2.id) AS sessionIds,
      count(DISTINCT t.id) AS strength
    FROM json_each(${savedJson}) saved
    JOIN graph_nodes anchor ON anchor.id=saved.value AND anchor.label='Speaker'
    JOIN graph_edges p1 ON p1.relation='PRESENTS' AND p1.to_id=anchor.id
    JOIN graph_nodes s1 ON s1.id=p1.from_id AND s1.label='Session'
    JOIN graph_edges c1 ON c1.relation='COVERS' AND c1.from_id=s1.id
    JOIN graph_nodes t ON t.id=c1.to_id AND t.label='Topic'
    JOIN graph_edges c2 ON c2.relation='COVERS' AND c2.to_id=t.id
    JOIN graph_nodes s2 ON s2.id=c2.from_id AND s2.label='Session' AND s2.id<>s1.id
    JOIN graph_edges p2 ON p2.relation='PRESENTS' AND p2.from_id=s2.id
    JOIN graph_nodes other ON other.id=p2.to_id AND other.label='Speaker'
    WHERE other.id NOT IN (SELECT value FROM json_each(${excludeJson}))
    GROUP BY other.id ORDER BY strength DESC, other.id LIMIT 6;`;
}

const FALKORDB_ALSO_MEET_QUERY = 'UNWIND $saved AS savedId MATCH (anchor:Speaker {id:savedId})<-[:PRESENTS]-(s1:Session)-[:COVERS]->(t:Topic)<-[:COVERS]-(s2:Session)-[:PRESENTS]->(other:Speaker) WHERE NOT other.id IN $exclude AND s1 <> s2 RETURN other.id AS speakerId, other.name AS speakerName, other.organization AS organization, collect(DISTINCT t.name) AS sharedTopics, collect(DISTINCT anchor.name) AS viaSpeakers, collect(DISTINCT s2.id) AS sessionIds, count(DISTINCT t) AS strength ORDER BY strength DESC, other.id LIMIT 6';

async function alsoMeet(savedIds, metIds) {
  if (!savedIds.length) return { speakers: [], query: '', rows: 0 };
  const exclude = [...new Set([...savedIds, ...metIds])];
  const rows = graph
    ? ((await graph.query(FALKORDB_ALSO_MEET_QUERY, { params: { saved: savedIds, exclude } })).data || [])
    : sqlite(sqliteAlsoMeetQuery(savedIds, exclude), true);
  const speakers = rows.map(row => {
    const [speakerId, speakerName, organization, sharedTopics, viaSpeakers, sessionIds, strength] = Array.isArray(row)
      ? row
      : [row.speakerId, row.speakerName, row.organization, row.sharedTopics, row.viaSpeakers, row.sessionIds, row.strength];
    const list = value => (Array.isArray(value) ? value : String(value || '').split(',')).filter(Boolean);
    return {
      speaker: seed.speakers.find(item => item.id === speakerId) || { id: speakerId, name: speakerName, organization },
      sharedTopics: list(sharedTopics),
      viaSpeakers: list(viaSpeakers),
      relatedSessions: list(sessionIds).map(id => seed.sessions.find(session => session.id === id)).filter(Boolean)
        .map(session => ({ id: session.id, title: session.title, sourceUrl: session.sourceUrl || seed.event.url })),
      strength: Number(strength) || 1
    };
  });
  return {
    speakers,
    rows: rows.length,
    query: graph
      ? `${FALKORDB_ALSO_MEET_QUERY}\nParameters: saved = ${JSON.stringify(savedIds)}, exclude = ${JSON.stringify(exclude)}`
      : sqliteAlsoMeetQuery(savedIds, exclude)
  };
}

const FALKORDB_SPEAKER_PATH_QUERY = 'UNWIND $topics AS topicName MATCH (t:Topic {name:topicName})<-[:COVERS]-(s:Session)-[:PRESENTS]->(p:Speaker) WHERE NOT p.id IN $met RETURN p.id AS speakerId, p.name AS speakerName, p.organization AS organization, collect(DISTINCT t.name) AS reasons, collect(DISTINCT s.id) AS sessionIds, count(DISTINCT t) AS pathCount ORDER BY pathCount DESC, p.id LIMIT 12';

// A TLS-vs-plaintext mismatch presents as a plain connect timeout, which is
// indistinguishable from an unreachable host. Ask the endpoint directly so the
// log can say which one it is instead of leaving a 10s silence.
function probeRedisPlaintext(host, port) {
  return new Promise(resolve => {
    let settled = false;
    const finish = value => { if (!settled) { settled = true; resolve(value); socket.destroy(); } };
    const socket = net.connect({ host, port, timeout: 5000 }, () => socket.write('PING\r\n'));
    socket.setTimeout(5000, () => finish(false));
    socket.on('data', data => finish(/^[-+]/.test(data.toString())));
    socket.on('error', () => finish(false));
  });
}

function nodeSupportsFalkorClient() {
  return Number(process.versions.node.split('.')[0]) >= 22;
}

async function initFalkorDB() {
  if (!process.env.FALKORDB_URL && !process.env.FALKORDB_HOST) return;
  // The client is ESM-only and requires Node 22+. On an older runtime the import
  // fails in a way that reads like a connection problem, so say it plainly.
  if (!nodeSupportsFalkorClient()) {
    graphState.diagnostic = `FalkorDB is configured but the client needs Node 22 or newer and this is Node ${process.versions.node}. Run "nvm use" (see .nvmrc) and restart. Serving the SQLite graph meanwhile.`;
    console.warn(graphState.diagnostic);
    return;
  }
  const url = process.env.FALKORDB_URL ? (() => { try { return new URL(process.env.FALKORDB_URL); } catch { return null; } })() : null;
  if (process.env.FALKORDB_URL && !url) {
    graphState.diagnostic = 'FALKORDB_URL is not a valid connection URL; refusing to connect.';
    console.warn(graphState.diagnostic);
    return;
  }
  const configuredHost = process.env.FALKORDB_HOST || url?.hostname || '';
  const hostname = configuredHost.toLowerCase().replace(/^\[|\]$/g, '');
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(hostname);
  const urlUsesTls = url?.protocol === 'rediss:';
  const tlsEnabled = process.env.FALKORDB_TLS === 'true' || urlUsesTls;
  if (!isLoopback && !tlsEnabled && process.env.FALKORDB_ALLOW_INSECURE !== 'true') {
    graphState.diagnostic = 'Refusing a remote FalkorDB connection without TLS, including FALKORDB_URL connections. Enable TLS or explicitly opt in after reviewing the risk.';
    console.warn(graphState.diagnostic);
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
    // Keep the SQLite detail the UI shows; the FalkorDB reason is for the operator's log.
    graphState.detail = sqliteDetail;
    let advice = '';
    if (/timeout/i.test(rawReason) && tlsEnabled) {
      const host = process.env.FALKORDB_HOST || url?.hostname;
      const port = Number(process.env.FALKORDB_PORT || url?.port || 6379);
      if (host && await probeRedisPlaintext(host, port)) {
        advice = ` The endpoint at port ${port} answered a plaintext Redis PING, so it is reachable but is not speaking TLS. Either point FALKORDB_HOST/PORT at a TLS endpoint, or set FALKORDB_TLS=false together with FALKORDB_ALLOW_INSECURE=true if you accept sending credentials unencrypted.`;
      }
    }
    graphState.diagnostic = `Optional FalkorDB connection unavailable (${reason}).${advice} Serving the persistent SQLite graph instead.`;
    console.warn(graphState.diagnostic);
  }
}

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

// Terms are matched on word boundaries, so short ones like "ai" or "ux" cannot
// fire inside unrelated words ("explain", "flux").
const topicTerms = {
  'Agent harnesses': ['agent', 'agents', 'agentic', 'harness', 'harnesses', 'delegate', 'delegating', 'delegation', 'autonomy', 'autonomous', 'orchestration'],
  'MCP security': ['mcp', 'security', 'secure', 'supply chain', 'vulnerability', 'threat', 'sandbox', 'secrets', 'npm', 'dependency', 'dependencies'],
  'Model evaluation': ['eval', 'evals', 'evaluation', 'evaluations', 'evaluating', 'benchmark', 'benchmarks', 'benchmarking', 'model', 'models', 'llm', 'regression', 'testing', 'tests', 'quality', 'measurement', 'metrics'],
  'AI adoption': ['ai', 'adoption', 'adopt', 'fluency', 'enterprise', 'rollout', 'training', 'onboarding', 'change management', 'machine learning', 'ml'],
  'Open source': ['open source', 'opensource', 'oss', 'maintainer', 'maintainers', 'licensing', 'license', 'governance', 'foundation'],
  'Developer workflows': ['workflow', 'workflows', 'developer', 'developers', 'devex', 'dx', 'developer experience', 'pull request', 'pull requests', 'code review', 'copilot', 'coding', 'ci', 'cd', 'devops', 'pipeline', 'pipelines', 'actions', 'tooling', 'toolchain', 'javascript', 'typescript', 'node', 'cli', 'productivity', 'debugging', 'incident', 'observability', 'rca'],
  'Agent authorization': ['authorization', 'authz', 'auth', 'identity', 'permission', 'permissions', 'scopes', 'access control', 'oauth', 'tokens'],
  'Community building': ['community', 'communities', 'contributor', 'contributors', 'contribution', 'contributions', 'mentorship', 'inclusion', 'accessibility', 'a11y', 'diversity', 'documentation', 'docs'],
  'Design': ['design', 'designer', 'designers', 'ux', 'ui', 'user experience', 'product design', 'visual design', 'interface', 'interfaces', 'interaction', 'prototyping', 'usability', 'accessibility', 'a11y'],
  'Creative coding': ['creative coding', 'creative', 'sketching', 'sketch', 'p5', 'p5.js', 'processing', 'creative technology', 'generative', 'art']
};

const termPattern = term => new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^a-z0-9])`, 'i');
const compiledTopicTerms = Object.fromEntries(
  Object.entries(topicTerms).map(([topic, terms]) => [topic, terms.map(termPattern)])
);

function findTopicMatches(text) {
  const query = String(text || '');
  const direct = seed.topics.filter(topic =>
    overlapScore(query, topic) > 0 || compiledTopicTerms[topic]?.some(pattern => pattern.test(query))
  );
  if (direct.length) return direct;
  // Nothing hit the curated vocabulary, so fall back to the catalog itself: any
  // session whose title or summary overlaps the query lends Patchwork its topics.
  const viaSessions = new Set();
  for (const session of seed.sessions) {
    if (overlapScore(query, `${session.title} ${session.summary}`) > 0) {
      for (const topic of session.topics) viaSessions.add(topic);
    }
  }
  return seed.topics.filter(topic => viaSessions.has(topic));
}

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
    FALKORDB_SPEAKER_PATH_QUERY,
    { params: { topics: interestTopics, met: metSpeakerIds } }
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
  if (matches.length === 0) {
    return {
      ok: true,
      configured: true,
      status: response.status,
      message: 'Bright Data reached GitHub’s official 2026 talk roundup, but this fetch found no exact local-catalog title matches. Existing verified records were left untouched.',
      foundSessions: 0,
      sampleMatches: [],
      previousFoundSessions: lastRefresh?.foundSessions || 0,
      returnedChars: result.length,
      at: new Date().toISOString(),
      preservedPrevious: true
    };
  }
  const sections = result.split(/(?=^#{2,3}\s)/m);
  const verifiedAt = new Date().toISOString();
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
    return { sessionId: session.id, title: session.title, excerpt, sourceUrl: seed.source.url };
  });
  const found = matches.map(session => session.id);
  const nextRefresh = { at: verifiedAt, target: seed.source.name, sourceUrl: seed.source.url, returnedChars: result.length, foundSessions: found.length, foundSessionIds: found, extractedRecords: scrapedRecords.length };
  const snapshotSql = [
    '.bail on',
    'BEGIN IMMEDIATE;',
    "UPDATE graph_nodes SET properties=json_remove(properties,'$.liveSourceExcerpt','$.sourceVerifiedAt') WHERE label='Session';",
    ...scrapedRecords.map(record => `UPDATE graph_nodes SET properties=json_patch(properties,${sqlText(JSON.stringify({ liveSourceExcerpt: record.excerpt, sourceVerifiedAt: verifiedAt }))}) WHERE id=${sqlText(record.sessionId)} AND label='Session';`),
    `INSERT INTO app_metadata(key,value) VALUES('live_scraped_records',${sqlText(JSON.stringify(scrapedRecords))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`,
    `INSERT INTO app_metadata(key,value) VALUES('last_brightdata_refresh',${sqlText(JSON.stringify(nextRefresh))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`,
    'COMMIT;'
  ].join('\n');
  sqlite(snapshotSql);
  for (const session of seed.sessions) {
    delete session.liveSourceExcerpt;
    delete session.sourceVerifiedAt;
  }
  for (const record of scrapedRecords) {
    const session = seed.sessions.find(item => item.id === record.sessionId);
    session.liveSourceExcerpt = record.excerpt;
    session.sourceVerifiedAt = verifiedAt;
  }
  lastRefresh = nextRefresh;
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

const liveSpeakerSources = [
  { name: 'GitHub Universe speaker page', url: seed.event.url },
  { name: 'GitHub Universe schedule announcement', url: 'https://github.blog/news-insights/company-news/your-guide-to-github-universe-2026-is-here-the-schedule-just-launched/' }
];

function normalizeLiveText(value) {
  return String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, ' ')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9+.#]+/g, ' ').replace(/\s+/g, ' ').trim();
}

async function searchLiveSpeakers(payload) {
  await loadLocalEnv();
  const query = String(payload.query || '').trim().slice(0, 100);
  if (!query) throw new HttpError(400, 'Enter a topic such as design, accessibility, or open source.');
  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!apiKey || !zone) {
    return { ok: false, configured: false, speakers: [], message: 'Bright Data is not configured. Set BRIGHTDATA_API_KEY and BRIGHTDATA_UNLOCKER_ZONE to fetch public speaker sources live.' };
  }

  // Topic matching is local, so resolve it before spending live fetches on a
  // query the catalog cannot answer.
  const recommendation = await recommend({ interests: query, metSpeakerIds: payload.metSpeakerIds });
  if (!recommendation.speakers.length) {
    return {
      ok: true,
      configured: true,
      query,
      matchedTopics: recommendation.matchedTopics,
      speakers: [],
      graphMode: graphState.mode,
      skippedFetch: true,
      suggestions: seed.topics,
      sources: [],
      fetchedAt: new Date().toISOString(),
      message: recommendation.matchedTopics.length
        ? `No speaker in the catalog is left for “${query}” — everyone on that path is already marked met.`
        : `No conference topic matches “${query}”, so no live fetch was made. Try one of the ${seed.topics.length} topics in this catalog.`
    };
  }

  const fetched = await Promise.all(liveSpeakerSources.map(async source => {
    try {
      const response = await fetch('https://api.brightdata.com/request', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ zone, url: source.url, format: 'raw', data_format: 'markdown' }),
        signal: AbortSignal.timeout(35000)
      });
      const text = await response.text();
      if (!response.ok) return { ...source, ok: false, error: `Bright Data returned HTTP ${response.status}`, text: '' };
      return { ...source, ok: true, text, chars: text.length };
    } catch (error) {
      return { ...source, ok: false, error: error.name === 'TimeoutError' ? 'The source fetch timed out.' : 'The source could not be fetched.', text: '' };
    }
  }));
  const successful = fetched.filter(source => source.ok);
  if (!successful.length) {
    return { ok: false, configured: true, speakers: [], sources: fetched.map(({ name, url, ok, error }) => ({ name, url, ok, error })), message: fetched.map(source => `${source.name}: ${source.error}`).join(' ') };
  }

  const corpus = normalizeLiveText(successful.map(source => source.text).join(' '));
  const liveCandidates = recommendation.speakers.filter(match => {
    const name = normalizeLiveText(match.speaker.name);
    if (!name || !corpus.includes(name)) return false;
    return match.relatedSessions.some(related => {
      const session = seed.sessions.find(item => item.id === related.id);
      return session && corpus.includes(normalizeLiveText(session.title));
    });
  }).map(match => {
    const relatedSessions = match.relatedSessions.map(related => {
      const session = seed.sessions.find(item => item.id === related.id);
      return session ? { ...related, sourceUrl: session.sourceUrl || seed.event.url } : related;
    });
    return { ...match, relatedSessions, liveVerified: true };
  });

  const verifiedAt = new Date().toISOString();
  for (const match of liveCandidates) {
    upsertNode(match.speaker.id, 'Speaker', { sourceVerifiedAt: verifiedAt, verifiedSourceUrls: successful.map(source => source.url) });
    if (graph) {
      await graph.query('MATCH (p:Speaker {id:$id}) SET p.sourceVerifiedAt=$at, p.verifiedSourceUrls=$urls', {
        params: { id: match.speaker.id, at: verifiedAt, urls: successful.map(source => source.url) }
      });
    }
  }
  const searchMetadata = {
    at: verifiedAt,
    sources: successful.map(source => ({ name: source.name, url: source.url, returnedChars: source.chars })),
    verifiedSpeakerIds: liveCandidates.map(match => match.speaker.id)
  };
  sqlite(`INSERT INTO app_metadata(key,value) VALUES('last_live_speaker_search',${sqlText(JSON.stringify(searchMetadata))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
  return {
    ok: true,
    configured: true,
    query,
    matchedTopics: recommendation.matchedTopics,
    speakers: liveCandidates,
    graphMode: graphState.mode,
    graphDetail: graphState.detail,
    fetchedAt: verifiedAt,
    graphCandidates: recommendation.speakers.length,
    suggestions: seed.topics,
    sources: fetched.map(({ name, url, ok, error, chars }) => ({ name, url, ok, ...(error ? { error } : {}), ...(chars ? { chars } : {}) })),
    message: `${successful.length} public GitHub Universe source${successful.length === 1 ? '' : 's'} fetched live through Bright Data. ${liveCandidates.length} of ${recommendation.speakers.length} graph candidate${recommendation.speakers.length === 1 ? '' : 's'} confirmed by name and session title in the live pages.`
  };
}

// LinkedIn blocks plain scripts after a handful of requests (HTTP 999), so the
// profile lookup goes through Bright Data. A fetched page is never trusted on
// its own: a name-derived profile URL can easily land on a different person, so
// the profile must corroborate both the speaker's name and the organization the
// official GitHub source gave us before Patchwork will show it.
function linkedinCandidates(name) {
  const parts = String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s-]/g, '').split(/[\s-]+/).filter(Boolean);
  if (parts.length < 2) return [];
  const [first, ...rest] = parts;
  const last = rest[rest.length - 1];
  return [...new Set([`${first}${last}`, `${first}-${last}`, parts.join('-')])];
}

// LinkedIn's markdown conversion trips Bright Data's "reject element found"
// guard on the auth-wall banner and returns an empty body, so profiles are
// fetched as raw HTML and the headline is read out of <title>.
function profileHeadline(html) {
  const title = String(html).match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  return title.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s*\|\s*LinkedIn\s*$/i, '').replace(/\s+/g, ' ').trim();
}

function verifyProfile(text, speaker) {
  const flat = String(text).replace(/\s+/g, ' ');
  const norm = value => String(value).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
  const body = norm(flat.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, ' '));
  const headline = profileHeadline(flat) || flat.slice(0, 200);
  const nameParts = norm(speaker.name).split(' ').filter(word => word.length > 1);
  // Every part of the speaker's name has to appear in the page's own headline.
  const nameMatch = nameParts.length > 0 && nameParts.every(part => norm(headline).includes(part));
  // The organization is the tie-breaker that rules out a same-named stranger.
  const orgWords = norm(speaker.organization).split(' ')
    .filter(word => word.length > 3 && !['the', 'inc', 'ltd', 'llc', 'foundation', 'university', 'software'].includes(word));
  const orgMatch = orgWords.length === 0 || orgWords.some(word => body.includes(word));
  return {
    verified: nameMatch && orgMatch,
    nameMatch,
    orgMatch,
    headline: (profileHeadline(flat) || flat.slice(0, 160)).slice(0, 160).trim(),
    reason: nameMatch ? (orgMatch ? 'Name and organization both confirmed on the profile.' : `The profile names a different employer than “${speaker.organization}”, so Patchwork will not claim it is the same person.`) : 'The profile headline does not carry this speaker’s name.'
  };
}

async function enrichSpeaker(payload) {
  await loadLocalEnv();
  const speaker = seed.speakers.find(item => item.id === String(payload.speakerId || '').slice(0, 100));
  if (!speaker) throw new HttpError(404, 'That speaker is not in the conference graph.');
  const cached = sqlite(`SELECT value FROM app_metadata WHERE key='enrich:${String(speaker.id).replaceAll("'", "''")}';`, true)[0]?.value;
  if (cached) { try { return { ...JSON.parse(cached), cached: true }; } catch {} }

  const apiKey = process.env.BRIGHTDATA_API_KEY;
  const zone = process.env.BRIGHTDATA_UNLOCKER_ZONE;
  if (!apiKey || !zone) return { ok: false, configured: false, speakerId: speaker.id, message: 'Bright Data is not configured, so no profile lookup was made.' };

  const attempts = [];
  for (const slug of linkedinCandidates(speaker.name)) {
    const profileUrl = `https://www.linkedin.com/in/${slug}`;
    try {
      let response;
      let text = '';
      // An empty body means Bright Data rejected the page mid-unlock; one retry
      // clears it often enough to be worth the extra few seconds.
      for (let attempt = 0; attempt < 2 && !text.trim(); attempt += 1) {
        response = await fetch('https://api.brightdata.com/request', {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ zone, url: profileUrl, format: 'raw' }),
          signal: AbortSignal.timeout(60000)
        });
        if (!response.ok) break;
        text = await response.text();
      }
      if (!response.ok) { attempts.push({ profileUrl, outcome: `Bright Data returned HTTP ${response.status}` }); continue; }
      if (!text.trim()) { attempts.push({ profileUrl, outcome: 'Bright Data reached LinkedIn but the page came back empty twice.' }); continue; }
      const check = verifyProfile(text, speaker);
      if (!check.verified) { attempts.push({ profileUrl, outcome: check.reason }); continue; }
      const record = {
        ok: true, configured: true, speakerId: speaker.id, verified: true, profileUrl,
        headline: check.headline, checkedAt: new Date().toISOString(), attempts,
        message: `Profile fetched through Bright Data and confirmed against the graph: ${check.reason}`
      };
      sqlite(`INSERT INTO app_metadata(key,value) VALUES('enrich:${speaker.id.replaceAll("'", "''")}',${sqlText(JSON.stringify(record))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
      upsertNode(speaker.id, 'Speaker', { linkedinUrl: profileUrl, linkedinHeadline: check.headline, linkedinVerifiedAt: record.checkedAt });
      if (graph) await graph.query('MATCH (p:Speaker {id:$id}) SET p.linkedinUrl=$url, p.linkedinHeadline=$headline, p.linkedinVerifiedAt=$at',
        { params: { id: speaker.id, url: profileUrl, headline: check.headline, at: record.checkedAt } });
      return record;
    } catch (error) {
      attempts.push({ profileUrl, outcome: error.name === 'TimeoutError' ? 'The profile fetch timed out.' : 'The profile could not be fetched.' });
    }
  }
  // Nothing corroborated. Say so rather than show a stranger with the right name.
  // A transport failure is not a verdict, so only a real rejection gets cached:
  // otherwise one flaky run would pin "unverified" on a speaker permanently.
  const reachedLinkedIn = attempts.some(attempt => /headline|employer|empty/i.test(attempt.outcome));
  const record = {
    ok: true, configured: true, speakerId: speaker.id, verified: false, attempts,
    checkedAt: new Date().toISOString(),
    retryable: !reachedLinkedIn,
    message: !attempts.length
      ? `No profile URL could be derived from “${speaker.name}”.`
      : reachedLinkedIn
        ? `No profile could be confirmed as ${speaker.name} of ${speaker.organization}. Patchwork is not guessing.`
        : `The lookup for ${speaker.name} could not reach LinkedIn. This is worth retrying.`
  };
  if (!record.retryable) {
    sqlite(`INSERT INTO app_metadata(key,value) VALUES('enrich:${speaker.id.replaceAll("'", "''")}',${sqlText(JSON.stringify(record))}) ON CONFLICT(key) DO UPDATE SET value=excluded.value;`);
  }
  return record;
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
        graph: { mode: graphState.mode, detail: graphState.detail },
        lastRefresh,
        brightDataConfigured: Boolean(process.env.BRIGHTDATA_API_KEY && process.env.BRIGHTDATA_UNLOCKER_ZONE)
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/recommend') {
      return send(res, 200, await recommend(await bodyJson(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/speakers/search') {
      const remoteAddress = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      let allowedOrigin = false;
      try {
        const originUrl = new URL(req.headers.origin || '');
        const allowedHost = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(originUrl.hostname.toLowerCase());
        allowedOrigin = originUrl.protocol === 'http:' && allowedHost && originUrl.host === req.headers.host;
      } catch {}
      if (!['127.0.0.1', '::1'].includes(remoteAddress) || !allowedOrigin) {
        return send(res, 403, { error: 'Live speaker search is available only from this local app.' });
      }
      return send(res, 200, await searchLiveSpeakers(await bodyJson(req)));
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
    if (req.method === 'POST' && url.pathname === '/api/also-meet') {
      const payload = await bodyJson(req);
      const known = new Set(seed.speakers.map(speaker => speaker.id));
      const clean = value => [...new Set((Array.isArray(value) ? value : []).map(id => String(id).slice(0, 100)).filter(id => known.has(id)))];
      const savedIds = clean(payload.savedIds).slice(0, seed.speakers.length);
      const metIds = clean(payload.metSpeakerIds).slice(0, seed.speakers.length);
      const result = await alsoMeet(savedIds, metIds);
      return send(res, 200, { ...result, graphMode: graphState.mode, detail: graphState.detail, hops: 4 });
    }
    if (req.method === 'POST' && url.pathname === '/api/speakers/enrich') {
      const remoteAddress = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (!['127.0.0.1', '::1'].includes(remoteAddress)) return send(res, 403, { error: 'Enrichment is available only from this local app.' });
      return send(res, 200, await enrichSpeaker(await bodyJson(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/graph-query') {
      const { interests, matchedTopics, metSpeakerIds } = profileAndMatches(await bodyJson(req));
      const rows = await speakerPaths(matchedTopics, metSpeakerIds);
      const speakers = rows.map(row => {
        const [speakerId, speakerName, organization, reasons, sessionIds] = Array.isArray(row)
          ? row
          : [row.speakerId, row.speakerName, row.organization, row.reasons, row.sessionIds];
        const ids = Array.isArray(sessionIds) ? sessionIds : String(sessionIds || '').split(',').filter(Boolean);
        return {
          speaker: seed.speakers.find(item => item.id === speakerId) || { id: speakerId, name: speakerName, organization },
          reasons: Array.isArray(reasons) ? reasons : String(reasons || '').split(',').filter(Boolean),
          relatedSessions: ids.map(id => seed.sessions.find(session => session.id === id)).filter(Boolean).map(session => ({ id: session.id, title: session.title, sourceUrl: session.sourceUrl || seed.event.url }))
        };
      });
      return send(res, 200, {
        graphMode: graphState.mode,
        graph: graphName,
        detail: graphState.detail,
        matchedTopics,
        interests,
        speakers,
        suggestions: seed.topics,
        query: graph
          ? `${FALKORDB_SPEAKER_PATH_QUERY}\nParameters: topics = ${JSON.stringify(matchedTopics)}, met = ${JSON.stringify(metSpeakerIds)}`
          : sqliteSpeakerPathQuery(matchedTopics, metSpeakerIds),
        rows: rows.length
      });
    }
    if (url.pathname.startsWith('/api/')) return send(res, 404, { error: `No API route matches ${req.method} ${url.pathname}.` });
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
    const path = resolve(staticRoot, `.${relative}`);
    if (!path.startsWith(staticRoot + sep) && path !== resolve(staticRoot, 'index.html')) return send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    const data = await readFile(path).catch(error => {
      // A missing or unreadable static file is a 404, not a server fault.
      if (['ENOENT', 'EISDIR', 'ENOTDIR'].includes(error.code)) throw new HttpError(404, 'Not found');
      throw error;
    });
    return send(res, 200, data, mimeTypes[extname(path)] || 'application/octet-stream');
  } catch (error) {
    if (!error.status) console.error('Request failed', req.method, url.pathname, error);
    if (error.status === 404 && !url.pathname.startsWith('/api/')) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
    return send(res, error.status || 500, { error: error.status ? error.message : 'Unexpected server error' });
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Patchwork is running at http://127.0.0.1:${port}`);
  console.log(graphState.detail);
  // FalkorDB is optional and can take ~10s to time out, so connect after the port is open.
  // Requests served before it resolves use the SQLite graph, which is already verified.
  initFalkorDB().then(() => {
    if (graphState.mode === 'falkordb') console.log(graphState.detail);
  });
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    server.close();
    if (falkorClient) await falkorClient.close();
    process.exit(0);
  });
}
