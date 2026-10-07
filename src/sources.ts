import { cached } from './store.ts';

const TMDB = 'https://api.themoviedb.org/3';
const IMG = 'https://image.tmdb.org/t/p';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const ANILIST = 'https://graphql.anilist.co';
const ANIME_MAP_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';

export type Type = 'movie' | 'series';
export type Meta = {
  id: string;
  type: Type;
  name: string;
  poster?: string;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  genres?: string[];
  // YouTube trailer: Nuvio autoplays it on the home screen and the detail page
  trailers?: { source: string; type: string }[];
  trailerStreams?: { ytId: string; title: string }[];
};

const withTrailer = (m: Meta, ytId: string | null | undefined): Meta =>
  ytId ? { ...m, trailers: [{ source: ytId, type: 'Trailer' }], trailerStreams: [{ ytId, title: m.name }] } : m;

// "fetch failed" alone says nothing: add the network cause (ENOTFOUND, ECONNRESET, …) and the host
export const netError = (err: any, url: string) =>
  new Error(`${err?.message ?? err}${err?.cause?.code ? ` (${err.cause.code})` : err?.cause?.message ? ` (${err.cause.message})` : ''} @ ${new URL(url).host}`);

async function getJson(url: string, init?: RequestInit): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) }).catch((err) => {
    throw netError(err, url);
  });
  if (!r.ok) throw new Error(`${r.status} ${url.replace(/api_key=[^&]+/, 'api_key=***')}`);
  return r.json();
}

const logoFor = (imdb: string) => `https://images.metahub.space/logo/medium/${imdb}/img`;
const year = (d?: string | number | null) => (d ? String(d).slice(0, 4) : undefined);

// ---------- TMDB ----------

// Accepts a v3 API key and a v4 read token (starts with eyJ)
function tmdb(path: string, key: string, params: Record<string, string> = {}): Promise<any> {
  const url = new URL(TMDB + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const bearer = key.startsWith('eyJ');
  if (!bearer) url.searchParams.set('api_key', key);
  return getJson(url.toString(), bearer ? { headers: { Authorization: `Bearer ${key}` } } : undefined);
}

export const checkTmdbKey = (key: string) => tmdb('/configuration', key).then(() => true, () => false);

const tv = (type: Type) => (type === 'movie' ? 'movie' : 'tv');

const imdbFor = (type: Type, tmdbId: number, key: string) =>
  cached<string | null>(`tmdb:imdb:${type}:${tmdbId}`, 30 * 86400, async () =>
    (await tmdb(`/${tv(type)}/${tmdbId}/external_ids`, key)).imdb_id || null);

// IMDb -> TMDB ID (for Nuvio history, which only knows IMDb IDs)
export const tmdbIdFor = (type: Type, imdb: string, key: string) =>
  cached<number | null>(`tmdb:find:${type}:${imdb}`, 30 * 86400, async () => {
    const r = await tmdb(`/find/${imdb}`, key, { external_source: 'imdb_id' });
    return (type === 'movie' ? r.movie_results : r.tv_results)?.[0]?.id ?? null;
  });

export const genreMap = (type: Type, key: string, lang: string) =>
  cached<Record<number, string>>(`tmdb:genres:${type}:${lang}`, 7 * 86400, async () => {
    const { genres } = await tmdb(`/genre/${tv(type)}/list`, key, { language: lang });
    return Object.fromEntries(genres.map((g: any) => [g.id, g.name]));
  });

// Raw results of a TMDB list/recommendation (cached 12 h)
export const tmdbResults = (path: string, key: string, page: number, lang: string) =>
  cached<any[]>(`tmdb:res:${path}:${page}:${lang}`, 12 * 3600, async () =>
    (await tmdb(path, key, { page: String(page), language: lang })).results ?? []);

export const tmdbDetails = (type: Type, tmdbId: number, key: string, lang: string) =>
  cached<any>(`tmdb:det:${type}:${tmdbId}:${lang}`, 12 * 3600, () => tmdb(`/${tv(type)}/${tmdbId}`, key, { language: lang }));

// Discover with several genres (AND), well-known titles only
export const tmdbCollection = (id: number, key: string, lang: string) =>
  cached<any>(`tmdb:coll:${id}:${lang}`, 7 * 86400, () => tmdb(`/collection/${id}`, key, { language: lang }));
export const tmdbCredits = (type: Type, id: number, key: string) =>
  cached<any>(`tmdb:cred:${type}:${id}`, 7 * 86400, () => tmdb(`/${tv(type)}/${id}/credits`, key));
export const tmdbPersonMovies = (id: number, key: string, lang: string) =>
  cached<any>(`tmdb:pmov:${id}:${lang}`, 86400, () => tmdb(`/person/${id}/movie_credits`, key, { language: lang }));
export const tmdbSearch = (type: Type, query: string, year: number | undefined, key: string, lang: string) =>
  cached<any[]>(`tmdb:search:${type}:${query}:${year ?? ''}:${lang}`, 7 * 86400, async () => {
    const yearParam = year ? { [type === 'movie' ? 'primary_release_year' : 'first_air_date_year']: String(year) } : {};
    return (await tmdb(`/search/${tv(type)}`, key, { query, language: lang, ...yearParam })).results ?? [];
  });
// Best YouTube trailer: in the user's language if there is one, otherwise English
export const trailerOf = (type: Type, tmdbId: number, key: string, lang: string) =>
  cached<string | null>(`tmdb:trailer:${type}:${tmdbId}:${lang}`, 7 * 86400, async () => {
    const short = lang.slice(0, 2);
    const { results = [] } = await tmdb(`/${tv(type)}/${tmdbId}/videos`, key, { language: lang, include_video_language: `${short},en,null` });
    const yt = results.filter((v: any) => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type));
    const rank = (v: any) => (v.iso_639_1 === short ? 4 : 0) + (v.type === 'Trailer' ? 2 : 0) + (v.official ? 1 : 0);
    return yt.sort((a: any, b: any) => rank(b) - rank(a))[0]?.key ?? null;
  });

