import { decrypt, encrypt } from './crypto.ts';
import { netError, type Type } from './sources.ts';
import { redis, updateSecrets, type Secrets } from './store.ts';

// A watched title from any source. Series episodes are merged into the series.
export type Watch = { id: string; type: Type; at: number; rating?: number; tmdb?: number; title?: string };

async function call(url: string, init: RequestInit): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }).catch((err) => {
    throw netError(err, url);
  });
  const body = await r.text();
  if (!r.ok) throw Object.assign(new Error(`${r.status} ${url.split('?')[0]}`), { status: r.status, body });
  return body ? JSON.parse(body) : null;
}

const toType = (t: string): Type | null => (t === 'movie' ? 'movie' : t === 'series' || t === 'tv' || t === 'show' ? 'series' : null);

// ---------- Nuvio Sync (Supabase) ----------

const NUVIO = 'https://api.nuvio.tv';
const NUVIO_KEY = 'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN'; // public key shipped in the Nuvio app
const nuvioHeaders = (token?: string) => ({
  apikey: NUVIO_KEY,
  'Content-Type': 'application/json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});
const nuvioRpc = (token: string, name: string, body: object) =>
  call(`${NUVIO}/rest/v1/rpc/${name}`, { method: 'POST', headers: nuvioHeaders(token), body: JSON.stringify(body) });

// The password is only used here and never stored, only the refresh token
export async function nuvioSignIn(email: string, password: string) {
  const s = await call(`${NUVIO}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: nuvioHeaders(),
    body: JSON.stringify({ email, password }),
  });
  return { refreshToken: s.refresh_token as string, profiles: await pullProfiles(s.access_token) };
}

const pullProfiles = async (token: string) =>
  (((await nuvioRpc(token, 'sync_pull_profiles', {})) ?? []) as any[])
    .map((p) => ({ index: Number(p.profile_index), name: String(p.name ?? `Profile ${p.profile_index}`).slice(0, 30) }))
    .slice(0, 20);

// Current profile list of a connected Nuvio account (userId = profile that holds the login)
export const nuvioProfileList = async (userId: string) => pullProfiles(await nuvioAccessToken(userId));

// Supabase rotates refresh tokens: one refresh at a time, store the new token immediately
async function nuvioAccessToken(userId: string): Promise<string> {
  const key = `nuvio:at:${userId}`;
  for (let i = 0; i < 20; i++) {
    const hit = await redis.get(key);
    if (hit) return decrypt(hit, `nuvioat:${userId}`);
    if (await redis.set(`nuvio:lock:${userId}`, '1', 'EX', 30, 'NX')) {
      try {
        let access = '';
        await updateSecrets(userId, async (sec) => {
          if (!sec.nuvio) throw new Error('Nuvio not connected');
          const s = await call(`${NUVIO}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: nuvioHeaders(),
            body: JSON.stringify({ refresh_token: sec.nuvio.refreshToken }),
          });
          sec.nuvio.refreshToken = s.refresh_token;
          access = s.access_token;
          await redis.set(key, encrypt(access, `nuvioat:${userId}`), 'EX', Math.max(60, Number(s.expires_in ?? 3600) - 120));
        });
        return access;
      } finally {
        await redis.del(`nuvio:lock:${userId}`);
      }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('Nuvio token refresh is stuck');
}

// IMDb IDs for movies/series, kitsu: IDs for anime; ignore everything else
function nuvioItem(contentId: unknown, contentType: string, at: unknown): Watch | null {
  const id = String(contentId);
  const kitsu = id.match(/^kitsu:(\d+)/);
  if (kitsu) return { id: `kitsu:${kitsu[1]}`, type: 'series', at: Number(at) || 0 };
  const type = toType(contentType);
  return type && /^tt\d+$/.test(id) ? { id, type, at: Number(at) || 0 } : null;
}

