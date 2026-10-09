import { aiSearch, ensureFresh, moodName, moodSlot, personalRow, watchedIds } from './personal.ts';
import { ageFrom, anilistList, cinemetaMeta, enhancedMeta, cinemetaSearch, currentSeason, kitsuMeta, tmdbDetails, tmdbIdFor, tmdbKeyword, tmdbList, type Meta, type Type } from './sources.ts';
import { cached, configByUser, DEFAULT_SETTINGS, touchSeen, type Settings } from './store.ts';

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

const interleave = (a: Meta[], b: Meta[]) => {
  const out: Meta[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) out.push(...[a[i], b[i]].filter((m): m is Meta => !!m));
  return [...new Map(out.map((m) => [m.id, m])).values()];
};

// Genre rows like Netflix: popular titles of one genre, movies and series alternating where TMDB has a TV genre.
// Anime (genre 16) is left out except in Family, it has its own rows.
const GENRES = 'Genres';
export const discover = (type: Type, genre: number) =>
  `/discover/${type === 'movie' ? 'movie' : 'tv'}?with_genres=${genre}${genre === 10751 ? '' : '&without_genres=16'}&sort_by=popularity.desc&vote_count.gte=${type === 'movie' ? 300 : 100}`;
const genreRow = (name: string, movie: number, tv?: number): Row => ({
  type: tv ? 'mixed' : 'movie',
  name,
  group: GENRES,
  needsTmdb: true,
  fetch: async (ctx, page) => {
    if (!ctx.tmdbKey) throw new Error('no TMDB key');
    const { language } = ctx.settings;
    const [a, b] = await Promise.all([
      tmdbList(discover('movie', movie), 'movie', ctx.tmdbKey, page, language),
      tv ? tmdbList(discover('series', tv), 'series', ctx.tmdbKey, page, language) : [],
    ]);
    return interleave(a, b);
  },
});

// Seasonal row: Halloween horror in October, Christmas movies in December, hidden the rest of the year
export const season = (now = new Date()) => (now.getMonth() === 9 ? 'halloween' : now.getMonth() === 11 ? 'christmas' : null);
const SEASON_NAMES = { halloween: ['Halloween Horror', 'Halloween-Horror'], christmas: ['Christmas Movies', 'Weihnachtsfilme'] } as const;
const seasonalRow: Row = {
  type: 'movie',
  name: 'Seasonal Picks',
  group: 'Movies',
  needsTmdb: true,
  fetch: async (ctx, page) => {
    const s = season();
    if (!s || !ctx.tmdbKey) return [];
    const kw = s === 'christmas' ? await tmdbKeyword('christmas', ctx.tmdbKey) : null;
    const path = s === 'halloween' ? '/discover/movie?with_genres=27&sort_by=popularity.desc&vote_count.gte=300' : kw ? `/discover/movie?with_keywords=${kw}&sort_by=popularity.desc&vote_count.gte=100` : '';
    return path ? tmdbList(path, 'movie', ctx.tmdbKey, page, ctx.settings.language) : [];
  },
};

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
  'saga-movie': personal('movie', 'Complete the Saga'),
  'person-movie': personal('movie', 'More from Your Favorites', { dynamicTitle: true }),
  'upcoming': personal('mixed', 'Coming Soon for You'),
  'custom-1': personal('mixed', 'Your AI Row 1', { dynamicTitle: true }),
  'custom-2': personal('mixed', 'Your AI Row 2', { dynamicTitle: true }),
  'custom-3': personal('mixed', 'Your AI Row 3', { dynamicTitle: true }),
  'foryou-mix': mixRow('Top Picks for You', 'foryou-movie', 'foryou-series', FORYOU),
  'trending-mix': mixRow('Trending Now', 'trending-movie', 'trending-series'),
  'popular-mix': mixRow('Popular on Nuvio', 'popular-movie', 'popular-series'),
  'toprated-mix': mixRow('Top Rated', 'toprated-movie', 'toprated-series'),
  'seasonal-movie': seasonalRow,
  'trending-movie': tmdbRow('movie', 'Trending Movies', '/trending/movie/week'),
  'trending-series': tmdbRow('series', 'Trending Shows', '/trending/tv/week'),
  'popular-movie': tmdbRow('movie', 'Popular Movies', '/movie/popular'),
  'popular-series': tmdbRow('series', 'Popular Shows', '/tv/popular'),
  'new-movie': tmdbRow('movie', 'New in Cinemas', '/movie/now_playing'),
  'new-series': tmdbRow('series', 'Airing This Week', '/tv/on_the_air'),
  'toprated-movie': tmdbRow('movie', 'Top Rated Movies', '/movie/top_rated'),
  'toprated-series': tmdbRow('series', 'Top Rated Shows', '/tv/top_rated'),
  'genre-action': genreRow('Action & Adventure', 28, 10759),
  'genre-comedy': genreRow('Comedies', 35, 35),
  'genre-scifi': genreRow('Sci-Fi & Fantasy', 878, 10765),
  'genre-horror': genreRow('Horror', 27),
  'genre-thriller': genreRow('Thrillers', 53),
  'genre-crime': genreRow('Crime', 80, 80),
  'genre-drama': genreRow('Dramas', 18, 18),
  'genre-romance': genreRow('Romance', 10749),
  'genre-mystery': genreRow('Mystery', 9648, 9648),
  'genre-family': genreRow('Family', 10751, 10751),
  'genre-docs': genreRow('Documentaries', 99, 99),
  'foryou-anime': { ...personal('series', 'Anime Picks for You'), group: 'Anime', needsTmdb: false },
  'anime-trending': animeRow('series', 'Trending Anime', () => ({ sort: ['TRENDING_DESC'], format: 'TV' })),
  'anime-season': animeRow('series', "This Season's Anime", () => ({ sort: ['POPULARITY_DESC'], ...currentSeason() })),
  'anime-popular': animeRow('series', 'Most Popular Anime', () => ({ sort: ['POPULARITY_DESC'], format: 'TV' })),
  'anime-new': animeRow('series', 'New Anime Releases', () => ({ sort: ['START_DATE_DESC'], format: 'TV', status_in: ['RELEASING', 'FINISHED'], popularity_greater: 5000 })),
  'anime-movies': animeRow('movie', 'Anime Movies', () => ({ sort: ['POPULARITY_DESC'], format: 'MOVIE' })),
  'anime-movies-new': animeRow('movie', 'New Anime Movies', () => ({ sort: ['START_DATE_DESC'], format: 'MOVIE', status_in: ['FINISHED'], popularity_greater: 2000 })),
};

