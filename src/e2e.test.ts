// End-to-end tests: real server, Postgres and Redis, external APIs (TMDB, Nuvio, AI) mocked.
// Run with an EMPTY test database (it gets wiped):
//   TEST_DATABASE_URL=postgres://… TEST_REDIS_URL=redis://… npm run test:e2e
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const DB = process.env.TEST_DATABASE_URL;
const REDIS = process.env.TEST_REDIS_URL;
const PORT = 7199;
const B = `http://localhost:${PORT}`;

// ---------- Fake outside world ----------
const J = (o: unknown) => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
const IMDB: Record<number, string> = { 1396: 'tt0903747', 157336: 'tt0816692', 155: 'tt0468569', 60059: 'tt3032476', 27205: 'tt1375666', 680: 'tt0110912' };
const FIND: Record<string, object> = {
  tt1375666: { movie_results: [{ id: 27205 }], tv_results: [] },
  tt0816692: { movie_results: [{ id: 157336 }], tv_results: [] },
  tt0468569: { movie_results: [{ id: 155 }], tv_results: [] },
  tt0110912: { movie_results: [{ id: 680 }], tv_results: [] },
  tt0903747: { movie_results: [], tv_results: [{ id: 1396 }] },
  tt3032476: { movie_results: [], tv_results: [{ id: 60059 }] },
};
// FSK per TMDB ID (Pulp Fiction 16, everything else 12), Better Call Saul is crime
const AGE: Record<number, string> = { 680: '16' };
const GENRES: Record<number, number[]> = { 60059: [80, 18], 680: [80], 155: [28] };
const aiCalls: string[] = [];
const real = globalThis.fetch;
globalThis.fetch = (async (input: any, init: any = {}) => {
  const u = String(input);
  if (u.startsWith('http://localhost')) return real(input, init);
  if (u.includes('githubusercontent')) return J([]);
  if (u.includes('grant_type=password')) return JSON.parse(init.body).password === 'nuviopw' ? J({ access_token: 'a', refresh_token: 'r1', expires_in: 3600 }) : new Response('{}', { status: 400 });
  if (u.includes('grant_type=refresh_token')) return J({ access_token: 'a2', refresh_token: 'r' + Date.now(), expires_in: 3600 });
  if (u.includes('sync_pull_profiles')) return J([{ profile_index: 1, name: 'Timon' }, { profile_index: 2, name: 'Gast' }]);
  if (u.includes('sync_pull_watched_items')) {
    const p = JSON.parse(init.body).p_profile_id;
    return J(p === 1 ? [{ content_id: 'tt1375666', content_type: 'movie', watched_at: Date.now() }, { content_id: 'tt0903747', content_type: 'series', watched_at: Date.now() - 9 }] : [{ content_id: 'tt0816692', content_type: 'movie', watched_at: Date.now() }]);
  }
  if (u.includes('sync_pull_watch_progress')) return J([]);
  if (u.includes('/chat/completions')) {
    const t = JSON.parse(init.body).messages.at(-1).content as string;
    aiCalls.push(t);
    if (t.includes('name="search"')) return J({ choices: [{ message: { content: '{"items":[{"name":"Inception","year":2010,"type":"movie"},{"name":"Breaking Bad","type":"series"}]}' } }], usage: {} });
    if (t.includes('"titles"')) return J({ choices: [{ message: { content: '{"titles":["A","B"]}' } }] });
    return J({ choices: [{ message: { content: '{"picks":[{"i":0,"why":"fits"}]}' } }] });
  }
  if (u.includes('api.themoviedb.org')) {
    const path = new URL(u).pathname.replace('/3', '');
    let m;
    if (path === '/configuration') return J({});
    if ((m = path.match(/^\/find\/(tt\d+)/))) return J(FIND[m[1]] ?? { movie_results: [], tv_results: [] });
    if (path.startsWith('/genre/')) return J({ genres: [{ id: 28, name: 'Action' }, { id: 80, name: 'Crime' }, { id: 18, name: 'Drama' }] });
    if (path.startsWith('/search/movie')) return J({ results: [{ id: 27205, title: 'Inception', genre_ids: [878] }] });
    if (path.startsWith('/search/tv')) return J({ results: [{ id: 1396, name: 'Breaking Bad', genre_ids: [18] }] });
    if (path.startsWith('/trending/movie')) return J({ results: [27205, 155, 680].map((id) => ({ id, title: 'M' + id, genre_ids: GENRES[id] ?? [878] })) });
    if (/\/recommendations$/.test(path)) return J({ results: [{ id: 155, title: 'The Dark Knight', genre_ids: [28] }, { id: 680, title: 'Pulp Fiction', genre_ids: [80] }] });
    if ((m = path.match(/^\/(movie|tv)\/(\d+)$/))) {
      const id = Number(m[2]);
      const rating = AGE[id] ?? '12';
      return J({
        id, title: 'T' + id, name: 'T' + id, genres: (GENRES[id] ?? [18]).map((g) => ({ id: g })),
        external_ids: { imdb_id: IMDB[id] ?? null },
        videos: { results: [{ site: 'YouTube', type: 'Trailer', key: 'yt' + id, iso_639_1: 'en', official: true }] },
        release_dates: { results: [{ iso_3166_1: 'DE', release_dates: [{ certification: rating }] }] },
        content_ratings: { results: [{ iso_3166_1: 'DE', rating }] },
      });
    }
    if ((m = path.match(/^\/(movie|tv)\/(\d+)\/external_ids$/))) return J({ imdb_id: IMDB[Number(m[2])] ?? null });
    return J({ results: [] });
  }
  return new Response('not mocked: ' + u, { status: 404 });
}) as typeof fetch;

