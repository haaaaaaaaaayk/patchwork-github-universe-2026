const $ = selector => document.querySelector(selector);
const STORAGE_KEY = 'patchwork:github-universe-2026';
const savedState = (() => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); } catch { return {}; } })();
const state = {
  data: null,
  profile: savedState.profile || { name: 'You', interests: '' },
  selectedSessionId: savedState.selectedSessionId || '',
  liveSessionIds: new Set(),
  missedSession: null,
  lastLiveResult: null,
  // The query and topics behind the results currently on screen. Empty until a
  // search runs, so nothing in the UI can claim a match the attendee never made.
  lastQuery: '',
  matchedTopics: [],
  // Set when a previous visit searched but the live results were not carried over.
  staleQuery: savedState.profile?.interests || '',
  people: [],
  saved: new Set(savedState.saved || []),
  met: new Set(savedState.met || []),
  suggestions: []
};

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const displayText = value => String(value ?? '').replace(/\s*[—–]\s*/g, ': ').replace(/\s+/g, ' ').trim();
const catalogUrl = 'https://reg.githubuniverse.com/flow/github/universe26/attendee-portal/page/sessioncatalog';
const scheduleArticleUrl = 'https://github.blog/news-insights/company-news/your-guide-to-github-universe-2026-is-here-the-schedule-just-launched/';
const questionByTopic = {
  'Agent harnesses': 'What did you learn about deciding when an agent should keep working versus hand control back?',
  'MCP security': 'Where do you draw the human approval boundary when an agent can act through MCP?',
  'Agent authorization': 'How do you make permissions specific enough to be safe without slowing useful work?',
  'Model evaluation': 'Which evaluation signal most changed how you choose or improve a model?',
  'AI adoption': 'What helped people move from trying AI tools to trusting them in everyday work?',
  'Open source': 'What should open-source communities change as AI-generated contributions grow?',
  'Developer workflows': 'Which part of the developer workflow became easiest to delegate, and what stayed human?',
  'Community building': 'How do you keep a community healthy when contribution volume changes quickly?',
  'Design': 'What has design had to take back from engineering now that code is cheap to produce?',
  'Creative coding': 'What does sketching in code still teach you that describing the idea to a model does not?'
};

// Shown when a session has no topic with a tailored question above.
const fallbackQuestion = 'What would you like people to remember from this session?';

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    profile: state.profile,
    selectedSessionId: state.selectedSessionId,
    saved: [...state.saved],
    met: [...state.met]
  }));
  renderSavedBadge();
}

// The badge counts people still to meet, which is what the dialog leads with.
function renderSavedBadge() {
  const toMeet = [...state.saved].filter(id => !state.met.has(id)).length;
  const met = state.met.size;
  $('#saved-count').textContent = String(toMeet);
  $('#saved-nav').setAttribute('aria-label',
    `Your list: ${toMeet} speaker${toMeet === 1 ? '' : 's'} to meet, ${met} already met`);
}

function renderSelect() {
  const select = $('#session-select');
  select.innerHTML = state.data.sessions.map(session => {
    const names = session.speakers
      .map(id => state.data.speakers.find(person => person.id === id)?.name)
      .filter(Boolean);
    const who = names.length ? ` — ${names.join(', ')}` : '';
    return `<option value="${esc(session.id)}">${esc(displayText(session.title))}${esc(who)}</option>`;
  }).join('');
  $('#session-count').textContent = `${state.data.sessions.length} sessions`;
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
  // Only topics the last search actually matched count as the attendee's own.
  const yourTopics = session.topics.filter(item => state.matchedTopics.includes(item));
  // The relevance line and the question must describe the same topic, so pick once.
  const topic = yourTopics.find(item => questionByTopic[item])
    || yourTopics[0]
    || session.topics.find(item => questionByTopic[item])
    || session.topics[0];
  const question = questionByTopic[topic] || fallbackQuestion;
  const isYours = yourTopics.includes(topic);
  const relevanceLabel = isYours ? 'Why this matches your search' : 'What this session covers';
  const takeaway = isYours
    ? `This session covers ${topic}, which your “${state.lastQuery}” search matched. Listen for how the speakers frame it.`
    : `You have not searched for this one yet. It covers ${session.topics.slice(0, 2).join(' and ')} — a good opening if that is near your work.`;
  $('#catchup-content').innerHTML = `<h3 class="catchup-title">${esc(displayText(session.title))}</h3><p class="catchup-summary">${esc(displayText(session.summary))}</p><div class="recap-relevance ${isYours ? 'is-match' : ''}"><b>${esc(relevanceLabel)}</b><p>${esc(takeaway)}</p></div><div class="catchup-prompt"><span>Question to ask about ${esc(topic)}</span><p>${esc(question)}</p></div><div class="speaker-chips">${people.map(person => `<span class="speaker-chip">${esc(person.name)}, ${esc(person.organization)}</span>`).join('')}</div>`;
  $('#session-source-link').href = session.sourceUrl || state.data.source.url;
  const coverage = $('#catchup-coverage');
  const seenLive = state.liveSessionIds.has(session.id);
  coverage.textContent = seenLive ? 'Title confirmed in the live source' : 'From the published description';
  coverage.title = seenLive
    ? 'This exact session title was found in the official article during the last Bright Data fetch.'
    : 'Summarized from the published schedule. Patchwork never has session transcripts.';
}

