# Patchwork — demo script

Everything below is measured against the running app, not estimated.

---

## Pre-flight (before you hit record)

```sh
nvm use                 # MUST say 23.11.0 — on Node 20 FalkorDB silently will not load
npm start
```

Wait ~25s, then confirm the graph is real:

```sh
curl -s localhost:4173/api/bootstrap | grep -o '"mode":"[^"]*"'
# REQUIRED OUTPUT:  "mode":"falkordb"
```

If it says `sqlite-graph`, **stop** — the startup log now tells you exactly why.
Do not record until this reads `falkordb`.

```sh
npm run prewarm         # ~20 min. Fills the profile cache so nothing waits on LinkedIn.
```

**Clear site data for `127.0.0.1:4173`** right before recording. Your best moment
depends on "Who else should you meet" appearing live, which only happens if the
saved list starts empty.

Window: ~1440×900. Anything narrower collapses the sidebar and you lose the
Match map from frame.

---

## The run (target ~2 minutes)

### 1 · Open cold (10s)

Don't rush past this. The page is populated before you touch anything: topic
chips, the session catalog, the Match map showing the *shape* of the query with
nothing filled in.

> "Patchwork answers one question: at a 2,000-person conference, who are the
> three people I should actually talk to, and what do I say?"

### 2 · Search (5–25s — varies, see below)

Click the **Open source** chip. Live Bright Data fetch runs.

> "That just fetched GitHub's public speaker and schedule pages through Bright
> Data. Every speaker here was confirmed by name *and* session title in the
> pages that came back — nothing is from a cached list."

Point at the status line: it reports *"2 of 4 graph candidates confirmed."*

### 3 · The graph does real work (25s) ← **your strongest beat**

Click **Save speaker** on Angie Jones. "Who else should you meet" appears.

> "I've saved one person. Now the graph walks out four hops — from her, to her
> session, to a topic, to *another* session, to the person presenting that one."

Read one path aloud off the card:

> "Angie Jones → Community building + Open source → Lessons from building tech in
> a low-connectivity community → Alex Junior Antwi. That's not a keyword match.
> That's a path, and it's on screen."

### 4 · Show the query (20s)

Click **Show the 4-hop query**.

> "This is the actual Cypher, running on FalkorDB."

The footer reads: *Connected to FalkorDB graph "conference_companion"; graph
query verified 56 nodes (1 Event, 17 Session, 2 Source, 26 Speaker, 10 Topic).*
Let that sit on screen for a beat — it's the proof the graph is real.

### 5 · Verified profile (10s)

On Angie Jones, click **Find verified profile** → resolves in **0.7s** (cached)
to `linkedin.com/in/angiejones`.

> "A plain script gets HTTP 999 from LinkedIn after nine lookups. We need
> twenty-six. And we never trust what comes back — the profile has to carry the
> speaker's name *and* the employer GitHub listed, or we show nothing."

**Only click these three — they are confirmed verified:**

| speaker | resolves to |
|---|---|
| Angie Jones | Angie Jones — Agentic AI Foundation |
| Alejandro Carderera | Alejandro Carderera de Diego — GitHub |
| Alexander Lichter | Alexander Lichter — Cloudflare |

Re-check the list after prewarm finishes:

```sh
sqlite3 data/patchwork.sqlite \
  "SELECT json_extract(value,'\$.speakerId') FROM app_metadata
   WHERE key LIKE 'enrich:%' AND json_extract(value,'\$.verified')=1;"
```

### 6 · Close (15s)

Mark someone met → they leave your recommendations, the counts update, undo is
offered.

> "Met someone? They drop out of your recommendations and the graph re-walks
> around them."

---

## Optional: the strongest honesty beat

Alexander Lichter's card says **VoidZero** (from GitHub's October article). His
verified profile says **Cloudflare**. He changed jobs.

> "GitHub's article is three weeks old and says VoidZero. The live profile says
> Cloudflare. That's the whole argument for fetching live instead of shipping a
> static list."

Worth 15 seconds if you have them.

---

## Do not claim

- **Don't say Bright Data is how you reach the GitHub articles.** A judge can
  `curl` them and get 200 with full content in one second. Bright Data's real
  job here is LinkedIn at volume — lead with that.
- **Don't claim you ingest the attendee session catalog.** It's RainFocus behind
  attendee login; Bright Data returns nav chrome only. If asked: *"We evaluated
  it and chose not to scrape logged-in content."* That's a better answer than a
  broken feature.
- **Don't call the session summaries transcripts.** They're from published
  descriptions, and the UI already says so.

---

## If something breaks mid-take

| what happens | what to do |
|---|---|
| Search takes 20s+ | Keep talking over it — narrate what Bright Data is doing. It's a real network call and the variance is 5–25s. Cut it in post. |
| Badge says "SQLite graph" | Stop. You're on Node 20 or the server restarted without `.env`. Re-run pre-flight. |
| "Could not verify — not guessing" | **Leave it.** That's the data-quality story, not a bug. Say: "it refuses to show a profile it can't confirm." |
| No speakers returned | Click a different topic chip. Live verification depends on who GitHub lists that day. |

---

## One-line pitch per track

**FalkorDB** — "The recommendation is a four-hop Cypher traversal over a
persisted graph, and every answer shows the path it came from."

**Bright Data** — "A plain script gets blocked by LinkedIn after nine lookups.
We need twenty-six. And nothing it returns is trusted until the graph
corroborates it."