export async function nuvioHistory(userId: string, profile: number): Promise<Watch[]> {
  const token = await nuvioAccessToken(userId);
  const out: Watch[] = [];
  for (let page = 1; page <= 5; page++) {
    const rows: any[] = (await nuvioRpc(token, 'sync_pull_watched_items', { p_profile_id: profile, p_page: page, p_page_size: 1000 })) ?? [];
    for (const r of rows) {
      const w = nuvioItem(r.content_id, r.content_type, r.watched_at);
      if (w) out.push(w);
    }
    if (rows.length < 1000) break;
  }
  // Started titles count as interest too
  const progress: any[] = (await nuvioRpc(token, 'sync_pull_watch_progress', { p_profile_id: profile })) ?? [];
  for (const r of progress) {
    const w = nuvioItem(r.content_id, r.content_type, r.last_watched);
    if (w) out.push(w);
  }
  return out;
}

// ---------- Trakt (device code flow, needs a Trakt app registered by the server operator) ----------

const TRAKT = 'https://api.trakt.tv';
export const TRAKT_ID = process.env.TRAKT_CLIENT_ID;
const TRAKT_SECRET = process.env.TRAKT_CLIENT_SECRET;
const traktHeaders = (token?: string) => ({
  'Content-Type': 'application/json',
  'trakt-api-version': '2',
  'trakt-api-key': TRAKT_ID ?? '',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

export type TraktTokens = { accessToken: string; refreshToken: string; expiresAt: number };
const tokens = (t: any): TraktTokens => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: (Number(t.created_at) + Number(t.expires_in)) * 1000,
});

export async function traktDeviceCode() {
  const d = await call(`${TRAKT}/oauth/device/code`, { method: 'POST', headers: traktHeaders(), body: JSON.stringify({ client_id: TRAKT_ID }) });
  return { deviceCode: d.device_code as string, userCode: d.user_code as string, url: d.verification_url as string, expiresIn: Number(d.expires_in) };
}

// null = user has not confirmed yet
export async function traktPoll(deviceCode: string): Promise<TraktTokens | null> {
  try {
    const t = await call(`${TRAKT}/oauth/device/token`, {
      method: 'POST',
      headers: traktHeaders(),
      body: JSON.stringify({ code: deviceCode, client_id: TRAKT_ID, client_secret: TRAKT_SECRET }),
    });
    return tokens(t);
  } catch (err) {
    if ((err as any).status === 400 || (err as any).status === 429) return null;
    throw err;
  }
}

async function traktAccessToken(userId: string, sec: Secrets): Promise<string> {
  if (!sec.trakt) throw new Error('Trakt not connected');
  if (sec.trakt.expiresAt - Date.now() > 3600_000) return sec.trakt.accessToken;
  let access = '';
  await updateSecrets(userId, async (s) => {
    if (!s.trakt) throw new Error('Trakt not connected');
    if (s.trakt.expiresAt - Date.now() > 3600_000) return void (access = s.trakt.accessToken); // another job was faster
    const t = await call(`${TRAKT}/oauth/token`, {
      method: 'POST',
      headers: traktHeaders(),
      body: JSON.stringify({
        refresh_token: s.trakt.refreshToken,
        client_id: TRAKT_ID,
        client_secret: TRAKT_SECRET,
        redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
        grant_type: 'refresh_token',
      }),
    });
    s.trakt = tokens(t);
    access = s.trakt.accessToken;
  });
  return access;
}

export async function traktHistory(userId: string, sec: Secrets): Promise<Watch[]> {
  const token = await traktAccessToken(userId, sec);
  const get = (path: string) => call(`${TRAKT}${path}`, { headers: traktHeaders(token) }) as Promise<any[]>;
  const [movies, shows, rMovies, rShows] = await Promise.all([
    get('/sync/watched/movies'),
    get('/sync/watched/shows?extended=noseasons'),
    get('/sync/ratings/movies'),
    get('/sync/ratings/shows'),
  ]);
  const item = (x: any, type: Type, at: string, rating?: number): Watch | null => {
    const m = type === 'movie' ? x.movie : x.show;
    return m?.ids?.imdb ? { id: m.ids.imdb, type, at: Date.parse(at) || 0, rating, tmdb: m.ids.tmdb, title: m.title } : null;
  };
  return [
    ...movies.map((x) => item(x, 'movie', x.last_watched_at)),
    ...shows.map((x) => item(x, 'series', x.last_watched_at)),
    ...rMovies.map((x) => item(x, 'movie', x.rated_at, x.rating)),
    ...rShows.map((x) => item(x, 'series', x.rated_at, x.rating)),
  ].filter((w): w is Watch => w !== null);
}

