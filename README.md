# Couchpilot

Your couch, on autopilot: an unofficial, self-hosted Cinemeta replacement for Nuvio with personal rows and AI recommendations from your watch history.

> Couchpilot is a community project and not affiliated with Nuvio, TMDB, AniList, Trakt or Simkl. It only provides metadata and catalogs, no streams.

## Features

- **Standard rows:** Trending, Popular, New, Top Rated for movies and series (TMDB), anime via AniList.
- **Mix rows:** movies and series in one row ("Trending Now", "Top Picks for You" …). Nuvio opens every item with its own type.
- **For You** (★): Top Picks, Because You Watched X, new episodes of your shows, genre mixes with AI titles, a time-of-day row (feel-good during the day, late night thrills, weekend movie night) and anime picks.
- **History sources:** Nuvio Sync, Trakt, Simkl, AniList (public list by username). Read-only.
- **AI:** OpenAI, Anthropic, Gemini, OpenRouter, Ollama with your own key. Ranks, names mixes and writes short reasons into the description. Without AI you get a default ranking.
- **Metadata:** "Enhanced" keeps Cinemeta's IMDb rating and episode IDs (what stream addons expect) and adds TMDB: localized titles, descriptions, genres and episode names, HD backgrounds, localized posters and title logos, cast/director, YouTube trailers, episode thumbnails. Each part can be switched off; "Cinemeta only" is available too.
- **AI cost:** the AI section shows real token usage of the last 30 days and an estimated monthly cost for the chosen refresh interval.
- **Backup:** export/import your settings as a JSON file (optionally with TMDB/AI keys), so you don't need a password.
- **Usability:** works without an account; show/hide, rename and reorder rows; optional password.
- **Profiles:** connecting Nuvio Sync imports your Nuvio profiles, each with its own watch history and install URL. Switch profiles at the top of the config page, then save for all profiles or only the open one (e.g. German metadata for one profile, English for another). Recompute one or all profiles.
- **Precompute:** a background job keeps rows of active users fresh, the app only reads finished results. The config page shows live progress.
- **No server TMDB key:** every user adds their own free TMDB key.

## Security

| What | How |
|---|---|
| API keys and OAuth tokens | AES-256-GCM, bound to their owner (AAD), never sent to the browser |
| Master key | Docker secret (`secrets/master_key`), not in `.env`, not in `docker inspect`, not in DB backups |
| DB leak alone | useless: no keys without the master key, install tokens only usable as hashes, passwords use scrypt |
| Leaked install URL | attacker can change settings but cannot read keys. Switching the AI provider or Ollama URL deletes the stored AI key. "Generate new URL" locks them out |
| Ollama URL | https only, private/internal IPs blocked at connect time (also against DNS rebinding) |
| Abuse | rate limits per IP, per install URL and per user; max 40 AI calls per day and user; max 6 manual recomputes per hour; account creation limited per IP and globally |
| Web | CSRF check (Origin), SameSite and `__Host-` cookie, CSP with nonce, sessions ended everywhere on password or URL change |
| Container | read-only filesystem, no capabilities, not root, Postgres/Redis internal only, Redis with password |
| Cleanup | configs that were never installed and have no password are deleted after 7 days |

What no software can prevent: whoever fully takes over the running server (root on the VPS) can read the master key from memory. Keep the VPS updated, use SSH keys instead of passwords and a firewall (only 22, 80, 443 open).

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

## Troubleshooting

- **Status stays on "running":** the config page now updates live. If a run gets stuck, it ends with an error after 5 minutes at the latest. Check the logs: `docker compose logs addon --tail 100`. Every step is logged with its duration.
- **Rows are empty:** check that a TMDB key is saved (step 4) and look at "Last run" in step 1.

## Optional: Trakt, Simkl, support button

- **Trakt:** create an app at https://trakt.tv/oauth/applications/new, redirect URI `urn:ietf:wg:oauth:2.0:oob`, then put `TRAKT_CLIENT_ID` and `TRAKT_CLIENT_SECRET` into `.env`.
- **Simkl:** create an app at https://simkl.com/settings/developer/, put `SIMKL_CLIENT_ID` into `.env`.
- **Support button:** `SUPPORT_URL` (e.g. Ko-fi or PayPal.me, must start with `https://`).

Nuvio Sync and AniList need no setup.

## Tips for Nuvio

- Disable Cinemeta or move this addon above it.
- Nuvio remembers its own row order per profile. If the order in Nuvio differs from the config page, reorder in Nuvio's catalog order settings or reinstall the addon.
- Nuvio appends " - Series" / " - Movie" to row names. In Nuvio TV you can turn it off: Settings → Layout → "Show Catalog Type". Mix rows would otherwise show " - Mixed".

## Development

```
npm install
npm test        # crypto and parser checks
npm run check   # type check
```

## Legal & attribution

- This product uses the TMDB API but is not endorsed or certified by TMDB. The TMDB logo and this notice are shown on every page.
- TMDB and AniList APIs are free for non-commercial use. If you run a public instance with income (ads, paid features), check their terms first.
- Running a **public** instance may require an imprint and a privacy policy depending on your country (e.g. Germany). Set `IMPRINT_URL` and `PRIVACY_URL` in `.env` to link them in the footer. A private instance only you use does not need them.

## License

MIT, see [LICENSE](LICENSE).
