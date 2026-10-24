const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'patchwork:github-universe-2026';
const savedState = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } })();
const state = {
  data: null,
  attendeeId: savedState.attendeeId || `attendee-${crypto.randomUUID()}`,
  profile: savedState.profile || { name: 'You', interests: 'secure MCP agents, model evaluation, agent harnesses' },
  selectedSessionId: savedState.selectedSessionId || '',
  liveSessionIds: new Set(),
  missedSession: null,
  people: [],
  saved: new Set(savedState.saved || []),
  met: new Set(savedState.met || [])
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const initials = name => name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
const catalogUrl = 'https://reg.githubuniverse.com/flow/github/universe26/attendee-portal/page/sessioncatalog';
const questionByTopic = {
  'Agent harnesses': 'What did you learn about deciding when an agent should keep working versus hand control back?',
  'MCP security': 'Where do you draw the human approval boundary when an agent can act through MCP?',
  'Agent authorization': 'How do you make permissions specific enough to be safe without slowing useful work?',
  'Model evaluation': 'Which evaluation signal most changed how you choose or improve a model?',
  'AI adoption': 'What helped people move from trying AI tools to trusting them in everyday work?',
  'Open source': 'What should open-source communities change as AI-generated contributions grow?',
  'Developer workflows': 'Which part of the developer workflow became easiest to delegate, and what stayed human?',
  'Community building': 'How do you keep a community healthy when contribution volume changes quickly?'
};

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    attendeeId: state.attendeeId,
    profile: state.profile,
    selectedSessionId: state.selectedSessionId,
    saved: [...state.saved],
    met: [...state.met]
  }));
  $('#saved-count').textContent = String(state.saved.size);
}

function renderSelect() {
  const select = $('#session-select');
  select.innerHTML = state.data.sessions.map(session => `<option value="${esc(session.id)}">${esc(session.title)}</option>`).join('');
  select.value = state.data.sessions.some(session => session.id === state.selectedSessionId) ? state.selectedSessionId : state.data.sessions[0]?.id;
  state.selectedSessionId = select.value;
  persist();
  renderCatchup();
}

function renderCatchup() {
  const session = state.data.sessions.find(item => item.id === $('#session-select').value) || state.data.sessions[0];
  if (!session) return;
  state.missedSession = session;
  state.selectedSessionId = session.id;
  persist();
  const people = session.speakers.map(id => state.data.speakers.find(person => person.id === id)).filter(Boolean);
  const topic = session.topics.find(item => questionByTopic[item]);
  const question = questionByTopic[topic] || 'What would you like people to remember from this session?';
  $('#catchup-content').innerHTML = `<h3 class="catchup-title">${esc(session.title)}</h3><p class="catchup-summary">${esc(session.summary)}</p><div class="catchup-prompt"><span>ONE GOOD QUESTION TO ASK</span><p>${esc(question)}</p></div><div class="speaker-chips">${people.map(person => `<span class="speaker-chip"><span class="speaker-dot">${esc(initials(person.name))}</span>${esc(person.name)} · ${esc(person.organization)}</span>`).join('')}</div>`;
  $('#session-source-link').href = session.sourceUrl || state.data.source.url;
  const liveLabel = state.liveSessionIds.has(session.id) ? 'TITLE VERIFIED LIVE' : 'PUBLISHED PREVIEW';
  $('#catchup-coverage').textContent = `${liveLabel} · ${session.topics.length} LINKED TOPICS · NOT A TRANSCRIPT`;
  $('#graph-explainer').textContent = `${session.topics.slice(0, 2).join(' + ')} connect your interests to this session and its speaker.`;
  updateMatches();
}

async function updateMatches() {
  const button = $('#refresh-recs');
  button.disabled = true;
  try {
    const response = await fetch('/api/recommend', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...state.profile, attendeeId: state.attendeeId, missedSessionId: state.missedSession?.id, metSpeakerIds: [...state.met] })
    });
    if (!response.ok) throw new Error(`Recommendation request failed (${response.status})`);
    const result = await response.json();
    state.people = result.speakers || [];
    renderPeople();
    renderGraph(result);
  } catch (error) {
    $('#people-list').innerHTML = `<div class="empty-people">Could not load matches: ${esc(error.message)}. Try refreshing in a moment.</div>`;
  } finally {
    button.disabled = false;
  }
}