function updateMatches() {
  if (!state.lastLiveResult) return;
  state.people = state.lastLiveResult.speakers.filter(match => !state.met.has(match.speaker.id));
  renderPeople();
  renderGraph({ ...state.lastLiveResult, speakers: state.people });
  renderResultCounts();
}

// Every counter that describes the visible list, updated from one place so they
// cannot drift apart when a speaker is marked met.
function renderResultCounts() {
  const shown = state.people.length;
  const total = state.lastLiveResult?.speakers.length ?? 0;
  const hidden = Math.max(0, total - shown);
  $('#live-result-count').textContent = !state.lastLiveResult
    ? 'Search to see live matches'
    : `${shown} verified${hidden ? ` · ${hidden} marked met` : ''}`;
  $('#data-state-label').textContent = !state.lastLiveResult
    ? (state.data.brightDataConfigured ? 'Bright Data ready' : 'Bright Data setup needed')
    : `Bright Data live · ${shown} match${shown === 1 ? '' : 'es'}`;
}

// One place for every "nothing to show" case, so the main column is never blank.
function emptyStateHtml() {
  const chips = (state.suggestions.length ? state.suggestions : state.data?.topics || [])
    .slice(0, 6)
    .map(topic => `<button type="button" class="topic-chip" data-topic="${esc(topic)}">${esc(topic)}</button>`)
    .join('');
  if (state.lastLiveResult && state.lastLiveResult.speakers.length && !state.people.length) {
    return `<b>Everyone matching “${esc(state.lastQuery)}” is marked met.</b><p>Remove someone from your list, or search another topic.</p><div class="topic-chips">${chips}</div>`;
  }
  // The graph had candidates but the live pages did not name them this time, which
  // is a different problem from a topic the catalog cannot match at all.
  if (state.lastLiveResult && state.lastLiveResult.graphCandidates) {
    return `<b>${state.lastLiveResult.graphCandidates} speaker${state.lastLiveResult.graphCandidates === 1 ? '' : 's'} match “${esc(state.lastQuery)}”, but today’s fetch could not confirm them.</b><p>Patchwork only shows speakers it can find by name in the live GitHub pages, and those pages do not list every session. Try a nearby topic:</p><div class="topic-chips">${chips}</div>`;
  }
  if (state.lastLiveResult) {
    return `<b>No speaker matched “${esc(state.lastQuery)}”.</b><p>Patchwork only matches the ${state.data?.topics?.length || 0} topics in this catalog. Try one of these:</p><div class="topic-chips">${chips}</div>`;
  }
  if (state.staleQuery) {
    return `<b>You last searched “${esc(state.staleQuery)}”.</b><p>Results are fetched live, so they are not kept between visits.</p><button type="button" class="save-button" data-rerun>Search “${esc(state.staleQuery)}” again</button>`;
  }
  return `<b>Pick a topic to meet people through.</b><p>Patchwork fetches GitHub’s public speaker and schedule pages, then traces speakers back to the sessions they are presenting.</p><div class="topic-chips">${chips}</div>`;
}