// ---------- Simkl (PIN flow, needs a Simkl app registered by the server operator) ----------

const SIMKL = 'https://api.simkl.com';
export const SIMKL_ID = process.env.SIMKL_CLIENT_ID;
const simklHeaders = (token?: string) => ({
  'Content-Type': 'application/json',
  'simkl-api-key': SIMKL_ID ?? '',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

export async function simklPin() {
  const d = await call(`${SIMKL}/oauth/pin?client_id=${encodeURIComponent(SIMKL_ID ?? '')}`, { headers: simklHeaders() });
  return { userCode: String(d.user_code), url: String(d.verification_url ?? 'https://simkl.com/pin'), expiresIn: Number(d.expires_in) || 900 };
}

// null = not confirmed yet
export async function simklPoll(userCode: string): Promise<string | null> {
  const d = await call(`${SIMKL}/oauth/pin/${encodeURIComponent(userCode)}?client_id=${encodeURIComponent(SIMKL_ID ?? '')}`, { headers: simklHeaders() });
  return d?.result === 'OK' && d.access_token ? String(d.access_token) : null;
}

export async function simklHistory(sec: Secrets): Promise<Watch[]> {
  if (!sec.simkl) return [];
  const get = (path: string) => call(`${SIMKL}${path}`, { headers: simklHeaders(sec.simkl!.accessToken) }).catch(() => null);
  const [movies, shows, anime] = await Promise.all([get('/sync/all-items/movies'), get('/sync/all-items/shows'), get('/sync/all-items/anime')]);
  const out: Watch[] = [];
  const add = (list: any[] | undefined, key: 'movie' | 'show', type: Type) => {
    for (const x of list ?? []) {
      const m = x?.[key];
      const imdb = m?.ids?.imdb;
      if (typeof imdb !== 'string' || !/^tt\d+$/.test(imdb)) continue;
      const rating = Number(x.user_rating);
      out.push({ id: imdb, type, at: Date.parse(x.last_watched_at ?? x.added_to_watchlist_at ?? '') || 0, rating: rating || undefined, tmdb: Number(m.ids.tmdb) || undefined, title: m.title });
    }
  };
  add(movies?.movies, 'movie', 'movie');
  add(shows?.shows, 'show', 'series');
  add(anime?.anime, 'show', 'series');
  return out;
}

// ---------- AniList (public list by username, no login needed) ----------

export async function anilistUserHistory(userName: string, toId: (anilistId: number) => string | undefined): Promise<Watch[]> {
  const r = await call('https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      query: 'query($u:String){MediaListCollection(userName:$u,type:ANIME,status_in:[COMPLETED,CURRENT,REPEATING]){lists{entries{mediaId score(format:POINT_10) updatedAt}}}}',
      variables: { u: userName },
    }),
  });
  const out: Watch[] = [];
  for (const list of r?.data?.MediaListCollection?.lists ?? [])
    for (const e of list.entries ?? []) {
      const id = toId(e.mediaId);
      if (id) out.push({ id, type: 'series', at: Number(e.updatedAt) * 1000 || 0, rating: Number(e.score) || undefined });
    }
  return out;
}

// Merge all sources: per title keep the newest timestamp, rating and info
export function mergeHistory(items: Watch[]): Watch[] {
  const byId = new Map<string, Watch>();
  for (const w of items) {
    const old = byId.get(w.id);
    byId.set(w.id, old ? { ...old, ...w, at: Math.max(old.at, w.at), rating: w.rating ?? old.rating, tmdb: w.tmdb ?? old.tmdb, title: w.title ?? old.title } : w);
  }
  return [...byId.values()].sort((a, b) => b.at - a.at);
}
