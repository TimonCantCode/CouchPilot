# Couchpilot

Your couch, on autopilot: an unofficial Cinemeta replacement for Nuvio with personal rows and AI recommendations from your watch history.

**Use it at [couchpilot.nl](https://couchpilot.nl)** or host your own instance (see Setup).

> Couchpilot is a community project and not affiliated with Nuvio, TMDB, AniList, Trakt or Simkl. It only provides metadata and catalogs, no streams.

## Features

- **Standard rows:** Trending, Popular, New, Top Rated for movies and series (TMDB), anime via AniList.
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
- **Kids mode** (per profile): age rating limit (German FSK, US as fallback) and blocked genres in every row and in search.
- **Trailers in rows:** every row item carries its YouTube trailer, so Nuvio can autoplay it on the home screen.
- **Seasonal row:** Halloween horror in October, Christmas movies in December, hidden the rest of the year.
- **Usability:** works without an account; show/hide, rename and reorder rows; optional password.
- **Profiles:** connecting Nuvio Sync imports your Nuvio profiles, each with its own watch history and install URL. Switch profiles at the top of the config page, then save for all profiles or only the open one (e.g. German metadata for one profile, English for another). Recompute one or all profiles.
- **Precompute:** a background job keeps rows of active users fresh, the app only reads finished results. The config page shows live progress.
- **No server TMDB key:** every user adds their own free TMDB key.
- **Status page:** `/health` shows uptime of the last 30 days, running jobs and checks (JSON for monitoring tools, HTML in the browser).
- **Privacy:** no tracking, no analytics, no e-mail addresses, no access logs. Pages load nothing from third-party servers (the TMDB logo is served locally).

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

What no software can prevent: whoever fully takes over the running server (root on the VPS) can read the master key from memory. Keep the VPS updated (`apt install unattended-upgrades`), use SSH keys instead of passwords and a firewall (only 22, 80, 443 open).

## Setup (local or VPS)

1. Copy `.env.example` to `.env` and fill it in. Generate passwords with:
   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
2. Create the master key file (in the project folder):
   ```
   node -e "require('fs').mkdirSync('secrets',{recursive:true});require('fs').writeFileSync('secrets/master_key',require('crypto').randomBytes(32).toString('base64'))"
   ```
   On a Linux VPS afterwards: `sudo chown 1000:1000 secrets/master_key && sudo chmod 400 secrets/master_key`.
   **Back this file up separately from your DB backups.** If it's lost, all stored keys become unreadable.
3. Start:
   - Locally: `docker compose -f docker-compose.yml -f docker-compose.local.yml up --build`, then open `http://localhost:7000`
   - VPS: `docker compose up -d --build`, Caddy gets the HTTPS certificate automatically
4. Update later: `sh update.sh` (pull, rebuild, clean up old images)

## Backups and operations

- **Database:** the `backup` container writes a dump to `backups/couchpilot-YYYY-MM-DD.sql.gz` once a day and keeps the last 7 days. Copy the folder off the server now and then (`scp -r root@your-server:~/couchpilot/backups .`). Restore into a fresh install: `gunzip -c backups/couchpilot-DATE.sql.gz | docker compose exec -T postgres psql -U nuvio nuvio`.
- **Master key:** not part of the dump on purpose. Keep `secrets/master_key` somewhere else, without it the keys in a backup can't be read.
- **Logs:** capped at 3 × 10 MB per container. `docker compose logs addon --tail 100` shows the latest.
- **Health checks:** Postgres, Redis and the addon report their health (`docker compose ps`), the addon starts only when the database is ready, and crashed containers restart automatically. Point an uptime monitor (e.g. UptimeRobot) at `https://your-domain/health` to get alerts.
- **Database console:** `docker compose exec postgres psql -U nuvio nuvio`. Keys and tokens are encrypted, so they stay unreadable there.
- **Moving servers:** dump the DB (`docker compose exec -T postgres pg_dump -U nuvio nuvio > dump.sql`), copy `dump.sql`, `.env` and `secrets/master_key` to the new server, start `postgres`, restore with `psql … < dump.sql`, start everything and point DNS to the new IP. Redis is only cache and can be left behind.

## Troubleshooting

- **Status stays on "running":** the config page now updates live. If a run gets stuck, it ends with an error after 5 minutes at the latest. Check the logs: `docker compose logs addon --tail 100`. Every step is logged with its duration.
- **Rows are empty:** check that a TMDB key is saved (step 4) and look at "Last run" in step 1.

## Optional: Trakt, Simkl, support button, legal pages

- **Trakt:** create an app at https://trakt.tv/oauth/applications/new, redirect URI `urn:ietf:wg:oauth:2.0:oob`, then put `TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` into `.env`.
- **Simkl:** create an app at https://simkl.com/settings/developer/, put `SIMKL_CLIENT_ID` into `.env`.
- **Support button:** `SUPPORT_URL` (e.g. Ko-fi or PayPal.me, must start with `https://`). Keep it a donation without perks, otherwise it becomes a sale with its own legal duties.
- **Imprint & privacy policy:** set `IMPRINT_NAME`, `IMPRINT_ADDRESS` (comma separated) and `IMPRINT_EMAIL` in `.env`. Couchpilot then serves `/imprint` and `/privacy` (German, written for exactly what Couchpilot stores) and links them in the footer. Your details stay in `.env`, never in git. Review the text for your situation, it is not legal advice.
- **TMDB logo:** download it from https://www.themoviedb.org/about/logos-attribution and save it as `public/tmdb.svg`. Until then the footer shows a text link.

Nuvio Sync and AniList need no setup.

## Tips for Nuvio

- Disable Cinemeta or move this addon above it.
- Nuvio remembers its own row order per profile. If the order in Nuvio differs from the config page, reorder in Nuvio's catalog order settings or reinstall the addon.
- Nuvio appends " - Series" / " - Movie" to row names. In Nuvio TV you can turn it off: Settings → Layout → "Show Catalog Type". Mix rows would otherwise show " - Mixed".

## Development

```
npm install
npm test        # unit tests (AI reply parser, rows, trailers, age ratings, save-for-all diff)
npm run check   # type check
# end-to-end: real server + Postgres + Redis, external APIs mocked. Uses an EMPTY database, it gets wiped:
TEST_DATABASE_URL=postgres://… TEST_REDIS_URL=redis://…/1 npm run test:e2e
```

## Legal & attribution

- This product uses the TMDB API but is not endorsed or certified by TMDB. The TMDB logo and this notice are shown on every page.
- TMDB and AniList APIs are free for non-commercial use. If you run a public instance with income (ads, paid features), check their terms first.
- Running a **public** instance may require an imprint and a privacy policy depending on your country (e.g. Germany), see "legal pages" above. In the EU you also need a data processing agreement (DPA/AVV) with your hosting provider. A private instance only you use does not need them.

## License

MIT, see [LICENSE](LICENSE).
