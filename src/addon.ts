import { ensureFresh, MOOD_NAMES, moodSlot, personalRow } from './personal.ts';
import { anilistList, cinemetaMeta, enhancedMeta, cinemetaSearch, currentSeason, kitsuMeta, tmdbList, type Meta, type Type } from './sources.ts';
import { cached, touchSeen, type Settings } from './store.ts';

export type Ctx = { settings: Settings; tmdbKey?: string; userId?: string };
// "mixed" = movies and series in one row. Nuvio opens every item with its own type.
export type RowType = Type | 'mixed';
type Row = {
  type: RowType;
  name: string;
  group: string;
  personal?: boolean; // content comes from the background job
  dynamicTitle?: boolean; // title comes from the job (Because You Watched X, genre mix)
  needsTmdb?: boolean;
  parts?: [string, string]; // mixed row: movie and series row, alternating
  fetch?: (ctx: Ctx, page: number) => Promise<Meta[]>;
};

const FORYOU = 'For You (watch history + AI)';
const personal = (type: RowType, name: string, extra: Partial<Row> = {}): Row => ({ type, name, group: FORYOU, personal: true, needsTmdb: true, ...extra });

const tmdbRow = (type: Type, name: string, path: string): Row => ({
  type,
  name,
  group: type === 'movie' ? 'Movies' : 'Series',
  needsTmdb: true,
  fetch: (ctx, page) => {
    if (!ctx.tmdbKey) throw new Error('no TMDB key'); // throw instead of caching []
    return tmdbList(path, type, ctx.tmdbKey, page, ctx.settings.language);
  },
});

const animeRow = (type: Type, name: string, vars: () => object): Row => ({
  type,
  name,
  group: 'Anime',
  fetch: (_ctx, page) => anilistList(vars(), type, page),
});

const mixRow = (name: string, movie: string, series: string, group = 'Mixed (movies + series)'): Row => ({
  type: 'mixed',
  name,
  group,
  needsTmdb: true,
  parts: [movie, series],
  personal: movie.startsWith('foryou-'),
});

// Default order = order here; users can change it on the config page
export const ROWS: Record<string, Row> = {
  'foryou-movie': personal('movie', 'Top Picks for You'),
  'foryou-series': personal('series', 'Top Picks for You'),
  'because-movie': personal('movie', 'Because You Watched', { dynamicTitle: true }),
  'because-series': personal('series', 'Because You Watched', { dynamicTitle: true }),
  'new-episodes': personal('series', 'New Episodes of Your Shows'),
  'mood-movie': personal('movie', 'Tonight For You', { dynamicTitle: true }),
  'mix-movie-1': personal('movie', 'Your Genre Mix 1', { dynamicTitle: true }),
  'mix-movie-2': personal('movie', 'Your Genre Mix 2', { dynamicTitle: true }),
  'mix-series-1': personal('series', 'Your Genre Mix 1', { dynamicTitle: true }),
  'mix-series-2': personal('series', 'Your Genre Mix 2', { dynamicTitle: true }),
  'foryou-mix': mixRow('Top Picks for You', 'foryou-movie', 'foryou-series', FORYOU),
  'trending-mix': mixRow('Trending Now', 'trending-movie', 'trending-series'),
  'popular-mix': mixRow('Popular on Nuvio', 'popular-movie', 'popular-series'),
  'toprated-mix': mixRow('Top Rated', 'toprated-movie', 'toprated-series'),
  'trending-movie': tmdbRow('movie', 'Trending Movies', '/trending/movie/week'),
  'trending-series': tmdbRow('series', 'Trending Shows', '/trending/tv/week'),
  'popular-movie': tmdbRow('movie', 'Popular Movies', '/movie/popular'),
  'popular-series': tmdbRow('series', 'Popular Shows', '/tv/popular'),
  'new-movie': tmdbRow('movie', 'New in Cinemas', '/movie/now_playing'),
  'new-series': tmdbRow('series', 'Airing This Week', '/tv/on_the_air'),
  'toprated-movie': tmdbRow('movie', 'Top Rated Movies', '/movie/top_rated'),
  'toprated-series': tmdbRow('series', 'Top Rated Shows', '/tv/top_rated'),
  'foryou-anime': { ...personal('series', 'Anime Picks for You'), group: 'Anime', needsTmdb: false },
  'anime-trending': animeRow('series', 'Trending Anime', () => ({ sort: ['TRENDING_DESC'], format: 'TV' })),
  'anime-season': animeRow('series', "This Season's Anime", () => ({ sort: ['POPULARITY_DESC'], ...currentSeason() })),
  'anime-popular': animeRow('series', 'Most Popular Anime', () => ({ sort: ['POPULARITY_DESC'], format: 'TV' })),
  'anime-new': animeRow('series', 'New Anime Releases', () => ({ sort: ['START_DATE_DESC'], format: 'TV', status_in: ['RELEASING', 'FINISHED'], popularity_greater: 5000 })),
  'anime-movies': animeRow('movie', 'Anime Movies', () => ({ sort: ['POPULARITY_DESC'], format: 'MOVIE' })),
  'anime-movies-new': animeRow('movie', 'New Anime Movies', () => ({ sort: ['START_DATE_DESC'], format: 'MOVIE', status_in: ['FINISHED'], popularity_greater: 2000 })),
};