function renderPeople() {
  const list = $('#people-list');
  if (!state.people.length) {
    list.innerHTML = `<div class="empty-people">${emptyStateHtml()}</div>`;
    list.querySelector('[data-rerun]')?.addEventListener('click', () => refreshBrightData());
    list.querySelectorAll('[data-topic]').forEach(button => button.addEventListener('click', () => {
      $('#speaker-query').value = button.dataset.topic;
      refreshBrightData();
    }));
    return;
  }
  list.innerHTML = state.people.map((match, index) => {
    const speaker = match.speaker;
    const saved = state.saved.has(speaker.id);
    const reasonTopics = match.reasons.length ? match.reasons : match.relatedSessions.flatMap(session => state.data.sessions.find(item => item.id === session.id)?.topics || []).slice(0, 2);
    const sessionNames = match.relatedSessions.map(session => displayText(session.title));
    // Describe the actual path count rather than the row's position in the list.
    const topicCount = new Set(reasonTopics).size;
    const sessionCount = match.relatedSessions.length;
    const reason = !match.reasons.length
      ? 'Speaker from a related session'
      : topicCount > 1
        ? `Matches ${topicCount} of your topics`
        : sessionCount > 1
          ? `Presenting ${sessionCount} sessions on this topic`
          : 'Direct topic match';
    const sharedTopic = reasonTopics[0] || state.missedSession?.topics?.[0] || 'your work';
    const sessionName = sessionNames[0] || state.missedSession?.title || 'the conference';
    const linkedinSearch = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${speaker.name} ${speaker.organization}`)}`;
    const introQuestion = questionByTopic[sharedTopic] || 'What was the most surprising thing you learned putting it together?';
    const intro = `Hi ${speaker.name.split(/\s+/)[0]} — I came across your Universe session, “${sessionName},” and ${sharedTopic.toLowerCase()} is close to what I work on. ${introQuestion} Would love to hear your take.`;
    const sourceUrl = match.relatedSessions[0]?.sourceUrl || state.data.event.url;
    return `<article class="person-card"><div><div class="person-name">${esc(speaker.name)}</div><div class="person-org">${esc(speaker.organization)}</div><div class="person-reason">${reason}${sessionNames[0] ? `. Session: “${esc(sessionNames[0])}”` : ''}</div><div class="person-tags">${[...new Set(reasonTopics)].slice(0, 3).map(topic => `<span>${esc(topic)}</span>`).join('')}</div><div class="person-network"><a href="${esc(linkedinSearch)}" target="_blank" rel="noreferrer">Find LinkedIn profile</a><a href="${esc(sourceUrl)}" target="_blank" rel="noreferrer">Official session</a><button type="button" data-copy-intro="${esc(speaker.id)}" data-intro="${esc(intro)}">Copy intro</button></div></div><div class="person-actions"><button class="meet-button ${saved ? 'saved' : ''}" data-save="${esc(speaker.id)}">${saved ? 'Saved' : 'Save speaker'}</button><button class="met-button" data-met="${esc(speaker.id)}">Mark met</button></div></article>`;
  }).join('');
  list.querySelectorAll('[data-save]').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.save;
    if (state.saved.has(id)) state.saved.delete(id); else state.saved.add(id);
    persist();
    renderPeople();
    renderSavedPeople();
    toast(state.saved.has(id) ? 'Saved to your speaker list.' : 'Removed from your speaker list.');
  }));
  list.querySelectorAll('[data-met]').forEach(button => button.addEventListener('click', async () => {
    const id = button.dataset.met;
    const name = state.data.speakers.find(person => person.id === id)?.name || 'They';
    await markMet(id);
    toast(`${name} marked met and removed from your matches.`, { label: 'Undo', run: () => unmarkMet(id) });
  }));
  list.querySelectorAll('[data-copy-intro]').forEach(button => button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.intro);
      toast('Intro copied. Personalize it before sending.');
    } catch {
      toast('Clipboard unavailable. Open LinkedIn and use the question above to start naturally.');
    }
  }));
}

async function markMet(id) {
  state.met.add(id);
  persist();
  await updateMatches();
  renderSavedPeople();
}

async function unmarkMet(id) {
  state.met.delete(id);
  persist();
  await updateMatches();
  renderSavedPeople();
  const name = state.data.speakers.find(person => person.id === id)?.name || 'They';
  toast(`${name} is back in your matches.`);
}

