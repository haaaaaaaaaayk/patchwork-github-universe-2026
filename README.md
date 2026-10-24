# Patchwork — GitHub Universe 2026 companion

Patchwork helps conference attendees recover a missed session and find a useful next conversation. Its 16-session sample catalog combines two official [GitHub Universe 2026 sources](https://github.blog/news-insights/company-news/10-technical-talks-im-excited-about-at-github-universe-2026/).

## Run it

Requires Node.js 22 or newer for the FalkorDB client and the `sqlite3` command-line tool. The local SQLite fallback works without a Cloud connection.

```sh
npm start
```

Open <http://127.0.0.1:4173>.

## In the demo

- Choose any of 16 sourced sessions for a concise catch-up note and a question to start a conversation. These are based on published descriptions, not transcripts.
- Match your interests to speakers through topic → session → speaker paths.
- Save people, mark speakers met, and keep the profile/list in this browser across reloads. People you have met are excluded from later recommendations.
- Inspect the active graph path query and database health.
- Ask Bright Data Web Unlocker to retrieve GitHub’s official talk roundup live, verify exact session titles, extract matching source excerpts, and save both records and refresh metadata in SQLite. The separate official attendee portal is linked for the full schedule.

The Bright Data request does not replace the source-backed catalog. It records which session titles are present in the live official source. The attendee portal returned HTTP 502 during the live check, so the full dynamic schedule is not yet being ingested.

## Bright Data

Set `BRIGHTDATA_API_KEY` and `BRIGHTDATA_UNLOCKER_ZONE` in `brightdata.env` or `.env`. Keep both files out of Git. The server loads the credentials locally and sends them only to `https://api.brightdata.com/request`; the browser never receives the key.

## Persistent graph database

By default, Patchwork stores graph nodes, relationships, attendee interests, and live scrape metadata in `data/patchwork.sqlite`. At startup it runs `PRAGMA integrity_check` and reports the stored node and edge counts. Speaker recommendations and the graph-path inspector query this SQLite graph store.

FalkorDB remains an optional graph database target for the iPhone Duo track. To use it:

FalkorDB is optional for local development. Without a reachable database, the conference flows work with the persistent SQLite graph. To use the FalkorDB-backed graph path:

1. Install the optional Node client with `npm install`.
2. Start a FalkorDB instance or create a Cloud database.
3. For Cloud, set `FALKORDB_HOST`, `FALKORDB_PORT`, `FALKORDB_USERNAME`, `FALKORDB_PASSWORD`, and `FALKORDB_TLS` in `.env` using the values shown by the Connect panel. Patchwork refuses a remote plain-TCP connection unless `FALKORDB_ALLOW_INSECURE=true` is explicitly set. For a local instance, use `FALKORDB_URL` instead.
4. Run Patchwork under Node.js 22 or later (`falkordb` requires Node 22+) and confirm the graph badge reports `FALKORDB` with per-label node counts.

When configured, the app seeds Event, Source, Session, Speaker, and Topic nodes in FalkorDB, persists attendee interests and met-speaker edges there, and runs recommendations in Cypher. At startup it executes a graph query to verify the seeded node counts; SQLite remains the local fallback.

## Sources and limits

- GitHub Universe is listed for October 28–29, 2026 at Fort Mason Center in San Francisco.
- Session descriptions and speaker names are summarized from GitHub’s official [October 1 technical roundup](https://github.blog/news-insights/company-news/10-technical-talks-im-excited-about-at-github-universe-2026/) and [August 13 schedule launch](https://github.blog/news-insights/company-news/your-guide-to-github-universe-2026-is-here-the-schedule-just-launched/). The official [attendee session catalog](https://reg.githubuniverse.com/flow/github/universe26/attendee-portal/page/sessioncatalog) is dynamic and may contain more current schedule details than either article.
- Speaker matching is based on public speaker/session information. Real attendee-to-attendee matching would require voluntary attendee profiles.
- TrueForge is not part of the core workflow.
