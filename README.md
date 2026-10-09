# Couchpilot

Your couch, on autopilot: an unofficial Cinemeta replacement for Nuvio with personal rows and AI recommendations from your watch history.

**Use it at [couchpilot.nl](https://couchpilot.nl).**

> Couchpilot is a community project and not affiliated with Nuvio, TMDB, AniList, Trakt or Simkl. It only provides metadata and catalogs, no streams.

## Features

- **Standard rows:** Trending, Popular, New, Top Rated for movies and series (TMDB), anime via AniList.
- **Genre rows:** Action & Adventure, Comedies, Sci-Fi & Fantasy, Horror, Thrillers, Crime, Dramas, Romance, Mystery, Family, Documentaries. Popular titles, movies and series alternating, off by default. Plus up to 3 rotating genre rows that switch genre every day, picked at random or weighted by your watch history, from the genres you choose.
- **Mix rows:** movies and series in one row ("Trending Now", "Top Picks for You" …). Nuvio opens every item with its own type.
- **For You** (★): Complete the Saga (next part of film series you started), More from … (your most-watched director or actor), Coming Soon (upcoming movies in your genres + new seasons/episodes of your shows), up to 3 own AI rows from a text prompt (“cozy 90s sci-fi”), plus Top Picks, Because You Watched X, new episodes of your shows, genre mixes with AI titles, a time-of-day row (feel-good during the day, late night thrills, weekend movie night) and anime picks.
- **History sources:** Nuvio Sync, Trakt, Simkl, AniList (public list by username). Read-only.
- **AI:** OpenAI, Anthropic, Gemini, OpenRouter, Ollama with your own key. Ranks, names mixes and writes short reasons into the description. Without AI you get a default ranking.
- **Metadata:** "Enhanced" keeps Cinemeta's IMDb rating and episode IDs (what stream addons expect) and adds TMDB: localized titles, descriptions, genres and episode names, HD backgrounds, localized posters and title logos, cast/director, YouTube trailers, episode thumbnails. Each part can be switched off; "Cinemeta only" is available too.
- **AI cost:** the AI section shows real token usage of the last 30 days and an estimated monthly cost for the chosen refresh interval.
- **AI daily limit** (per profile): 20, 40 (default), 100 or 200 calls per day, resets at midnight in the profile's timezone. Protects your key if your install URL leaks.
- **Backup:** export/import your settings as a JSON file (optionally with TMDB/AI keys), so you don't need a password.
- **Hide watched:** Trending, Popular, New and the other standard rows skip what the profile has already watched (per profile, on by default).
- **AI search:** with AI set up, Nuvio's search also understands descriptions (“the movie with the dream in a dream”), 3+ words, max. 30 per day and user.
- **Similar titles:** search “like Inception” or “ähnlich wie Dark” in Nuvio for recommendations to that title, no AI needed.
- **Fresh home screen:** personal and genre rows are reshuffled every few hours, the best picks stay first (can be switched off).
- **Kids mode** (per profile): age rating limit (German FSK, US as fallback) and blocked genres in every row and in search.
- **Trailers in rows:** every row item carries its YouTube trailer, so Nuvio can autoplay it on the home screen.
- **Seasonal row:** Halloween horror in October, Christmas movies in December, hidden the rest of the year.
- **Usability:** works without an account; show/hide, rename and reorder rows; optional password.
- **Profiles:** connecting Nuvio Sync imports your Nuvio profiles, each with its own watch history and install URL. Switch profiles at the top of the config page, then save for all profiles or only the open one (e.g. German metadata for one profile, English for another). Recompute one or all profiles.
- **Precompute:** a background job keeps rows of active users fresh, the app only reads finished results. The config page shows live progress.
- **No server TMDB key:** every user adds their own free TMDB key.
- **Status page:** `/health` shows uptime of the last 30 days, running jobs and checks (JSON for monitoring tools, HTML in the browser).

## Security

| What | How |
|---|---|
| API keys and OAuth tokens | AES-256-GCM, bound to their owner (AAD), never sent to the browser |
| Master key | Docker secret (`secrets/master_key`), not in `.env`, not in `docker inspect`, not in DB backups |
| DB leak alone | useless: no keys without the master key, install tokens only usable as hashes, passwords use scrypt |
| Leaked install URL | attacker can change settings but cannot read keys (exporting keys needs a log-in with password). Switching the AI provider or Ollama URL deletes the stored AI key. "Generate new URL" locks them out |
| Ollama URL | https only, private/internal IPs blocked at connect time (also against DNS rebinding) |
| Abuse | rate limits per IP, per install URL and per user; configurable AI limit per profile (default 40 calls/day), AI search max. 30/day; max 6 manual recomputes per hour; account creation limited per IP and globally |
| Web | CSRF check (Origin), SameSite and `__Host-` cookie, CSP with nonce, sessions ended everywhere on password or URL change |
| Container | read-only filesystem, no capabilities, not root, Postgres/Redis internal only, Redis with password |
| Cleanup | configs that were never installed and have no password are deleted after 7 days |


## Attribution

This product uses the TMDB API but is not endorsed or certified by TMDB.

## License

MIT, see [LICENSE](LICENSE).
