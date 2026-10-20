import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshness, shuffleMetas, animeKidsOk, defaultName, discover, GEMS_PATHS, isOn, SHORT_PATH, LIKE, mixUp, pickGenres, orderedRowIds, ROWS, season } from './addon.ts';
import { parseItems } from './ai.ts';
import { authError, isReauth } from './history.ts';
import { ageFrom, trailerFrom } from './sources.ts';
import { DEFAULT_SETTINGS } from './store.ts';

test('AI row/search reply is parsed strictly', () => {
  const r = parseItems('ok: {"title":"Cozy\\nSci-Fi","items":[{"name":"Alien","year":1979,"type":"movie"},{"name":"Dark","type":"series"},{"name":""},{"type":"movie"},{"name":"X","year":"1999","type":"evil"}]}');
  assert.equal(r.title, 'Cozy Sci-Fi');
  assert.deepEqual(r.items, [
    { name: 'Alien', year: 1979, type: 'movie' },
    { name: 'Dark', year: undefined, type: 'series' },
    { name: 'X', year: undefined, type: 'movie' },
  ]);
  assert.deepEqual(parseItems('nothing here'), { title: '', items: [] });
});

test('trailer: own language first, then official trailer', () => {
  const d = { videos: { results: [
    { site: 'YouTube', type: 'Teaser', key: 'teaser-en', iso_639_1: 'en', official: true },
    { site: 'YouTube', type: 'Trailer', key: 'trailer-en', iso_639_1: 'en', official: true },
    { site: 'Vimeo', type: 'Trailer', key: 'vimeo', iso_639_1: 'de' },
    { site: 'YouTube', type: 'Trailer', key: 'trailer-de', iso_639_1: 'de', official: false },
  ] } };
  assert.equal(trailerFrom(d, 'de-DE'), 'trailer-de');
  assert.equal(trailerFrom(d, 'en-US'), 'trailer-en');
  assert.equal(trailerFrom({}, 'en-US'), null);
});