function renderPeople() {
  const list = $('#people-list');
  if (!state.people.length) {
    list.innerHTML = '<div class="empty-people">No new close match yet. Change your interests or mark a different session as missed and we’ll trace another path.</div>';
    return;
  }
  list.innerHTML = state.people.map((match, index) => {
    const speaker = match.speaker;
    const saved = state.saved.has(speaker.id);
    const reasonTopics = match.reasons.length ? match.reasons : match.relatedSessions.flatMap(session => state.data.sessions.find(item => item.id === session.id)?.topics || []).slice(0, 2);
    const sessionNames = match.relatedSessions.map(session => session.title);
    const reason = match.reasons.length ? (index === 0 ? 'Strongest path from your interests' : 'Connected to your interests through') : 'Speaker from the session you missed';
    return `<article class="person-card"><div class="person-avatar">${esc(initials(speaker.name))}</div><div><div class="person-name">${esc(speaker.name)}</div><div class="person-org">${esc(speaker.organization)}</div><div class="person-reason">${reason} ${sessionNames[0] ? `· “${esc(sessionNames[0])}”` : ''}</div><div class="person-tags">${[...new Set(reasonTopics)].slice(0, 3).map(topic => `<span>${esc(topic.toUpperCase())}</span>`).join('')}</div></div><div class="person-actions"><span class="match-score">PATH ${index + 1}</span><button class="meet-button ${saved ? 'saved' : ''}" data-save="${esc(speaker.id)}">${saved ? 'SAVED ✓' : 'SAVE PERSON +'}</button><button class="met-button" data-met="${esc(speaker.id)}">MET THEM</button></div></article>`;
  }).join('');
  list.querySelectorAll('[data-save]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.save;
    if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
    persist();
    renderPeople();
    renderSavedPeople();
    toast(state.saved.has(id) ? 'Saved to your people list.' : 'Removed from your people list.');
  }));
  list.querySelectorAll('[data-met]').forEach(button => button.addEventListener('click', async () => {
    const id = button.dataset.met;
    state.met.add(id);
    persist();
    await updateMatches();
    renderSavedPeople();
    toast('Marked met. They’ll leave your recommendations.');
  }));
}

function renderSavedPeople() {
  const list = $('#saved-people-list');
  const ids = [...new Set([...state.saved, ...state.met])];
  if (!ids.length) {
    list.innerHTML = '<div class="empty-people">Your list is empty. Save a speaker from your recommendations and they’ll be here when you need them.</div>';
    return;
  }
  list.innerHTML = ids.map(id => {
    const person = state.data.speakers.find(speaker => speaker.id === id);
    if (!person) return '';
    const met = state.met.has(id);
    return `<article class="saved-person"><div class="person-avatar">${esc(initials(person.name))}</div><div><b>${esc(person.name)}</b><small>${esc(person.organization)} · ${met ? 'Met' : 'Saved to meet'}</small></div><div class="saved-actions">${!met ? `<button class="meet-button" data-mark-met="${esc(id)}">MARK MET</button>` : '<span class="met-label">MET ✓</span>'}<button class="remove-saved" data-remove="${esc(id)}" aria-label="Remove ${esc(person.name)}">×</button></div></article>`;
  }).join('');
  list.querySelectorAll('[data-mark-met]').forEach(button => button.addEventListener('click', async () => {
    state.met.add(button.dataset.markMet);
    persist();
    renderSavedPeople();
    await updateMatches();
    toast('Marked met.');
  }));
  list.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.remove;
    state.saved.delete(id);
    state.met.delete(id);
    persist();
    renderSavedPeople();
    updateMatches();
    toast('Removed from your conference list.');
  }));
}

function renderGraph(result) {
  const firstSpeaker = result.speakers?.[0]?.speaker;
  const firstPath = result.speakers?.[0]?.relatedSessions?.[0];
  const firstSession = state.data.sessions.find(session => session.id === firstPath?.id) || result.recommendedSessions?.[0] || state.missedSession;
  const firstTopic = result.matchedTopics?.[0] || 'Your interests';
  const graph = $('#graph-visual');
  graph.innerHTML = `<svg class="graph-lines" viewBox="0 0 420 184" preserveAspectRatio="none" aria-hidden="true"><line class="active-edge" x1="62" y1="88" x2="145" y2="40"/><line class="active-edge" x1="62" y1="88" x2="240" y2="87"/><line x1="145" y1="40" x2="240" y2="87"/><line class="active-edge" x1="240" y1="87" x2="358" y2="143"/></svg><div class="graph-node user"><small>ATTENDEE</small>${esc(state.profile.name)}</div><div class="graph-node topic"><small>TOPIC</small>${esc(firstTopic)}</div><div class="graph-node session"><small>SESSION</small>${esc(firstSession?.title?.slice(0, 42) || 'Pick a session')}</div><div class="graph-node person"><small>SPEAKER</small>${esc(firstSpeaker?.name || 'Find a match')}</div>`;
  const connected = ['falkordb', 'sqlite-graph'].includes(state.data.graph.mode);
  $('#graph-status').classList.toggle('connected', connected);
  $('#graph-status').querySelector('span').textContent = state.data.graph.mode === 'falkordb' ? 'FALKORDB' : connected ? 'SQLITE GRAPH' : 'LOCAL GRAPH';
}