// Age rating (0/6/12/16/18) and genre IDs for the kids mode. German rating first, US as fallback; null = unknown.
const US_AGE: Record<string, number> = { G: 0, 'TV-Y': 0, 'TV-G': 0, PG: 6, 'TV-Y7': 6, 'TV-PG': 6, 'PG-13': 12, 'TV-14': 12, R: 16, 'TV-MA': 16, 'NC-17': 18 };
export const ageInfo = (type: Type, tmdbId: number, key: string) =>
  cached<{ age: number | null; genres: number[] }>(`tmdb:age:${type}:${tmdbId}`, 30 * 86400, async () => {
    const d = await tmdb(`/${tv(type)}/${tmdbId}`, key, { append_to_response: type === 'movie' ? 'release_dates' : 'content_ratings' });
    const pick = (cc: string): string | undefined =>
      type === 'movie'
        ? d.release_dates?.results?.find((r: any) => r.iso_3166_1 === cc)?.release_dates?.map((x: any) => x.certification).find(Boolean)
        : d.content_ratings?.results?.find((r: any) => r.iso_3166_1 === cc)?.rating || undefined;
    const de = pick('DE');
    const us = pick('US');
    const age = d.adult ? 18 : de && /^\d+$/.test(de) ? Number(de) : us && us in US_AGE ? US_AGE[us] : null;
    return { age, genres: (d.genres ?? []).map((g: any) => g.id) };
  });

// Keyword ID by name (e.g. "christmas"), looked up once instead of hard-coding TMDB IDs
export const tmdbKeyword = (name: string, key: string) =>
  cached<number | null>(`tmdb:kw:${name}`, 30 * 86400, async () =>
    ((await tmdb('/search/keyword', key, { query: name })).results ?? []).find((k: any) => k.name?.toLowerCase() === name)?.id ?? null);

export const discoverPath = (type: Type, genres: number[]) =>
  `/discover/${tv(type)}?with_genres=${genres.join(',')}&sort_by=popularity.desc&vote_count.gte=150`;

export const recommendationsPath = (type: Type, tmdbId: number) => `/${tv(type)}/${tmdbId}/recommendations`;