test('age rating: FSK first, US fallback, unknown stays null', () => {
  const movie = (de: string, us: string) => ({ release_dates: { results: [
    { iso_3166_1: 'DE', release_dates: [{ certification: de }] },
    { iso_3166_1: 'US', release_dates: [{ certification: us }] },
  ] } });
  assert.equal(ageFrom(movie('12', 'R'), 'movie'), 12);
  assert.equal(ageFrom(movie('', 'PG-13'), 'movie'), 12);
  assert.equal(ageFrom(movie('', ''), 'movie'), null);
  assert.equal(ageFrom({ adult: true }, 'movie'), 18);
  assert.equal(ageFrom({ content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-MA' }] } }, 'series'), 16);
});

test('kids mode: anime without a rating goes by AniList genres', () => {
  const k = (maxAge: number, blockGenres: string[] = []) => ({ on: true, maxAge, blockGenres });
  assert.ok(animeKidsOk(['Action', 'Adventure'], k(12)));
  assert.ok(!animeKidsOk(['Action', 'Adventure'], k(6)), 'under 12 only gentle genres');
  assert.ok(animeKidsOk(['Comedy', 'Slice of Life'], k(0)));
  assert.ok(!animeKidsOk(['Comedy', 'Ecchi'], k(16)), 'never ecchi');
  assert.ok(!animeKidsOk(['Romance', 'Comedy'], k(12, ['romance'])), 'blocked genre');
  assert.ok(!animeKidsOk([], k(16)), 'unknown genres stay out');
});

test('rows: new rows default on, AI rows only with a prompt', () => {
  const saved = { ...DEFAULT_SETTINGS, rows: ['trending-movie'], order: ['trending-movie', 'popular-movie'] };
  assert.ok(isOn('trending-movie', saved));
  assert.ok(!isOn('popular-movie', saved), 'switched off by the user');
  assert.ok(isOn('saga-movie', saved), 'added in an update and on by default');
  assert.ok(!isOn('custom-1', saved));
  assert.ok(isOn('custom-1', { ...saved, customRows: [{ prompt: 'cozy sci-fi' }] }));
  for (const id of Object.keys(ROWS)) assert.ok(defaultName(id, 'de-DE') && defaultName(id, 'en-US'), id);
  assert.equal(defaultName('trending-movie', 'de-DE'), 'Angesagte Filme');
  assert.equal(defaultName('trending-movie', 'fr-FR'), 'Trending Movies');
});

test('seasonal row only in October and December', () => {
  assert.equal(season(new Date('2026-10-15')), 'halloween');
  assert.equal(season(new Date('2026-12-01')), 'christmas');
  assert.equal(season(new Date('2026-07-01')), null);
});

test('save for all copies only what changed', async () => {
  const { apply, changes } = await import('./diff.ts');
  const english = { ...DEFAULT_SETTINGS, language: 'en-US', refreshHours: 6, meta: { ...DEFAULT_SETTINGS.meta } };
  const german = { ...DEFAULT_SETTINGS, language: 'de-DE', refreshHours: 6, meta: { ...DEFAULT_SETTINGS.meta, cast: false } };
  // nothing changed -> nothing to copy (also when the form sends the rows in a different order)
  assert.deepEqual(changes(english, { ...english, order: [...Object.keys(ROWS)].reverse().filter((id) => isOn(id, english)) }).length, 1, 'only a real reorder counts');
  assert.deepEqual(changes(english, structuredClone(english)), []);
  const formOrder = [...orderedRowIds(english).filter((id) => isOn(id, english)), ...orderedRowIds(english).filter((id) => !isOn(id, english))];
  assert.deepEqual(changes(english, { ...english, order: formOrder }), [], 'the page lists active rows first, that is no change');
  // English profile changes the refresh interval and trailers
  const edited = { ...english, refreshHours: 12, meta: { ...english.meta, trailers: false } };
  const out = apply(german, changes(english, edited), edited);
  assert.equal(out.refreshHours, 12);
  assert.equal(out.meta.trailers, false);
  assert.equal(out.language, 'de-DE', 'German stays German');
  assert.equal(out.meta.cast, false, 'own meta choices stay');
  // switching one row on only adds that row
  const withRow = { ...english, rows: [...english.rows, 'toprated-movie'] };
  const g2 = apply({ ...german, rows: ['trending-movie'], order: Object.keys(ROWS) }, changes(english, withRow), withRow);
  assert.deepEqual(g2.rows.sort(), ['toprated-movie', 'trending-movie']);
});

test('genre rows: off by default, anime left out, family keeps animation', () => {
  const ids = Object.keys(ROWS).filter((id) => id.startsWith('genre-'));
  assert.ok(ids.length >= 10);
  for (const id of ids) assert.equal(isOn(id, DEFAULT_SETTINGS), false, `${id} must not switch itself on for existing users`);
  assert.equal(ROWS['genre-comedy'].type, 'mixed');
  assert.equal(ROWS['genre-horror'].type, 'movie'); // TMDB has no TV horror genre
  assert.match(discover('series', 35), /^\/discover\/tv\?with_genres=35&without_genres=16&/);
  assert.doesNotMatch(discover('movie', 10751), /without_genres/);
});

test('rotating genres: same pick all day, distinct, history-weighted', () => {
  const pool = ['genre-action', 'genre-comedy', 'genre-horror', 'genre-docs', 'genre-drama'];
  const a = pickGenres(pool, () => 1, 'u1:2026-10-09');
  assert.deepEqual(a, pickGenres(pool, () => 1, 'u1:2026-10-09'), 'stable within a day');
  assert.equal(new Set(a).size, 3);
  assert.ok(a.every((g) => pool.includes(g)));
  assert.deepEqual(pickGenres(['genre-docs'], () => 1, 'x'), ['genre-docs'], 'fewer genres than slots');
  // a genre with weight 9 vs 1 should lead most days
  const days = Array.from({ length: 200 }, (_, d) => pickGenres(pool, (id) => (id === 'genre-horror' ? 9 : 1), `u1:${d}`, 1)[0]);
  assert.ok(days.filter((g) => g === 'genre-horror').length > 100, 'liked genre comes up more often');
  assert.ok(new Set(days).size > 1, 'others still come up');
});

test('similar search pattern and stable shuffle', () => {
  assert.equal('like Inception'.match(LIKE)?.[1], 'Inception');
  assert.equal('ähnlich wie Dark'.match(LIKE)?.[1], 'Dark');
  assert.equal('Wie Breaking Bad'.match(LIKE)?.[1], 'Breaking Bad');
  assert.equal('Inception'.match(LIKE), null);
  const xs = Array.from({ length: 20 }, (_, i) => i);
  const a = mixUp(xs, 's', 3);
  assert.deepEqual(a.slice(0, 3), [0, 1, 2], 'best picks stay first');
  assert.deepEqual([...a].sort((x, y) => x - y), xs, 'nothing lost or duplicated');
  assert.deepEqual(a, mixUp(xs, 's', 3), 'same seed, same order');
  assert.notDeepEqual(a, mixUp(xs, 't', 3), 'new window, new order');
});

test('user count on the homepage is rounded down and hidden when small', async () => {
  const { usersLabel } = await import('./web.ts');
  assert.equal(usersLabel(7), null);
  assert.equal(usersLabel(10), '10+');
  assert.equal(usersLabel(137), '100+');
  assert.equal(usersLabel(2600), '2,500+');
});

test('context rows: short movies and hidden gems, off by default', () => {
  assert.match(SHORT_PATH, /with_runtime\.lte=90/);
  assert.ok(GEMS_PATHS.every((p) => /vote_count\.lte=\d+/.test(p) && /vote_average\.gte=/.test(p)));
  assert.equal(ROWS['ctx-gems'].type, 'mixed');
  assert.equal(defaultName('ctx-short', 'de-DE'), 'Unter 90 Minuten');
  assert.equal(isOn('ctx-gems', DEFAULT_SETTINGS), false);
});

test('shuffle: every row mixes except the date-ordered ones; keepTop only holds personal rows', () => {
  const metas: any[] = Array.from({ length: 30 }, (_, i) => ({ id: `tt${i}`, type: 'movie', name: `T${i}` }));
  const ids = (x: any[]) => x.map((m) => m.id).join();
  const dated = new Set(['upcoming', 'new-episodes', 'saga-movie', 'anime-new', 'anime-movies-new']);
  const s = { ...DEFAULT_SETTINGS, shuffle: true, shuffleHours: 0, keepTop: false };
  for (const id of Object.keys(ROWS)) {
    const a = shuffleMetas(id, metas, s, 1).metas;
    const b = shuffleMetas(id, metas, s, 1).metas;
    if (dated.has(id)) assert.equal(ids(a), ids(metas), `${id} keeps its date order`);
    else {
      assert.notEqual(ids(a), ids(b), `${id} gets a new order on every load`);
      assert.equal(a.length, 30, `${id}: nothing lost`);
    }
  }
  const personal = Object.keys(ROWS).find((id) => ROWS[id].personal)!;
  const other = Object.keys(ROWS).find((id) => !ROWS[id].personal && !dated.has(id))!;
  for (let i = 0; i < 5; i++) {
    assert.equal(ids(shuffleMetas(personal, metas, { ...s, keepTop: true }, 1).metas.slice(0, 3)), 'tt0,tt1,tt2', 'top 3 stay');
    assert.equal(shuffleMetas(other, metas, { ...s, keepTop: true }, 1).metas.length, 30);
  }
  assert.equal(ids(shuffleMetas(other, metas, { ...s, shuffle: false }, 1).metas), ids(metas), 'off: untouched');
  const timed = { ...s, shuffleHours: 6 };
  assert.equal(ids(shuffleMetas(other, metas, timed, 1, 'u').metas), ids(shuffleMetas(other, metas, timed, 1, 'u').metas), 'timed: same order inside the window');
});

test('freshness boost: newer releases come first more often', () => {
  assert.deepEqual([2026, 2025, 2023, 2020, undefined].map((y) => freshness({ releaseInfo: y ? String(y) : undefined }, 2026)), [3, 3, 2, 1, 1]);
  const metas: any[] = Array.from({ length: 20 }, (_, i) => ({ id: `tt${i}`, releaseInfo: i < 10 ? '2026' : '1990' }));
  let fresh = 0;
  for (let i = 0; i < 100; i++) fresh += mixUp(metas, `s${i}`, 0, (m) => freshness(m, 2026)).slice(0, 10).filter((m) => m.releaseInfo === '2026').length;
  assert.ok(fresh / 100 > 6.5, `new titles dominate the top 10 (avg ${fresh / 100})`);
  assert.ok(fresh / 100 < 10, 'but not always');
});

test('token refresh errors: only known auth codes need a new login', () => {
  const e = (status: number | undefined, body?: string) => isReauth(authError({ status, body }));
  assert.ok(e(400, '{"code":400,"error_code":"refresh_token_not_found","msg":"Invalid Refresh Token: Refresh Token Not Found"}'));
  assert.ok(e(400, '{"error":"invalid_grant","error_description":"Invalid Refresh Token"}'));
  assert.ok(e(401, '{"error":"invalid_grant"}'));
  assert.ok(!e(400, '{"error_code":"validation_failed"}')); // unknown 400 stays a real error
  assert.ok(!e(400, 'not json'));
  assert.ok(!e(500, '{"error_code":"refresh_token_not_found"}'));
  assert.ok(!e(undefined)); // network error / timeout
  assert.deepEqual(authError({ status: 400, body: '{"error_code":"x","msg":"m","access_token":"secret"}' }), { status: 400, code: 'x', text: 'm' });
});