// German default names (metadata language de-*); other languages fall back to English
const DE: Record<string, string> = {
  'foryou-movie': 'Top-Empfehlungen für dich',
  'foryou-series': 'Top-Empfehlungen für dich',
  'because-movie': 'Weil du geschaut hast',
  'because-series': 'Weil du geschaut hast',
  'new-episodes': 'Neue Folgen deiner Serien',
  'mood-movie': 'Heute Abend für dich',
  'mix-movie-1': 'Dein Genre-Mix 1',
  'mix-movie-2': 'Dein Genre-Mix 2',
  'mix-series-1': 'Dein Genre-Mix 1',
  'mix-series-2': 'Dein Genre-Mix 2',
  'saga-movie': 'Vervollständige die Reihe',
  'person-movie': 'Mehr von deinen Favoriten',
  upcoming: 'Demnächst für dich',
  'custom-1': 'Deine KI-Reihe 1',
  'custom-2': 'Deine KI-Reihe 2',
  'custom-3': 'Deine KI-Reihe 3',
  'seasonal-movie': 'Saisonale Filme',
  'foryou-mix': 'Top-Empfehlungen für dich',
  'trending-mix': 'Gerade angesagt',
  'popular-mix': 'Beliebt auf Nuvio',
  'toprated-mix': 'Am besten bewertet',
  'trending-movie': 'Angesagte Filme',
  'trending-series': 'Angesagte Serien',
  'popular-movie': 'Beliebte Filme',
  'popular-series': 'Beliebte Serien',
  'new-movie': 'Neu im Kino',
  'new-series': 'Diese Woche neu',
  'toprated-movie': 'Am besten bewertete Filme',
  'toprated-series': 'Am besten bewertete Serien',
  'genre-action': 'Action & Abenteuer',
  'genre-comedy': 'Komödien',
  'genre-scifi': 'Sci-Fi & Fantasy',
  'genre-horror': 'Horror',
  'genre-thriller': 'Thriller',
  'genre-crime': 'Krimi',
  'genre-drama': 'Dramen',
  'genre-romance': 'Liebesfilme',
  'genre-mystery': 'Mystery',
  'genre-family': 'Familie',
  'genre-docs': 'Dokus',
  'foryou-anime': 'Anime-Empfehlungen für dich',
  'anime-trending': 'Angesagte Anime',
  'anime-season': 'Anime dieser Season',
  'anime-popular': 'Beliebteste Anime',
  'anime-new': 'Neue Anime',
  'anime-movies': 'Anime-Filme',
  'anime-movies-new': 'Neue Anime-Filme',
};
export const defaultName = (id: string, lang: string) => (lang.startsWith('de') && DE[id]) || ROWS[id].name;

// Shown? Rows added in an update are on by default for people who saved their rows before the update
export const isOn = (id: string, s: Settings) => {
  if (id.startsWith('custom-')) return !!s.customRows[Number(id.slice(7)) - 1]?.prompt;
  return s.rows.includes(id) || (!s.order.includes(id) && DEFAULT_SETTINGS.rows.includes(id));
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
    const de = ctx.settings.language.startsWith('de');
    if (id.startsWith('because-')) return title ? (de ? `Weil du ${title} geschaut hast` : `Because You Watched ${title}`) : defaultName(id, ctx.settings.language);
    if (title) return title;
  }
  if (id === 'mood-movie') return moodName(moodSlot(ctx.settings.timezone), ctx.settings.language);
  const s = id === 'seasonal-movie' ? season() : null;
  if (s) return SEASON_NAMES[s][ctx.settings.language.startsWith('de') ? 1 : 0];
  return defaultName(id, ctx.settings.language);
}