// TMDB results -> metas with IMDb ID, anime removed (anime only in anime rows)
export async function toMetas(results: any[], type: Type, key: string, lang: string): Promise<Meta[]> {
  const genres = await genreMap(type, key, lang);
  const metas = await Promise.all(
    results.map(async (r: any): Promise<Meta | null> => {
      const gids: number[] = r.genre_ids ?? r.genres?.map((g: any) => g.id) ?? [];
      if (['ja', 'zh', 'ko'].includes(r.original_language) && gids.includes(16)) return null; // anime/donghua only in anime rows
      const imdb = await imdbFor(type, r.id, key);
      if (!imdb || animeImdb.has(imdb)) return null; // without an IMDb ID stream addons find nothing
      const yt = await trailerOf(type, r.id, key, lang).catch(() => null);
      return withTrailer({
        id: imdb,
        type,
        name: r.title ?? r.name,
        poster: r.poster_path ? `${IMG}/w500${r.poster_path}` : undefined,
        background: r.backdrop_path ? `${IMG}/w1280${r.backdrop_path}` : undefined,
        logo: logoFor(imdb),
        description: r.overview || undefined,
        releaseInfo: year(r.release_date ?? r.first_air_date),
        genres: gids.map((g) => genres[g]).filter(Boolean),
      }, yt);
    }),
  );
  return metas.filter((m): m is Meta => m !== null);
}

export const tmdbList = async (path: string, type: Type, key: string, page: number, lang: string) =>
  toMetas(await tmdbResults(path, key, page, lang), type, key, lang);

// ---------- Anime: AniList + ID-Mapping (AniList -> IMDb / Kitsu) ----------

let anilistIds = new Map<number, { imdb?: string; kitsu?: number }>();
let kitsuToAnilist = new Map<number, number>();
let animeImdb = new Set<string>(); // all IMDb IDs that are anime
let imdbToAnilist = new Map<string, number>();

export async function loadAnimeMap() {
  try {
    const list: any[] = await getJson(ANIME_MAP_URL);
    const a = new Map<number, { imdb?: string; kitsu?: number }>();
    const k = new Map<number, number>();
    const imdb = new Set<string>();
    const i2a = new Map<string, number>();
    for (const e of list) {
      for (const id of e.imdb_id ?? []) imdb.add(id);
      if (!e.anilist_id) continue;
      for (const id of e.imdb_id ?? []) if (!i2a.has(id)) i2a.set(id, e.anilist_id); // first entry = usually season 1
      a.set(e.anilist_id, { imdb: e.imdb_id?.[0], kitsu: e.kitsu_id });
      if (e.kitsu_id) k.set(e.kitsu_id, e.anilist_id);
    }
    anilistIds = a;
    kitsuToAnilist = k;
    animeImdb = imdb;
    imdbToAnilist = i2a;
    console.log(`anime map: ${a.size} entries`);
  } catch (err) {
    console.error('loading anime map failed, keeping the old one', err); // ponytail: old map stays active
  }
}

const FIELDS = 'id format title{english romaji} description coverImage{extraLarge} bannerImage genres startDate{year month day} trailer{id site}';

