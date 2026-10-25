# Patchwork — submission answers

---

## Live demo or deployment

```
https://github.com/haaaaaaaaaayk/patchwork-github-universe-2026
```

Patchwork runs locally (`nvm use && npm start` → `http://127.0.0.1:4173`) against a
live FalkorDB Cloud instance and the Bright Data Web Unlocker. The repo includes a
recorded walkthrough (`patchwork-demo.mp4`) and a demo run-book (`DEMO.md`).

---

## What conference problem are you patching?

GitHub Universe runs ~17 technical sessions across two days for thousands of
attendees. The schedule tells you what is on. It does not tell you the only thing
that actually matters once you are there: **which three people in this building are
worth finding, and what do you say when you find them.**

Attendees fall back on scanning a session list, recognising a name, and hoping. The
people most worth meeting are usually the ones presenting the session *next to* the
one you attended — on the same topic, from a different angle — and nothing in a
conference app surfaces them, because a flat list cannot express "adjacent".

That adjacency is a graph problem. Patchwork treats it as one.

---

## What did you build and how does it work?

Patchwork is a conference companion that turns a topic you care about into a short
list of specific people, each with the path that produced them and an opening line
you can actually send.

1. **You search a topic.** Patchwork matches it against the 10 topics in the
   conference graph. If nothing matches, it says so in 0.1s and spends no fetches.
2. **Bright Data fetches the public GitHub Universe sources live.** A speaker only
   appears if their name *and* their session title are found in what came back.
3. **FalkorDB answers the recommendation.** A two-hop query
   (topic → session → speaker) powers search. A **four-hop** query powers the real
   feature: save one person and Patchwork walks out to everyone presenting on the
   topics they share.
4. **Every answer shows its path.** Each card prints the traversal in plain English,
   and a dialog shows the literal Cypher, the bound parameters and every matching
   path.
5. **Profiles are verified, never guessed.** Bright Data unlocks the LinkedIn
   profile; Patchwork refuses to display it unless the page corroborates both the
   speaker's name and the employer GitHub published.
6. **Your list is shared state in the graph.** Mark someone met and they leave your
   recommendations — the four-hop query re-walks around them.

Stack: Node 22+, no framework, no build step. FalkorDB for the graph, a persisted
SQLite graph as a verified fallback, Bright Data Web Unlocker for live sources.

---

## How did you use FalkorDB and what problems did you solve using it?

### FalkorDB does real work — the recommendation *is* a traversal

The graph holds the conference as a graph, not as rows:

```
56 nodes     1 Event · 17 Session · 26 Speaker · 10 Topic · 2 Source
109 edges    48 COVERS · 27 PRESENTS · 17 HAS_SESSION · 17 SOURCED_FROM
```

Verified at startup by an actual graph query, and the node counts are printed in
the UI — not asserted in a README.

**Two-hop (search):**

```cypher
UNWIND $topics AS topicName
MATCH (t:Topic {name:topicName})<-[:COVERS]-(s:Session)-[:PRESENTS]->(p:Speaker)
WHERE NOT p.id IN $met
RETURN p.id, p.name, p.organization,
       collect(DISTINCT t.name) AS reasons,
       count(DISTINCT t) AS pathCount
ORDER BY pathCount DESC
```

**Four-hop — "who else should I meet", the feature a flat list cannot produce:**

```cypher
UNWIND $saved AS savedId
MATCH (anchor:Speaker {id:savedId})<-[:PRESENTS]-(s1:Session)
      -[:COVERS]->(t:Topic)<-[:COVERS]-(s2:Session)-[:PRESENTS]->(other:Speaker)
WHERE NOT other.id IN $exclude AND s1 <> s2
RETURN other.id, other.name, other.organization,
       collect(DISTINCT t.name)      AS sharedTopics,
       collect(DISTINCT anchor.name) AS viaSpeakers,
       count(DISTINCT t)             AS strength
ORDER BY strength DESC LIMIT 6
```

Ranked by **how many topics two people genuinely share** — a graph property — not
by string similarity.

### Shared state

The attendee's saved and met lists are parameters on every traversal. Marking
someone met removes them from the result set *and* changes which four-hop paths
exist for everyone still on the list. State mutates the graph walk, live.

Speaker nodes are also written back to: a verified LinkedIn URL, headline and
timestamp are set on the node (`SET p.linkedinUrl=$url, p.linkedinVerifiedAt=$at`),
so verification compounds across sessions instead of being recomputed.

### Showing the path

This is the part we care most about. Every card renders its own traversal:

> **Angie Jones** → Community building + Open source → *Lessons from building tech
> in a low-connectivity community* → **Alex Junior Antwi**

And "Show the 4-hop query" opens the literal Cypher, the bound parameters, all six
matching paths, and the startup verification line. A judge can read the query, read
the paths, and check that the answer on screen is the one the query returned. There
is no step you have to take on faith.

### Who would use it

