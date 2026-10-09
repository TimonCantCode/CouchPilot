import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultName, discover, isOn, LIKE, mixUp, pickGenres, orderedRowIds, ROWS, season } from './addon.ts';
import { parseItems } from './ai.ts';
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