function renderSavedPeople() {
  const list = $('#saved-people-list');
  const toMeet = [...state.saved].filter(id => !state.met.has(id));
  const met = [...state.met];
  if (!toMeet.length && !met.length) {
    list.innerHTML = '<div class="empty-people"><b>Your list is empty.</b><p>Save a speaker from your matches and they’ll be here when you need them.</p></div>';
    return;
  }
  const row = id => {
    const person = state.data.speakers.find(speaker => speaker.id === id);
    if (!person) return '';
    const isMet = state.met.has(id);
    return `<article class="saved-person"><div><b>${esc(person.name)}</b><small>${esc(person.organization)}</small></div><div class="saved-actions">${isMet
      ? `<button class="met-button" data-unmark-met="${esc(id)}">Not yet met</button>`
      : `<button class="meet-button" data-mark-met="${esc(id)}">Mark met</button>`}<button class="remove-saved" data-remove="${esc(id)}" aria-label="Remove ${esc(person.name)} from your list">Remove</button></div></article>`;
  };
  const group = (label, ids) => ids.length
    ? `<div class="saved-group"><h4>${label} (${ids.length})</h4>${ids.map(row).join('')}</div>`
    : '';
  list.innerHTML = group('To meet', toMeet) + group('Already met', met);
  list.querySelectorAll('[data-mark-met]').forEach(button => button.addEventListener('click', async () => {
    const id = button.dataset.markMet;
    const name = state.data.speakers.find(person => person.id === id)?.name || 'They';
    await markMet(id);
    toast(`${name} marked met.`, { label: 'Undo', run: () => unmarkMet(id) });
  }));
  list.querySelectorAll('[data-unmark-met]').forEach(button =>
    button.addEventListener('click', () => unmarkMet(button.dataset.unmarkMet)));
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

// Before any search there is no path to draw, so show the shape of the query
// rather than inventing a speaker the attendee never asked for.
function renderGraphPlaceholder() {
  $('#graph-visual').innerHTML = `<svg class="graph-lines" viewBox="0 0 420 184" preserveAspectRatio="none" aria-hidden="true"><line x1="62" y1="88" x2="145" y2="40"/><line x1="62" y1="88" x2="240" y2="87"/><line x1="145" y1="40" x2="240" y2="87"/><line x1="240" y1="87" x2="358" y2="143"/></svg><div class="graph-node user is-empty"><small>Your search</small>—</div><div class="graph-node topic is-empty"><small>Topic</small>—</div><div class="graph-node session is-empty"><small>Session</small>—</div><div class="graph-node person is-empty"><small>Speaker</small>—</div>`;
  $('#graph-explainer').textContent = 'Search a topic and Patchwork traces it through the catalog: topic → session → the speaker presenting it. The path you get is the one shown here.';
  $('#show-query').disabled = false;
  setGraphBadge();
}

function setGraphBadge() {
  const connected = ['falkordb', 'sqlite-graph'].includes(state.data.graph.mode);
  $('#graph-status').classList.toggle('connected', connected);
  $('#graph-status').querySelector('span').textContent = state.data.graph.mode === 'falkordb' ? 'FalkorDB' : connected ? 'SQLite graph' : 'Local graph';
}

function renderGraph(result) {
  const firstSpeaker = result.speakers?.[0]?.speaker;
  const firstPath = result.speakers?.[0]?.relatedSessions?.[0];
  const firstSession = state.data.sessions.find(session => session.id === firstPath?.id) || result.recommendedSessions?.[0] || state.missedSession;
  const firstTopic = result.speakers?.[0]?.reasons?.[0]
    || firstSession?.topics?.find(topic => result.matchedTopics?.includes(topic))
    || result.matchedTopics?.[0]
    || 'Your interests';
  const graph = $('#graph-visual');
  const searchLabel = state.lastQuery || result.interests || '—';
  graph.innerHTML = `<svg class="graph-lines" viewBox="0 0 420 184" preserveAspectRatio="none" aria-hidden="true"><line class="active-edge" x1="62" y1="88" x2="145" y2="40"/><line class="active-edge" x1="62" y1="88" x2="240" y2="87"/><line x1="145" y1="40" x2="240" y2="87"/><line class="active-edge" x1="240" y1="87" x2="358" y2="143"/></svg><div class="graph-node user"><small>Your search</small>${esc(searchLabel)}</div><div class="graph-node topic"><small>Graph topic</small>${esc(firstTopic)}</div><div class="graph-node session"><small>Session</small>${esc(displayText(firstSession?.title?.slice(0, 42) || 'No related session'))}</div><div class="graph-node person"><small>Speaker</small>${esc(firstSpeaker?.name || 'No match')}</div>`;
  $('#graph-explainer').textContent = firstSpeaker
    ? `${firstSpeaker.name} is connected to “${displayText(firstSession?.title || 'this session')}” through the ${firstTopic} topic path.`
    : `No speaker path was found for “${searchLabel}”. Try one of the catalog topics listed on the left.`;
  setGraphBadge();
  $('#show-query').disabled = false;
}

function showQuery(openDialog = true) {
  const query = $('#speaker-query').value.trim();
  if (!query) {
    $('#live-search-status').textContent = 'Add a topic above before running the graph query.';
    $('#speaker-query').focus();
    return;
  }
  state.profile.interests = query;
  state.lastQuery = query;
  persist();
  const button = $('#show-query');
  button.disabled = true;
  button.textContent = 'Running graph query…';
  fetch('/api/graph-query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ interests: query, metSpeakerIds: [...state.met] })
  }).then(response => response.json()).then(result => {
    if (!result || result.error) throw new Error(result?.error || 'Graph query failed.');
    renderGraph(result);
    $('#query-provider').textContent = result.graphMode === 'falkordb' ? 'FalkorDB graph' : result.graphMode === 'sqlite-graph' ? 'SQLite graph' : 'Local graph';
    $('#query-code').textContent = result.query || result.cypher || 'No graph query is available for this search.';
    state.matchedTopics = result.matchedTopics || [];
    state.suggestions = result.suggestions || state.suggestions;
    const paths = result.speakers?.length
      ? `Matching paths:\n${result.speakers.map(match => `${match.reasons.join(', ')} → ${match.relatedSessions.map(session => session.title).join('; ')} → ${match.speaker.name}`).join('\n')}`
      : `No speaker path matches “${query}”.\nCatalog topics: ${(result.suggestions || state.data.topics).join(', ')}`;
    $('#graph-results').textContent = paths;
    // The card list shows fewer people than the graph returns: it keeps only the
    // top matches that the live fetch could confirm. Say so rather than leave the
    // two numbers looking like a bug.
    const shown = state.people.length;
    const reconcile = state.lastLiveResult && result.rows > shown
      ? ` The list on the left shows ${shown}: Patchwork keeps the strongest matches and only those it could confirm by name in the live pages.`
      : '';
    $('#graph-mode-detail').textContent = `${result.detail || state.data.graph.detail} ${result.rows ?? 0} graph path${result.rows === 1 ? '' : 's'} returned for “${query}”.${reconcile}`;
    if (openDialog) $('#query-dialog').showModal();
  }).catch(error => {
    $('#live-search-status').textContent = `Graph query failed: ${error.message}`;
    toast(`Could not run the graph query: ${error.message}`);
  }).finally(() => {
    button.disabled = false;
    button.textContent = 'Run graph query';
  });
}

