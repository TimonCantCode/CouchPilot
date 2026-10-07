import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultName, isOn, ROWS, season } from './addon.ts';
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