// ---------- Tiny browser: cookies, Origin header, form serialization ----------
class Client {
  cookie = '';
  origin: string;
  constructor(origin = B) {
    this.origin = origin;
  }
  async req(path: string, body?: Record<string, string | string[]> | URLSearchParams, headers: Record<string, string> = {}) {
    const init: RequestInit = { redirect: 'manual', headers: { cookie: this.cookie, ...headers } };
    if (body) {
      const p = body instanceof URLSearchParams ? body : new URLSearchParams();
      if (!(body instanceof URLSearchParams)) for (const [k, v] of Object.entries(body)) for (const x of ([] as string[]).concat(v)) p.append(k, x);
      init.method = 'POST';
      init.body = p;
      (init.headers as any).origin = this.origin;
    }
    const r = await fetch(B + path, init);
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    return r;
  }
  page = async (path = '/configure') => (await this.req(path)).text();
}
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const attr = (tag: string, a: string) => tag.match(new RegExp(`\\s${a}="([^"]*)"`))?.[1];
// What the browser would send for the settings form
function cfgForm(html: string): URLSearchParams {
  const form = html.slice(html.indexOf('id="cfg"'), html.indexOf('</form>', html.indexOf('id="cfg"')));
  const p = new URLSearchParams();
  for (const [tag] of form.matchAll(/<input[^>]*>/g)) {
    const name = attr(tag, 'name');
    if (!name || / disabled/.test(tag)) continue;
    if (attr(tag, 'type') === 'checkbox') {
      if (/ checked/.test(tag)) p.append(name, unesc(attr(tag, 'value') ?? 'on'));
    } else p.append(name, unesc(attr(tag, 'value') ?? ''));
  }
  for (const [, name, opts] of form.matchAll(/<select[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const o = opts.match(/<option[^>]*selected[^>]*>/)?.[0] ?? opts.match(/<option[^>]*>/)![0];
    p.append(name, unesc(attr(o, 'value') ?? opts.match(/<option[^>]*>([^<]*)/)![1]));
  }
  for (const [, name, v] of form.matchAll(/<textarea[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) p.append(name, unesc(v));
  return p;
}
const installUrl = (html: string) => unesc(html.match(/id="installurl"[^>]*value="([^"]+)"|value="([^"]+)" id="installurl"/)!.slice(1).find(Boolean)!);
const json = async (url: string) => (await fetch(url)).json() as Promise<any>;
async function jobsDone(c: Client) {
  for (let i = 0; i < 60; i++) {
    const s = (await (await c.req('/status')).json()) as any;
    if (!s.running) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('jobs did not finish');
}

describe('Couchpilot end to end', { skip: !DB || !REDIS ? 'set TEST_DATABASE_URL and TEST_REDIS_URL' : false }, () => {
  let mod: any, store: any;
  const owner = new Client();
  const TMDB_KEY = 'a'.repeat(32);
  const AI_KEY = 'sk-secret-test-key-1234';

  before(async () => {
    Object.assign(process.env, { DATABASE_URL: DB, REDIS_URL: REDIS, PORT: String(PORT), PUBLIC_URL: B, MASTER_KEY: crypto.randomBytes(32).toString('base64') });
    store = await import('./store.ts');
    await store.redis.flushdb();
    await store.db.query('drop schema public cascade; create schema public');
    mod = await import('./server.ts');
    await new Promise((r) => setTimeout(r, 300));
  });
  after(async () => {
    // let background jobs finish before closing the connections
    for (let i = 0; i < 80 && (await store.redis.keys('pers:lock:*')).length; i++) await new Promise((r) => setTimeout(r, 250));
    mod?.server.close();
    await store?.redis.quit();
    await store?.db.end();
  });

  test('web is protected: CSRF, auth, bad import', async () => {
    assert.equal((await new Client('https://evil.example').req('/start', {})).status, 403, 'foreign origin');
    assert.equal((await fetch(B + '/start', { method: 'POST', redirect: 'manual' })).status, 403, 'no origin');
    const r = await new Client().req('/configure');
    assert.equal(r.headers.get('location'), '/login', 'no session');
    assert.match((await fetch(B + '/')).headers.get('content-security-policy') ?? '', /script-src 'nonce-/);
  });

  test('health: JSON for tools, status page for browsers', async () => {
    const j = (await (await fetch(B + '/health')).json()) as any;
    assert.equal(j.ok, true);
    assert.equal(j.days.length, 30);
    assert.ok(j.checks.every((c: any) => c.ok));
    const html = await (await fetch(B + '/health', { headers: { accept: 'text/html' } })).text();
    assert.match(html, /All systems operational/);
    assert.equal(typeof j.users.profiles, 'number', 'user numbers in health');
    assert.equal(j.external.length, 4, 'external services checked');
    assert.equal(j.week.length, 7, '7 days of stats');
  });

  test('set up: import settings, connect Nuvio, profiles come from Nuvio', async () => {
    assert.equal((await owner.req('/start', {})).status, 303);
    const data = JSON.stringify({ app: 'couchpilot', version: 1, settings: { ai: { provider: 'openai', model: '', baseUrl: '' }, hideWatched: true }, keys: { tmdbKey: TMDB_KEY, aiKey: AI_KEY } });
    assert.equal((await owner.req('/import', { data })).status, 303);
    assert.equal((await owner.req('/import', { data: '{"app":"couchpilot","settings":null}' })).status, 400, 'broken file is rejected, no crash');
    assert.equal((await owner.req('/connect/nuvio', { email: 'a@b.c', password: 'nuviopw' })).status, 303);
    await jobsDone(owner);
    const html = await owner.page();
    assert.deepEqual([...html.matchAll(/<option value="[^"]+"[^>]*>([^<]+)<\/option>/g)].slice(0, 2).map((m) => m[1]), ['Timon', 'Gast']);
    assert.ok(!html.includes(AI_KEY) && !html.includes(TMDB_KEY), 'keys never reach the page');
  });

  test('each profile reads its own Nuvio history', async () => {
    const timon = await json(installUrl(await owner.page()).replace('manifest.json', 'catalog/movie/foryou-movie.json'));
    assert.ok(!timon.metas.some((m: any) => m.id === 'tt1375666'), 'watched Inception is not recommended to Timon');
    const s = await jobsDone(owner);
    assert.equal(s.jobs.length, 2);
    assert.ok(s.jobs.every((j: any) => j.state === 'done'), JSON.stringify(s.jobs));
  });

  test('rows carry trailers, hide watched works', async () => {
    const base = installUrl(await owner.page()).replace('/manifest.json', '');
    const r = await json(`${base}/catalog/movie/trending-movie.json`);
    assert.ok(r.metas.length > 0);
    assert.ok(r.metas.every((m: any) => m.trailerStreams?.[0]?.ytId), 'every item has a trailer');
    assert.ok(!r.metas.some((m: any) => m.id === 'tt1375666'), 'watched title hidden');
  });

  test('save for this profile vs. save for all', async () => {
    const gastId = (await owner.page()).match(/<option value="([^"]+)"[^>]*>Gast</)![1];
    await owner.req('/profile/switch', { id: gastId });
    let form = cfgForm(await owner.page());
    form.set('language', 'de-DE');
    form.set('scope', 'this');
    assert.equal((await owner.req('/configure', form)).status, 303);
    assert.match(await owner.page(), /<option value="de-DE" selected/);
    const timonId = (await owner.page()).match(/<option value="([^"]+)"[^>]*>Timon</)![1];
    await owner.req('/profile/switch', { id: timonId });
    form = cfgForm(await owner.page());
    assert.equal(form.get('language'), 'en-US', 'Timon kept English');
    // save for all copies only the change: Gast gets the new interval but keeps German
    form.set('refreshHours', '12');
    form.set('scope', 'all');
    assert.equal((await owner.req('/configure', form)).status, 303);
    await owner.req('/profile/switch', { id: gastId });
    let gast = await owner.page();
    assert.match(gast, /<option value="de-DE" selected/, 'Gast keeps German');
    assert.match(gast, /<option value="12" selected/, 'Gast got the new interval');
    await owner.req('/profile/switch', { id: timonId });
    form = cfgForm(await owner.page());
    assert.equal(form.get('language'), 'en-US');
    form.set('language', 'fr-FR');
    form.delete('rows');
    for (const id of ['trending-movie', 'foryou-movie']) form.append('rows', id);
    form.set('scope', 'all');
    assert.equal((await owner.req('/configure', form)).status, 303);
    await owner.req('/profile/switch', { id: gastId });
    gast = await owner.page();
    assert.match(gast, /<option value="fr-FR" selected/, 'a changed language reaches Gast too');
    const m = await json(installUrl(gast));
    const ids = m.catalogs.map((c: any) => c.id);
    assert.ok(ids.includes('trending-movie') && !ids.includes('popular-movie'), ids.join());
    await owner.req('/profile/switch', { id: timonId });
  });

  test('a leaked install URL can not read keys', async () => {
    const thief = new Client();
    const url = installUrl(await owner.page());
    await thief.req(url.replace('manifest.json', 'configure').replace(B, ''));
    assert.equal((await thief.req('/export', { keys: '1' })).status, 403);
    const plain = await (await thief.req('/export', {})).text();
    assert.ok(!plain.includes(AI_KEY) && !plain.includes(TMDB_KEY));
    // switching profile keeps the "no password" status
    const gastId = (await thief.page()).match(/<option value="([^"]+)"[^>]*>Gast</)![1];
    await thief.req('/profile/switch', { id: gastId });
    assert.equal((await thief.req('/export', { keys: '1' })).status, 403);
  });

  test('password log-in can export keys', async () => {
    assert.equal((await owner.req('/account/password', { password: 'correct-horse-1', password2: 'correct-horse-1' })).status, 303);
    const accountId = (await owner.page()).match(/account ID: <code>([^<]+)<\/code>/)![1];
    const me = new Client();
    assert.equal((await me.req('/login', { accountId, password: 'wrong-password-1' })).status, 401);
    assert.equal((await me.req('/login', { accountId, password: 'correct-horse-1' })).status, 303);
    const file = await (await me.req('/export', { keys: '1' })).json() as any;
    assert.equal(file.keys.aiKey, AI_KEY);
  });

  test('profile names are escaped (no XSS)', async () => {
    await owner.req('/profile/new', { label: '<script>alert(1)</script>' });
    const html = await owner.page();
    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    const id = html.match(/<option value="([^"]+)" selected>&lt;script/)![1];
    assert.equal((await owner.req('/profile/delete', { id })).status, 303);
  });

  test('Ollama URL must be public https (no SSRF)', async () => {
    const form = cfgForm(await owner.page());
    form.set('aiProvider', 'ollama');
    form.set('aiBaseUrl', 'http://127.0.0.1:11434');
    form.set('scope', 'this');
    const r = await owner.req('/configure', form);
    assert.equal(r.status, 400);
    assert.match(await r.text(), /Nothing saved/);
  });

  test('AI search: descriptions use the AI, short titles do not', async () => {
    const base = installUrl(await owner.page()).replace('/manifest.json', '');
    const before = aiCalls.length;
    const [movies, series] = await Promise.all([
      json(`${base}/catalog/movie/search/search=${encodeURIComponent('film mit traum im traum')}.json`),
      json(`${base}/catalog/series/search/search=${encodeURIComponent('film mit traum im traum')}.json`),
    ]);
    assert.equal(movies.metas[0]?.id, 'tt1375666');
    assert.equal(series.metas[0]?.id, 'tt0903747');
    assert.equal(aiCalls.length - before, 1, 'one AI call for movies + series');
    await json(`${base}/catalog/movie/search/search=inception.json`).catch(() => null);
    assert.equal(aiCalls.length - before, 1, 'short query without AI');
  });

  test('kids mode filters by age and genre', async () => {
    const form = cfgForm(await owner.page());
    form.set('kidsOn', '1');
    form.set('kidsAge', '12');
    form.delete('kidsBlock');
    form.append('kidsBlock', 'crime');
    form.set('scope', 'this');
    form.set('hideWatched', '');
    form.delete('hideWatched');
    assert.equal((await owner.req('/configure', form)).status, 303);
    const base = installUrl(await owner.page()).replace('/manifest.json', '');
    const r = await json(`${base}/catalog/movie/trending-movie.json`);
    const ids = r.metas.map((m: any) => m.id);
    assert.ok(ids.includes('tt1375666'), 'FSK 12 stays');
    assert.ok(!ids.includes('tt0110912'), 'FSK 16 + crime removed');
  });

  test('rotating genres: daily genres from the chosen pool, named after the genre', async () => {
    const form = cfgForm(await owner.page());
    form.append('rows', 'cycle-1');
    form.append('rows', 'cycle-2');
    form.append('rows', 'cycle-3');
    form.delete('cyclePool');
    form.append('cyclePool', 'genre-comedy');
    form.append('cyclePool', 'genre-docs');
    form.set('cycleMode', 'random');
    form.set('scope', 'this');
    assert.equal((await owner.req('/configure', form)).status, 303);
    const page = await owner.page();
    assert.match(page, /value="genre-comedy" checked/);
    assert.doesNotMatch(page, /value="genre-horror" checked/);
    assert.match(page, />(Comedies|Documentaries)<\/span>/, 'config shows today\'s genre');
    const m = await json(installUrl(page));
    const names = m.catalogs.filter((c: any) => c.id.startsWith('cycle-')).map((c: any) => c.name).sort();
    assert.deepEqual(names, ['Comedies', 'Documentaries'], 'two genres in the pool = two rows, third slot hidden');
    const base = installUrl(page).replace('/manifest.json', '');
    assert.equal((await fetch(`${base}/catalog/mixed/cycle-1.json`)).status, 200);
  });

  test('search "like X" returns similar titles without an AI call', async () => {
    const base = installUrl(await owner.page()).replace('/manifest.json', '');
    const before = aiCalls.length;
    const r = await json(`${base}/catalog/movie/search/search=${encodeURIComponent('like Inception')}.json`);
    assert.ok(r.metas.length > 0, 'recommendations for Inception');
    assert.ok(!r.metas.some((m: any) => m.id === 'tt1375666'), 'not the title itself');
    assert.equal(aiCalls.length, before, 'no AI call');
    const s = await json(`${base}/catalog/series/search/search=${encodeURIComponent('like Inception')}.json`);
    assert.equal(s.metas.length, 0, 'Inception is a movie, so no series');
  });

  test('RPDB key: rating posters in rows, bad keys rejected', async () => {
    let form = cfgForm(await owner.page());
    form.set('rpdbKey', 't0/../evil');
    form.set('scope', 'this');
    assert.equal((await owner.req('/configure', form)).status, 400, 'key that could change the URL is refused');
    form = cfgForm(await owner.page());
    form.set('rpdbKey', 't0-free-rpdb');
    form.set('scope', 'this');
    assert.equal((await owner.req('/configure', form)).status, 303);
    const page = await owner.page();
    assert.doesNotMatch(page, /t0-free-rpdb/, 'key is masked on the page');
    const base = installUrl(page).replace('/manifest.json', '');
    const r = await json(`${base}/catalog/movie/trending-movie.json`);
    assert.ok(r.metas.length > 0);
    assert.ok(r.metas.every((m: any) => m.poster.startsWith(`https://api.ratingposterdb.com/t0-free-rpdb/imdb/poster-default/${m.id}.jpg`)));
  });
});