function toast(message, action) {
  const element = $('#toast');
  element.innerHTML = `<span>${esc(message)}</span>`;
  if (action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'toast-action';
    button.textContent = action.label;
    button.addEventListener('click', () => {
      element.classList.remove('show');
      clearTimeout(toast.timer);
      action.run();
    });
    element.append(button);
  }
  element.classList.add('show');
  element.classList.toggle('has-action', Boolean(action));
  clearTimeout(toast.timer);
  // An undoable action stays up longer so the offer is actually reachable.
  toast.timer = setTimeout(() => element.classList.remove('show'), action ? 7000 : 2600);
}

async function refreshBrightData(event) {
  event?.preventDefault();
  const button = $('#refresh-data');
  const result = $('#refresh-result');
  const query = $('#speaker-query').value.trim();
  if (!query) {
    const examples = (state.suggestions.length ? state.suggestions : state.data?.topics || []).slice(0, 3).join(', ');
    $('#live-search-status').textContent = `Enter a topic${examples ? ` such as ${examples}` : ''}.`;
    $('#speaker-query').focus();
    return;
  }
  state.profile.interests = query;
  state.lastQuery = query;
  state.staleQuery = '';
  persist();
  button.disabled = true;
  button.textContent = 'Fetching live…';
  $('#live-search-status').textContent = `Bright Data is fetching public GitHub Universe sources for “${query}”…`;
  $('#people-list').innerHTML = '<div class="empty-people">Checking the official speaker page and schedule now…</div>';
  try {
    const response = await fetch('/api/speakers/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, metSpeakerIds: [...state.met] })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Search failed (${response.status})`);
    if (!data.ok) throw new Error(data.message || 'Live search is unavailable.');
    state.people = data.speakers || [];
    state.lastLiveResult = data;
    state.matchedTopics = data.matchedTopics || [];
    state.suggestions = data.suggestions || state.suggestions;
    document.body.classList.add('has-results');
    renderPeople();
    renderGraph(data);
    renderResultCounts();
    renderCatchup();
    $('#live-search-status').textContent = data.message;
    const fetched = data.sources.filter(source => source.ok).length;
    result.textContent = data.skippedFetch
      ? 'No fetch made — no catalog topic matched that search.'
      : `${fetched} page${fetched === 1 ? '' : 's'} fetched · ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    toast(state.people.length
      ? `Found ${state.people.length} public speaker${state.people.length === 1 ? '' : 's'} for ${query}.`
      : `No match for “${query}”. Pick one of the catalog topics.`);
    if (!state.people.length) $('#speaker-query').select();
  } catch (error) {
    state.people = [];
    state.lastLiveResult = null;
    renderPeople();
    $('#live-result-count').textContent = 'Search unavailable';
    $('#live-search-status').textContent = error.message;
    result.textContent = `Live fetch failed: ${error.message}`;
  } finally {
    button.disabled = false;
    button.textContent = 'Fetch and find';
  }
}

async function boot() {
  const response = await fetch('/api/bootstrap');
  if (!response.ok) throw new Error(`Conference data unavailable (${response.status})`);
  state.data = await response.json();
  $('#event-date').textContent = String(state.data.event.dates).replace(/(\w+ \d+)[–—](\d+,)/, '$1 and $2');
  $('#event-location').textContent = state.data.event.location;
  $('#source-link').href = state.data.event.url;
  $('#dialog-source-link').href = state.data.event.url;
  $('#catalog-link').href = scheduleArticleUrl;
  renderSavedBadge();
  $('#graph-mode-detail').textContent = state.data.graph.detail;
  if (state.data.lastRefresh?.foundSessionIds) state.liveSessionIds = new Set(state.data.lastRefresh.foundSessionIds);
  $('#refresh-result').textContent = 'No live fetch yet.';
  state.suggestions = state.data.topics || [];
  // Keep the previous query in the box, but do not pretend its results are still
  // on screen: live results are not cached between visits.
  $('#speaker-query').value = state.staleQuery;
  renderSavedPeople();
  renderSelect();
  renderPeople();
  renderResultCounts();
  renderGraphPlaceholder();
  $('#graph-status').querySelector('span').textContent = state.data.graph.mode === 'falkordb' ? 'FalkorDB ready' : 'SQLite graph ready';
}

$('#session-select').addEventListener('change', () => { state.selectedSessionId = $('#session-select').value; renderCatchup(); });
$('#speaker-search-form').addEventListener('submit', refreshBrightData);
$('#show-query').addEventListener('click', showQuery);
// The guide item returns to the search rather than sitting there inert.
$('#guide-nav').addEventListener('click', () => {
  $('#speaker-query').focus();
  $('#speaker-query').scrollIntoView({ block: 'center', behavior: 'smooth' });
});
$('#close-query').addEventListener('click', () => $('#query-dialog').close());
$('#close-source').addEventListener('click', () => $('#source-dialog').close());
$('#source-open').addEventListener('click', () => $('#source-dialog').showModal());
$('#saved-nav').addEventListener('click', () => { renderSavedPeople(); $('#saved-dialog').showModal(); });
$('#close-saved').addEventListener('click', () => $('#saved-dialog').close());
boot().catch(error => { document.body.innerHTML = `<pre style="padding:24px">Could not start Patchwork: ${esc(error.message)}</pre>`; });