Any attendee at a multi-track conference. The same shape works for organisers
("which sessions are topically orphaned?") and speakers ("who else is presenting my
topic?"). It needs only public catalog data — no attendee tracking, which is why
Patchwork never infers who is attending.

### Honest note

FalkorDB Cloud's free tier exposed a plaintext-only endpoint. Our server refuses a
remote non-TLS connection unless explicitly opted into, so for the demo we set
`FALKORDB_ALLOW_INSECURE=true` deliberately. We also added a diagnostic: on a
connect timeout the server probes the port with a plain Redis `PING` and, if it
answers, reports that the endpoint is reachable but not speaking TLS — turning a
silent 23-second fallback into a one-line fix.

---

## How did you use Bright Data and what problems did you solve using it?

### The hard-to-reach site: LinkedIn, at volume

We measured this rather than assuming it. Twelve public LinkedIn profiles, fetched
by a plain script from one IP:

| | result |
|---|---|
| Profiles 1–9 | returned normally |
| Profiles 10–12 | **HTTP 999 — blocked** |

Patchwork needs **26 lookups**, every run. The plain path dies at nine. Bright Data
Web Unlocker returned profiles the plain script was blocked from.

One real implementation finding: `data_format: 'markdown'` fails on LinkedIn —
Bright Data's JSON mode exposes it as `502 x-brd-error: "reject element found"`,
tripping on the auth-wall banner and returning an empty body. Fetching with plain
`format: 'raw'` returns the full 900KB profile. We retry once on an empty body.

Bright Data also fetches the official GitHub Universe site and GitHub's schedule
article on every search, so the speaker list is confirmed against live pages rather
than a list baked in at build time.

### Keeping the data accurate

This is where we spent the most care, because fresh data that is *wrong* is worse
than stale data.

1. **Nothing is trusted on arrival.** A speaker appears only if their name *and*
   their session title are both present in the fetched pages. The UI reports the
   ratio — *"2 of 4 graph candidates confirmed."*
2. **Identity is corroborated, never guessed.** A name-derived profile URL lands on
   the wrong person surprisingly often. The fetched page must carry the speaker's
   name in its headline *and* the employer GitHub published. Our own test run
   rejected seven profiles for naming a different employer — real people with the
   right name and the wrong life. **We show nothing rather than a stranger.**
3. **Failures are distinguished from verdicts.** A dropped connection is not
   evidence that a profile does not exist, so transport failures are never cached.
   Only a genuine rejection is persisted.
4. **Every failure mode is reported, not swallowed.** Timeout, empty body, HTTP
   error and name/employer mismatch each produce a distinct message the attendee can
   read.
5. **The catalog survives a bad fetch.** If a refresh matches no known session
   titles — the signature of a site redesign — previously verified records are left
   untouched and the response says so.
6. **No wasted requests.** Topic matching is local, so a query the catalog cannot
   answer returns in **0.1s having made zero requests**.

### Saving people time and money

Finding three relevant people across 17 sessions and 26 speakers is maybe 20 minutes
of cross-referencing a schedule against LinkedIn — assuming LinkedIn does not block
you, which at 26 lookups it will. Patchwork does it in seconds and hands you an
opening line tied to the specific session.

Checking a speaker's *current* employer matters more than it sounds. One speaker in
our catalog is listed by GitHub's October article as being at VoidZero; his live
profile says Cloudflare. He changed jobs between the article and the event. Walking
up to someone and naming the wrong employer is exactly the failure a static list
guarantees.

---

## How did you use TrueFoundry and OpenAI?

**Not applicable — we are not submitting for this track.**

Patchwork uses no LLM and no agent runtime. The recommendation is a graph traversal
and the verification is deterministic string corroboration. We considered adding a
model to generate conversation openers and chose not to: a hallucinated detail about
a real person you are about to walk up to is worse than no detail. The openers are
templated from topics the graph actually returned.

We would rather state this plainly than claim an integration we did not build.

---

## Qodo Track — PR links

```
https://github.com/haaaaaaaaaayk/patchwork-github-universe-2026/pull/1
https://github.com/haaaaaaaaaayk/patchwork-github-universe-2026/pull/2
https://github.com/haaaaaaaaaayk/patchwork-github-universe-2026/pull/3
```

PR #3 is the substantial one: a full end-to-end review of the running app that found
and fixed a 23-second startup block, a blank primary column, search terms the UI
itself suggested that returned zero results, fabricated personalisation, stale
counters, and a 1.02:1 contrast failure.

---

## Feedback

### FalkorDB

**Liked.** Cypher made the four-hop query readable enough to put on screen in front
of judges — that is unusual and it became our best demo moment. `UNWIND` over a
parameter list made the "for each speaker I saved" shape fall out naturally.
Verifying node counts with a real query at startup made the health check honest.

**Improve.** The Cloud free tier gave us a plaintext-only endpoint while the console
implied TLS, and the client surfaced that as a generic `Connection timeout` after
~10 seconds — indistinguishable from an unreachable host. We had to probe the port
with a raw Redis `PING` to find out the endpoint simply was not speaking TLS. A
clearer client error (`server did not complete TLS handshake`) would have saved an
hour. The Node 22+ requirement is also easy to trip over: on Node 20 the ESM import
failure reads like a network problem.

### Bright Data

**Liked.** Web Unlocker was one HTTP call with no proxy plumbing, and it did the
thing we needed — returned pages a plain script was blocked from. `data_format:
markdown` is excellent for article-shaped pages; it made the GitHub source matching
trivial.

**Improve.** The `markdown` converter silently returns an **empty 200** on LinkedIn.
The cause (`reject_element` on the auth-wall banner) is only visible if you switch
to `format: 'json'` and inspect `x-brd-error`. An empty body on a 200 is the worst
possible signal — we lost real time assuming rate-limiting before finding it. Either
surface the reject reason in the raw response headers, or fall back to raw HTML
automatically. Latency was also variable (4s–25s for the same URL), which is hard to
design a live demo around.

### TrueFoundry

Not used.