// Order: the user's saved order, new rows appended in default order
export function orderedRowIds(settings: Settings): string[] {
  const known = settings.order.filter((id) => id in ROWS);
  return [...known, ...Object.keys(ROWS).filter((id) => !known.includes(id))];
}

const storedKey = (id: string, settings: Settings) => (id === 'mood-movie' ? `mood-movie:${moodSlot(settings.timezone)}` : id);

async function rowName(id: string, ctx: Ctx): Promise<string> {
  const custom = ctx.settings.names[id];
  if (custom) return custom;
  const row = ROWS[id];
  if (row.dynamicTitle && ctx.userId) {
    const title = (await personalRow(ctx.userId, storedKey(id, ctx.settings)))?.title;
    if (id.startsWith('because-')) return title ? `Because You Watched ${title}` : row.name;
    if (title) return title;
  }
  if (id === 'mood-movie') return MOOD_NAMES[moodSlot(ctx.settings.timezone)];
  return row.name;
}

const usable = (id: string, ctx: Ctx) => {
  const row = ROWS[id];
  return ctx.settings.rows.includes(id) && (!row.personal || !!ctx.userId) && (!row.needsTmdb || !!ctx.tmdbKey);
};

export async function manifest(ctx: Ctx) {
  const ids = orderedRowIds(ctx.settings).filter((id) => usable(id, ctx));
  const catalogs = await Promise.all(ids.map(async (id) => ({ type: ROWS[id].type, id, name: await rowName(id, ctx), extra: [{ name: 'skip' }] })));
  return {
    id: 'community.couchpilot',
    version: '0.5.0',
    name: 'Couchpilot',
    description: 'Personal rows, Cinemeta-replacement metadata and AI recommendations from your watch history. Unofficial community addon.',
    resources: ['catalog', { name: 'meta', types: ['movie', 'series'], idPrefixes: ['tt', 'kitsu:'] }],
    types: ['movie', 'series', 'mixed'],
    idPrefixes: ['tt', 'kitsu:'],
    catalogs: [
      ...catalogs,
      { type: 'movie', id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }] },
      { type: 'series', id: 'search', name: 'Search', extra: [{ name: 'search', isRequired: true }] },
    ],
    behaviorHints: { configurable: true },
  };
}

// Alternate movie, series, movie, … without duplicates
const interleave = (a: Meta[], b: Meta[]) => {
  const out: Meta[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...[a[i], b[i]].filter((m): m is Meta => !!m));
  return [...new Map(out.map((m) => [m.id, m])).values()];
};

async function rowMetas(id: string, ctx: Ctx, page: number): Promise<Meta[]> {
  const row = ROWS[id];
  if (row.parts) {
    const [a, b] = await Promise.all(row.parts.map((p) => rowMetas(p, ctx, page)));
    return interleave(a, b);
  }
  if (row.personal) {
    if (!ctx.userId || page > 1) return []; // single page only
    void ensureFresh(ctx.userId, ctx.settings.refreshHours);
    return (await personalRow(ctx.userId, storedKey(id, ctx.settings)))?.metas ?? [];
  }
  const { language, refreshHours } = ctx.settings;
  return cached(`cat2:${id}:${page}:${language}:${refreshHours}`, refreshHours * 3600, () => row.fetch!(ctx, page));
}

export async function catalog(ctx: Ctx, type: RowType, id: string, extra: URLSearchParams) {
  if (ctx.userId) void touchSeen(ctx.userId);
  if (id === 'search') {
    const q = extra.get('search')?.trim().slice(0, 100);
    return { metas: q && type !== 'mixed' ? await cinemetaSearch(type, q) : [] };
  }
  const row = ROWS[id];
  if (!row || row.type !== type || !usable(id, ctx)) return { metas: [] };
  // ponytail: round instead of floor, filtered pages return < 20 items so skip is uneven
  const page = Math.round(Number(extra.get('skip') ?? 0) / 20) + 1;
  if (!(page >= 1 && page <= 25)) return { metas: [] };
  return { metas: await rowMetas(id, ctx, page), cacheMaxAge: row.personal ? 600 : 3600 };
}

// Metadata: plain Cinemeta, or Cinemeta + TMDB (localized texts, logos, cast, trailers, episode stills) when a TMDB key is set
export async function meta(type: Type, id: string, ctx?: Ctx) {
  const m = ctx?.settings.meta;
  if (id.startsWith('tt') && ctx?.tmdbKey && m?.source === 'enhanced') return enhancedMeta(type, id, ctx.tmdbKey, ctx.settings.language, m);
  if (id.startsWith('tt')) return cinemetaMeta(type, id);
  if (id.startsWith('kitsu:')) return { meta: await kitsuMeta(Number(id.split(':')[1])) };
  return { meta: null };
}