const usable = (id: string, ctx: Ctx) => {
  const row = ROWS[id];
  if (id === 'seasonal-movie' && !season()) return false;
  return isOn(id, ctx.settings) && (!row.personal || !!ctx.userId) && (!row.needsTmdb || !!ctx.tmdbKey);
};

export async function manifest(ctx: Ctx) {
  const ids = orderedRowIds(ctx.settings).filter((id) => usable(id, ctx));
  const search = ctx.settings.language.startsWith('de') ? 'Suche' : 'Search';
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
      { type: 'movie', id: 'search', name: search, extra: [{ name: 'search', isRequired: true }] },
      { type: 'series', id: 'search', name: search, extra: [{ name: 'search', isRequired: true }] },
    ],
    behaviorHints: { configurable: true },
  };
}

// Alternate movie, series, movie, … without duplicates

async function rowMetas(id: string, ctx: Ctx, page: number): Promise<Meta[]> {
  const row = ROWS[id];
  if (row.parts) {
    const [a, b] = await Promise.all(row.parts.map((p) => rowMetas(p, ctx, page)));
    return interleave(a, b);
  }
  if (row.personal) {
    if (!ctx.userId || page > 1) return []; // single page only
    void ensureFresh(ctx.userId, ctx.settings.refreshHours, ctx.settings.language);
    return (await personalRow(ctx.userId, storedKey(id, ctx.settings)))?.metas ?? [];
  }
  const { language, refreshHours } = ctx.settings;
  const metas = await cached(`cat2:${id}:${page}:${language}:${refreshHours}:${season() ?? ''}`, refreshHours * 3600, () => row.fetch!(ctx, page));
  if (!ctx.settings.hideWatched || !ctx.userId) return metas;
  const seen = new Set(await watchedIds(ctx.userId));
  return metas.filter((m) => !seen.has(m.id));
}

export async function catalog(ctx: Ctx, type: RowType, id: string, extra: URLSearchParams) {
  if (ctx.userId) void touchSeen(ctx.userId);
  if (id === 'search') {
    const q = extra.get('search')?.trim().slice(0, 100);
    if (!q || type === 'mixed') return { metas: [] };
    // Descriptions ("movie with the dream in a dream", 3+ words) also go to the AI; its hits come first
    const useAi = !!ctx.userId && q.split(/\s+/).length >= 3;
    const [plain, smart] = await Promise.all([
      cinemetaSearch(type, q).catch(() => [] as Meta[]),
      useAi ? configByUser(ctx.userId!).then((cfg) => aiSearch(cfg, q, type)).catch(() => [] as Meta[]) : ([] as Meta[]),
    ]);
    return { metas: await kidsFilter([...new Map([...smart, ...plain].map((m) => [m.id, m])).values()], ctx) };
  }
  const row = ROWS[id];
  if (!row || row.type !== type || !usable(id, ctx)) return { metas: [] };
  // ponytail: round instead of floor, filtered pages return < 20 items so skip is uneven
  const page = Math.round(Number(extra.get('skip') ?? 0) / 20) + 1;
  if (!(page >= 1 && page <= 25)) return { metas: [] };
  return { metas: await kidsFilter(await rowMetas(id, ctx, page), ctx), cacheMaxAge: row.personal ? 600 : 3600 };
}

// Kids mode: only titles with a known age rating up to the limit and none of the blocked genres
export const KID_GENRES: Record<string, number[]> = { horror: [27], thriller: [53], crime: [80], war: [10752, 10768], romance: [10749], mystery: [9648] };
async function kidsFilter(metas: Meta[], ctx: Ctx): Promise<Meta[]> {
  const k = ctx.settings.kids;
  if (!k?.on) return metas;
  if (!ctx.tmdbKey) return []; // can't check ratings without TMDB: show nothing rather than something unsuitable
  const blocked = new Set(k.blockGenres.flatMap((g) => KID_GENRES[g] ?? []));
  const ok = await Promise.all(
    metas.map(async (m) => {
      if (!m.id.startsWith('tt')) return false;
      const id = await tmdbIdFor(m.type, m.id, ctx.tmdbKey!).catch(() => null);
      const d = id ? await tmdbDetails(m.type, id, ctx.tmdbKey!, ctx.settings.language).catch(() => null) : null;
      const age = d ? ageFrom(d, m.type) : null;
      return age !== null && age <= k.maxAge && !(d.genres ?? []).some((g: any) => blocked.has(g.id));
    }),
  );
  return metas.filter((_, i) => ok[i]);
}

// Metadata: plain Cinemeta, or Cinemeta + TMDB (localized texts, logos, cast, trailers, episode stills) when a TMDB key is set
export async function meta(type: Type, id: string, ctx?: Ctx) {
  const m = ctx?.settings.meta;
  if (id.startsWith('tt') && ctx?.tmdbKey && m?.source === 'enhanced') return enhancedMeta(type, id, ctx.tmdbKey, ctx.settings.language, m);
  if (id.startsWith('tt')) return cinemetaMeta(type, id);
  if (id.startsWith('kitsu:')) return { meta: await kitsuMeta(Number(id.split(':')[1])) };
  return { meta: null };
}