function showQuery() {
  fetch(`/api/graph-query?attendeeId=${encodeURIComponent(state.attendeeId)}`).then(response => response.json()).then(result => {
    $('#query-provider').textContent = result.graphMode === 'falkordb' ? 'FALKORDB · CYPHER' : result.graphMode === 'sqlite-graph' ? 'SQLITE · PERSISTENT GRAPH' : 'LOCAL GRAPH · PATH PREVIEW';
    $('#query-code').textContent = result.query || result.cypher;
    $('#graph-mode-detail').textContent = `${result.detail || state.data.graph.detail}${result.rows ? ` ${result.rows} graph paths returned.` : ''}`;
    $('#query-dialog').showModal();
  }).catch(error => toast(`Could not load the graph query: ${error.message}`));
}

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.classList.remove('show'), 2600);
}

async function refreshBrightData() {
  const button = $('#refresh-data');
  const result = $('#refresh-result');
  button.disabled = true;
  result.textContent = 'Fetching GitHub’s official 2026 talk roundup through Bright Data…';
  try {
    const response = await fetch('/api/refresh', { method: 'POST' });
    const data = await response.json();
    result.textContent = data.message;
    if (data.ok) {
      state.liveSessionIds = new Set(data.sampleMatches || []);
      renderSelect();
      $('#data-state-label').textContent = data.foundSessions > 0 ? `LIVE · ${data.foundSessions} MATCHED` : 'CATALOG REACHED';
      $('.state-dot').classList.add('live');
      toast(data.foundSessions > 0 ? `Bright Data matched ${data.foundSessions} sessions.` : 'Bright Data reached the live catalog. The sourced preview is still active.');
    } else if (data.configured) {
      toast(data.message);
    }
  } catch (error) {
    result.textContent = `Bright Data request failed: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

async function boot() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error(`Conference data unavailable (${response.status})`);
  state.data = await response.json();
  $('#top-event-name').textContent = state.data.event.name.toUpperCase();
  $('#rail-event-name').textContent = state.data.event.name.replace('2026', '’26');
  $('#event-date').textContent = state.data.event.dates.toUpperCase();
  $('#event-location').textContent = state.data.event.location.toUpperCase();
  $('#source-link').href = state.data.source.url;
  $('#dialog-source-link').href = state.data.source.url;
  $('#catalog-link').href = catalogUrl;
  $('#profile-name').value = state.profile.name;
  $('#profile-interests').value = state.profile.interests;
  $('#saved-count').textContent = String(state.saved.size);
  $('#graph-mode-detail').textContent = state.data.graph.detail;
  if (state.data.lastRefresh?.foundSessionIds) state.liveSessionIds = new Set(state.data.lastRefresh.foundSessionIds);
  if (state.data.lastRefresh?.foundSessions) {
    $('#refresh-result').textContent = `Last live Bright Data fetch verified ${state.data.lastRefresh.foundSessions} exact titles and saved ${state.data.lastRefresh.extractedRecords || 0} source excerpts to SQLite.`;
  }
  if (state.data.lastRefresh?.foundSessions) {
    $('#data-state-label').textContent = `LIVE · ${state.data.lastRefresh.foundSessions} MATCHED`;
    $('.state-dot').classList.add('live');
  }
  if (state.data.graph.mode === 'falkordb') $('#data-state-label').textContent = 'FALKORDB CONNECTED';
  else if (state.data.graph.mode === 'sqlite-graph' && !state.data.lastRefresh?.foundSessions) $('#data-state-label').textContent = 'SQLITE GRAPH · READY';
  if (['falkordb', 'sqlite-graph'].includes(state.data.graph.mode)) $('.state-dot').classList.add('live');
  renderSavedPeople();
  renderSelect();
}

$('#session-select').addEventListener('change', () => { state.selectedSessionId = $('#session-select').value; renderCatchup(); });
$('#save-profile').addEventListener('click', async () => {
  state.profile = { name: $('#profile-name').value.trim() || 'You', interests: $('#profile-interests').value.trim() };
  persist();
  await updateMatches();
  toast('Your profile is saved on this device. Matches now follow your graph paths.');
});
$('#refresh-recs').addEventListener('click', updateMatches);
$('#refresh-data').addEventListener('click', refreshBrightData);
$('#show-query').addEventListener('click', showQuery);
$('#close-query').addEventListener('click', () => $('#query-dialog').close());
$('#close-source').addEventListener('click', () => $('#source-dialog').close());
$('#source-open').addEventListener('click', () => $('#source-dialog').showModal());
$('#saved-nav').addEventListener('click', () => { renderSavedPeople(); $('#saved-dialog').showModal(); });
$('#close-saved').addEventListener('click', () => $('#saved-dialog').close());
boot().catch(error => { document.body.innerHTML = `<pre style="padding:24px">Could not start Patchwork: ${esc(error.message)}</pre>`; });