async function anilist(query: string, variables: object): Promise<any> {
  const r = await getJson(ANILIST, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  return r.data;
}

const clean = (s?: string | null) => s?.replace(/<[^>]+>/g, '').replace(/\n{3,}/g, '\n\n').trim() || undefined;

function animeMeta(m: any, type: Type): Meta | null {
  const ids = anilistIds.get(m.id);
  const id = ids?.imdb ?? (ids?.kitsu ? `kitsu:${ids.kitsu}` : null);
  if (!id) return null;
  return withTrailer({
    id,
    type,
    name: m.title.english ?? m.title.romaji,
    poster: m.coverImage?.extraLarge,
    background: m.bannerImage ?? undefined,
    logo: id.startsWith('tt') ? logoFor(id) : undefined,
    description: clean(m.description),
    releaseInfo: year(m.startDate?.year),
    genres: m.genres,
  }, m.trailer?.site === 'youtube' ? m.trailer.id : null);
}

export function currentSeason(d = new Date()) {
  return { season: ['WINTER', 'SPRING', 'SUMMER', 'FALL'][Math.floor(d.getMonth() / 3)], seasonYear: d.getFullYear() };
}

export async function anilistList(vars: object, type: Type, page: number): Promise<Meta[]> {
  const data = await anilist(
    `query($page:Int,$sort:[MediaSort],$format:MediaFormat,$season:MediaSeason,$seasonYear:Int,$status_in:[MediaStatus],$popularity_greater:Int){
      Page(page:$page,perPage:20){media(type:ANIME,isAdult:false,sort:$sort,format:$format,season:$season,seasonYear:$seasonYear,status_in:$status_in,popularity_greater:$popularity_greater){${FIELDS}}}}`,
    { page, ...vars },
  );
  const seen = new Set<string>(); // several seasons often map to the same IMDb series
  return data.Page.media
    .map((m: any) => animeMeta(m, type))
    .filter((m: Meta | null): m is Meta => !!m && !seen.has(m.id) && !!seen.add(m.id));
}

export const isAnimeId = (id: string) => id.startsWith('kitsu:') || animeImdb.has(id);
// ID under which an anime appears in catalogs (IMDb, else kitsu:)
export function animeCatalogId(anilistId: number): string | undefined {
  const ids = anilistIds.get(anilistId);
  return ids?.imdb ?? (ids?.kitsu ? `kitsu:${ids.kitsu}` : undefined);
}
export const anilistIdFor = (id: string) => (id.startsWith('kitsu:') ? kitsuToAnilist.get(Number(id.slice(6))) : imdbToAnilist.get(id));

// AniList recommendations for several watched anime, merged and sorted by score (series only)
export async function animeRecommendations(seedIds: number[]): Promise<Meta[]> {
  const data = await anilist(
    `query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){id recommendations(sort:RATING_DESC,perPage:15){nodes{rating mediaRecommendation{${FIELDS} isAdult}}}}}}`,
    { ids: seedIds },
  );
  const order = new Map(seedIds.map((id, i) => [id, i]));
  const score = new Map<string, { m: Meta; s: number }>();
  for (const media of data.Page.media) {
    const weight = 1 / (1 + (order.get(media.id) ?? 0) * 0.25);
    media.recommendations.nodes.forEach((n: any, rank: number) => {
      const r = n.mediaRecommendation;
      if (!r || r.isAdult || r.format === 'MOVIE') return;
      const meta = animeMeta(r, 'series');
      if (!meta) return;
      const e = score.get(meta.id) ?? { m: meta, s: 0 };
      e.s += weight * (1 - rank / 20) + Math.max(0, n.rating ?? 0) / 1000;
      score.set(meta.id, e);
    });
  }
  return [...score.values()].sort((a, b) => b.s - a.s).map((e) => e.m);
}

// Meta for anime without IMDb ID (kitsu:123), episode IDs in kitsu format that stream addons understand
export async function kitsuMeta(kitsuId: number) {
  const anilistId = kitsuToAnilist.get(kitsuId);
  if (!anilistId) return null;
  return cached(`anime:meta:${kitsuId}`, 6 * 3600, async () => {
    const { Media: m } = await anilist(`query($id:Int){Media(id:$id){${FIELDS} episodes nextAiringEpisode{episode}}}`, { id: anilistId });
    const type: Type = m.format === 'MOVIE' ? 'movie' : 'series';
    const base = animeMeta(m, type);
    if (!base) return null;
    base.id = `kitsu:${kitsuId}`;
    const s = m.startDate ?? {};
    const released = s.year ? new Date(Date.UTC(s.year, (s.month ?? 1) - 1, s.day ?? 1)).toISOString() : undefined;
    const count = m.episodes ?? (m.nextAiringEpisode ? m.nextAiringEpisode.episode - 1 : 0);
    if (type === 'movie') return { ...base, behaviorHints: { defaultVideoId: base.id } };
    return {
      ...base,
      videos: Array.from({ length: count }, (_, i) => ({
        id: `kitsu:${kitsuId}:${i + 1}`,
        title: `Episode ${i + 1}`,
        season: 1,
        episode: i + 1,
        released,
      })),
    };
  });
}

// ---------- Cinemeta ----------

export const cinemetaMeta = (type: Type, id: string) =>
  cached<any>(`cm:meta:${type}:${id}`, 24 * 3600, () => getJson(`${CINEMETA}/meta/${type}/${encodeURIComponent(id)}.json`));

export const cinemetaSearch = (type: Type, q: string) =>
  cached<Meta[]>(`cm:search:${type}:${q.toLowerCase()}`, 3600, async () =>
    (await getJson(`${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`)).metas ?? []);

// ---------- Enhanced metadata: Cinemeta as the base (IMDb rating, episode IDs) + TMDB on top ----------

export type MetaOptions = { cast: boolean; trailers: boolean; episodes: boolean; localize: boolean };

const tmdbFull = (type: Type, tmdbId: number, key: string, lang: string) =>
  cached<any>(`tmdb:full:${type}:${tmdbId}:${lang}`, 24 * 3600, () =>
    tmdb(`/${tv(type)}/${tmdbId}`, key, {
      language: lang,
      append_to_response: 'images,videos,credits',
      include_image_language: `${lang.slice(0, 2)},en,null`,
      include_video_language: `${lang.slice(0, 2)},en`,
    }));

const tmdbSeason = (tmdbId: number, season: number, key: string, lang: string) =>
  cached<any>(`tmdb:season:${tmdbId}:${season}:${lang}`, 24 * 3600, () => tmdb(`/tv/${tmdbId}/season/${season}`, key, { language: lang }));

export async function enhancedMeta(type: Type, id: string, key: string, lang: string, o: MetaOptions) {
  const base = (await cinemetaMeta(type, id).catch(() => null))?.meta;
  const tmdbId = await tmdbIdFor(type, id, key).catch(() => null);
  if (!tmdbId) return { meta: base ?? null };
  const d = await tmdbFull(type, tmdbId, key, lang).catch(() => null);
  if (!d) return { meta: base ?? null };
  const short = lang.slice(0, 2);
  const pick = (list: any[] = []) => list.find((x) => x.iso_639_1 === short) ?? list.find((x) => x.iso_639_1 === 'en') ?? list[0];
  const logo = pick(d.images?.logos);
  const meta: any = {
    ...(base ?? { id, type }),
    id,
    type,
    poster: d.poster_path ? `${IMG}/w500${d.poster_path}` : base?.poster,
    background: d.backdrop_path ? `${IMG}/original${d.backdrop_path}` : base?.background,
    logo: logo ? `${IMG}/w500${logo.file_path}` : (base?.logo ?? logoFor(id)),
    runtime: d.runtime ? `${d.runtime} min` : d.episode_run_time?.[0] ? `${d.episode_run_time[0]} min` : base?.runtime,
    releaseInfo: base?.releaseInfo ?? year(d.release_date ?? d.first_air_date),
  };
  if (o.localize) {
    meta.name = d.title ?? d.name ?? base?.name;
    meta.description = d.overview || base?.description;
    meta.genres = d.genres?.map((g: any) => g.name) ?? base?.genres;
  }
  if (o.cast && d.credits) {
    meta.cast = d.credits.cast?.slice(0, 12).map((c: any) => c.name) ?? base?.cast;
    const directors = d.credits.crew?.filter((c: any) => c.job === 'Director').map((c: any) => c.name);
    const creators = d.created_by?.map((c: any) => c.name);
    meta.director = directors?.length ? directors : creators?.length ? creators : base?.director;
  }
  if (o.trailers) {
    const yt = (d.videos?.results ?? []).filter((v: any) => v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type));
    yt.sort((a: any, b: any) => Number(b.type === 'Trailer') - Number(a.type === 'Trailer') || Number(b.official) - Number(a.official));
    if (yt.length) {
      meta.trailers = yt.slice(0, 3).map((v: any) => ({ source: v.key, type: v.type }));
      meta.trailerStreams = yt.slice(0, 3).map((v: any) => ({ ytId: v.key, title: v.name }));
    }
  }
  // Episodes: keep Cinemeta's IDs (tt…:season:episode, what stream addons expect), add localized titles, plots and stills
  if (type === 'series' && o.episodes && Array.isArray(base?.videos)) {
    const seasons = [...new Set(base.videos.map((v: any) => v.season).filter((s: number) => s >= 0))].slice(0, 40) as number[];
    const data = await Promise.all(seasons.map((s) => tmdbSeason(tmdbId, s, key, lang).catch(() => null)));
    const eps = new Map<string, any>();
    data.forEach((sd) => sd?.episodes?.forEach((e: any) => eps.set(`${e.season_number}:${e.episode_number}`, e)));
    meta.videos = base.videos.map((v: any) => {
      const e = eps.get(`${v.season}:${v.episode}`);
      if (!e) return v;
      return {
        ...v,
        ...(o.localize && e.name ? { name: e.name, title: e.name } : {}),
        ...(o.localize && e.overview ? { overview: e.overview, description: e.overview } : {}),
        ...(e.still_path ? { thumbnail: `${IMG}/w500${e.still_path}` } : {}),
      };
    });
  }
  return { meta };
}
