import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { catalog, defaultName, manifest, meta, ROWS, type Ctx, type RowType } from './addon.ts';
import { assertPublicUrl, PROVIDERS } from './ai.ts';
import { hashPassword, verifyPassword } from './crypto.ts';
import { nuvioProfileList, nuvioSignIn, SIMKL_ID, simklPin, simklPoll, TRAKT_ID, traktDeviceCode, traktPoll } from './history.ts';
import { aiUsage, jobStatus, markQueued, runJob, startScheduler } from './personal.ts';
import { checkTmdbKey, loadAnimeMap, type Type } from './sources.ts';
import {
  configByToken, configByUser, createSession, db, DEFAULT_SETTINGS, destroyAllSessions, destroySession, migrate, profilesOf, purgeUser,
  defaultProfileOf, ownSettings, rateLimit, redis, rootOf, rotateToken, saveSettings, sessionUser, updateSecrets, type AiProvider, type Secrets, type Settings,
} from './store.ts';
import { configPage, homePage, LANGUAGES, loginPage, REFRESH_HOURS, TIMEZONES } from './web.ts';

const PORT = Number(process.env.PORT ?? 7000);
const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_HOST = new URL(PUBLIC_URL).host;
const HTTPS = PUBLIC_URL.startsWith('https');
// __Host- prefix: browsers only accept the cookie over HTTPS, without domain, path / (subdomains cannot overwrite it)
const COOKIE = HTTPS ? '__Host-sid' : 'sid';
const SUPPORT_URL = /^https:\/\/[^\s"'<>]+$/.test(process.env.SUPPORT_URL ?? '') ? process.env.SUPPORT_URL : undefined;
const DUMMY_HASH = await hashPassword('timing-guard'); // login takes equally long whether the user exists or not

const app = express();
// Only trust X-Forwarded-For behind Caddy, otherwise anyone could fake their IP and bypass rate limits
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 0));
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '20kb', parameterLimit: 300 }));
app.use(express.static(new URL('../public', import.meta.url).pathname, { maxAge: '7d', index: false }));

const ip = (req: Request) => req.ip ?? 'unknown';
const field = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const tooMany = (res: Response) => void res.status(429).json({ error: 'rate limit' });

// ---------- Addon protocol (Nuvio) ----------

const TOKEN = '(?:([\\w-]{43})\\/)?';
const MANIFEST_RE = new RegExp(`^\\/${TOKEN}manifest\\.json$`);
const RESOURCE_RE = new RegExp(`^\\/${TOKEN}(catalog|meta)\\/(movie|series|mixed)\\/([^/]{1,200}?)(?:\\/([^/]{1,300}))?\\.json$`);

// Without token: only rows without TMDB (anime) plus search and metadata, there is no server key
async function ctxFor(token?: string): Promise<Ctx | null> {
  if (!token) return { settings: DEFAULT_SETTINGS };
  const cfg = await configByToken(token);
  return cfg && { settings: cfg.settings, tmdbKey: cfg.secrets.tmdbKey, userId: cfg.userId };
}

async function addonGuard(req: Request, res: Response, next: NextFunction) {
  res.set('Access-Control-Allow-Origin', '*');
  const token = (req.params as any)[0];
  if (!(await rateLimit(`addon:${ip(req)}`, 300, 60))) return tooMany(res);
  if (token && !(await rateLimit(`addontok:${token.slice(0, 16)}`, 600, 60))) return tooMany(res);
  next();
}

app.get(MANIFEST_RE, addonGuard, async (req, res) => {
  const ctx = await ctxFor((req.params as any)[0]);
  if (!ctx) return void res.status(404).json({ error: 'unknown URL' });
  res.set('Cache-Control', 'max-age=600').json({ ...(await manifest(ctx)), logo: `${PUBLIC_URL}/logo.png` });
});

app.get(RESOURCE_RE, addonGuard, async (req, res) => {
  const p = req.params as Record<string, string | undefined>;
  const [token, resource, type, rawId, rawExtra] = [p[0], p[1], p[2], p[3], p[4]];
  const ctx = await ctxFor(token);
  if (!ctx) return void res.status(404).json({ error: 'unknown URL' });
  let id = '';
  try {
    id = decodeURIComponent(rawId!);
    if (resource === 'meta') {
      if (type === 'mixed') return void res.json({ meta: null });
      return void res.set('Cache-Control', 'max-age=3600').json(await meta(type as Type, id, ctx));
    }
    res.set('Cache-Control', 'max-age=900').json(await catalog(ctx, type as RowType, id, new URLSearchParams(rawExtra ?? '')));
  } catch (err) {
    console.error(`${resource} ${type} ${id}:`, (err as Error).message);
    res.json(resource === 'meta' ? { meta: null } : { metas: [] }); // the app should never break
  }
});

// ---------- Web: security headers, CSRF, rate limit ----------

app.use(async (req, res, next) => {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.locals.nonce = nonce;
  res.set({
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self' data: https://www.themoviedb.org; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin', // not no-referrer: browsers would then send "Origin: null" and the CSRF check blocks
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': 'no-store',
    ...(HTTPS ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  });
  if (!(await rateLimit(`web:${ip(req)}`, 120, 60))) return void res.status(429).send('Too many requests');
  // CSRF: POST only from our own site (plus SameSite=Lax cookie)
  if (req.method === 'POST') {
    const from = req.get('origin') ?? req.get('referer');
    try {
      if (!from || new URL(from).host !== PUBLIC_HOST) throw 0;
    } catch {
      return void res.status(403).send('Invalid origin');
    }
  }
  next();
});

const getCookie = (req: Request, name: string) => {
  const v = req.headers.cookie?.split(';').map((c) => c.trim().split('=')).find(([k]) => k === name)?.[1];
  try {
    return v ? decodeURIComponent(v) : undefined;
  } catch {
    return undefined;
  }
};

async function login(res: Response, userId: string, to = '/configure') {
  res.cookie(COOKIE, await createSession(userId), { httpOnly: true, secure: HTTPS, sameSite: 'lax', maxAge: 30 * 86400 * 1000, path: '/' });
  res.redirect(303, to);
}

const page = (res: Response, html: (nonce: string) => string, status = 200) => void res.status(status).send(html(res.locals.nonce));

app.get('/', (_req, res) => page(res, () => homePage(PUBLIC_URL, SUPPORT_URL)));
// Health check for Docker: also checks the database and Redis
app.get('/health', async (_req, res) => {
  try {
    await Promise.all([db.query('select 1'), redis.ping()]);
    res.send('ok');
  } catch {
    res.status(503).send('unhealthy');
  }
});
app.get('/login', (_req, res) => page(res, () => loginPage(undefined, SUPPORT_URL)));
app.get('/register', (_req, res) => res.redirect('/'));

// "Configure" button in Nuvio: the install URL is the key, even without a password
app.get(/^\/([\w-]{43})\/configure$/, async (req, res) => {
  if (!(await rateLimit(`cfgtoken:${ip(req)}`, 20, 900))) return void res.status(429).send('Too many attempts');
  const cfg = await configByToken((req.params as any)[0]);
  if (!cfg) return res.redirect('/');
  await login(res, cfg.userId);
});

// Configure without an account: create a user without password, a password can be set later
app.post('/start', async (req, res) => {
  if (!(await rateLimit(`start:${ip(req)}`, 10, 3600)) || !(await rateLimit('start:global', 500, 3600)))
    return page(res, () => homePage(PUBLIC_URL, SUPPORT_URL, 'Too many new configurations right now, please try again later.'), 429);
  const { rows } = await db.query('insert into users default values returning id');
  await rotateToken(rows[0].id);
  await login(res, rows[0].id, '/configure?ok=welcome');
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

app.post('/login', async (req, res) => {
  const accountId = field(req.body.accountId).toLowerCase().slice(0, 36);
  const okIp = await rateLimit(`login:${ip(req)}`, 10, 900);
  const okId = await rateLimit(`login:${accountId}`, 10, 900);
  if (!okIp || !okId) return page(res, () => loginPage('Too many attempts, try again in 15 minutes.', SUPPORT_URL), 429);
  const { rows } = UUID_RE.test(accountId) ? await db.query('select id, pw_hash from users where id = $1 and parent_id is null', [accountId]) : { rows: [] };
  const valid = await verifyPassword(field(req.body.password).slice(0, 200), rows[0]?.pw_hash ?? DUMMY_HASH);
  if (!rows[0]?.pw_hash || !valid) return page(res, () => loginPage('Wrong account ID or password.', SUPPORT_URL), 401);
  await login(res, rows[0].id);
});

app.post('/logout', async (req, res) => {
  const sid = getCookie(req, COOKIE);
  if (sid) await destroySession(sid);
  res.clearCookie(COOKIE, { path: '/', secure: HTTPS }).redirect(303, '/');
});

// ---------- Logged-in only from here ----------

const auth = async (req: Request, res: Response, next: NextFunction) => {
  const sid = getCookie(req, COOKIE);
  const userId = sid ? await sessionUser(sid) : null;
  if (!userId) return void res.redirect(303, '/login');
  res.locals.userId = userId;
  res.locals.sid = sid;
  // Limit actions per user (protects keys in case someone knows the install URL)
  if (req.method === 'POST' && !(await rateLimit(`post:${userId}`, 60, 600))) return void res.status(429).send('Too many actions, please wait a moment.');
  next();
};

// Profiles for the switcher and the profiles step: own or shared settings, mapped Nuvio profile
async function profileInfo(root: string, nuvio: { index: number; name: string }[]) {
  const { rows } = await db.query('select user_id, settings from configs where user_id = any($1)', [(await profilesOf(root)).map((p) => p.id)]);
  const byId = new Map(rows.map((r) => [r.user_id, { ...DEFAULT_SETTINGS, ...r.settings } as Settings]));
  const shared = await defaultProfileOf(root);
  return (await profilesOf(root)).map((p) => {
    const st = byId.get(p.id);
    return { ...p, custom: p.id !== shared && !st?.inherit, nuvio: nuvio.find((n) => n.index === st?.nuvioProfile)?.name };
  });
}

async function renderConfig(res: Response, msg?: { ok: boolean; text: string }, status = 200) {
  const userId = res.locals.userId as string;
  const [cfg, root] = await Promise.all([configByUser(userId), rootOf(userId)]);
  const [trakt, simkl, pw, profiles, job, defaultId, usage] = await Promise.all([
    redis.get(`trakt:dev:${userId}`),
    redis.get(`simkl:pin:${userId}`),
    db.query('select pw_hash is not null as has from users where id = $1', [root]),
    profileInfo(root, cfg.settings.nuvioProfiles),
    jobsOf(userId),
    defaultProfileOf(userId),
    aiUsage(userId),
  ]);
  page(
    res,
    (nonce) =>
      configPage({
        nonce,
        accountId: root,
        profileId: userId,
        profiles,
        defaultId,
        inheritedFrom: cfg.inheritedFrom,
        nuvioShared: !!cfg.nuvioOwner && cfg.nuvioOwner !== userId,
        hasPassword: pw.rows[0].has,
        installUrl: `${PUBLIC_URL}/${cfg.token}/manifest.json`,
        settings: cfg.settings,
        secrets: cfg.secrets,
        traktAvailable: !!TRAKT_ID,
        traktPending: trakt ? JSON.parse(trakt) : null,
        simklAvailable: !!SIMKL_ID,
        simklPending: simkl ? JSON.parse(simkl) : null,
        jobs: job,
        aiUsage: usage,
        supportUrl: SUPPORT_URL,
        msg,
      }),
    status,
  );
}

const OK_MSGS: Record<string, string> = {
  welcome: 'Let’s go: add your TMDB key, set everything up, save and install the addon in the last step. A password is optional.',
  password: 'Password saved. Other devices were signed out.',
  saved: 'Saved. Nuvio picks up changes on the next reload.',
  token: 'New install URL created. Reinstall the addon in Nuvio. Other devices were signed out.',
  nuvio: 'Nuvio connected. Your rows are being computed, this usually takes under a minute.',
  trakt: 'Trakt connected. Your rows are being computed.',
  simkl: 'Simkl connected. Your rows are being computed.',
  refresh: 'Recompute started. The status below updates by itself.',
  profile: 'Switched profile.',
  profiledeleted: 'Profile deleted.',
  imported: 'Settings imported. Reconnect Nuvio Sync / Trakt / Simkl if needed, logins are never part of a backup.',
  savedall: 'Saved for all profiles. Nuvio picks up changes on the next reload.',
  synced: 'Nuvio profiles imported. Each one has its own install URL, see the last step.',
  syncednone: 'Profiles are up to date with Nuvio.',
};

app.get('/configure', auth, async (req, res) => {
  const key = String(req.query.ok ?? '');
  await renderConfig(res, OK_MSGS[key] ? { ok: true, text: OK_MSGS[key] } : undefined);
});

const list = (v: unknown) => ([] as unknown[]).concat(v ?? []).map(String);
const VALID_TZ = new Set(TIMEZONES);

// Give a profile its own copy of the shared settings and keys (it no longer follows the default profile)
async function customize(userId: string) {
  const cfg = await configByUser(userId);
  await updateSecrets(userId, (sec) => void Object.assign(sec, { tmdbKey: cfg.secrets.tmdbKey, aiKey: cfg.secrets.aiKey }));
  await saveSettings(userId, { ...cfg.settings, inherit: false, defaultProfile: '' });
}

// One after another, so a family account does not start 8 jobs at once
async function recomputeAll(root: string) {
  const profiles = await profilesOf(root);
  await markQueued(profiles.map((p) => p.id));
  for (const p of profiles) await runJob(p.id);
}

// Job status of every profile of the account (config page + live polling)
async function jobsOf(userId: string) {
  const profiles = await profilesOf(await rootOf(userId));
  return Promise.all(profiles.map(async (p) => ({ id: p.id, label: p.label, ...(await jobStatus(p.id)) })));
}

// Nuvio profiles become Couchpilot profiles: the main profile takes the first one, every other Nuvio profile
// gets its own Couchpilot profile (name from Nuvio, shared settings, own history and install URL)
async function syncNuvioProfiles(userId: string): Promise<number> {
  const cfg = await configByUser(userId);
  if (!cfg.nuvioOwner) return 0;
  const list = await nuvioProfileList(cfg.nuvioOwner);
  await saveSettings(cfg.nuvioOwner, { ...(await ownSettings(cfg.nuvioOwner)), nuvioProfiles: list });
  const root = await rootOf(userId);
  const { rows } = await db.query(
    'select u.id, u.label, c.settings from users u join configs c on c.user_id = u.id where u.id = $1 or u.parent_id = $1 order by u.parent_id nulls first, u.created_at',
    [root],
  );
  const used = new Set(rows.map((r) => ({ ...DEFAULT_SETTINGS, ...r.settings }).nuvioProfile));
  for (const r of rows) {
    const name = list.find((p) => p.index === ({ ...DEFAULT_SETTINGS, ...r.settings }).nuvioProfile)?.name;
    if (!r.label && name) await db.query('update users set label = $2 where id = $1', [r.id, name]);
  }
  let created = 0;
  for (const p of list) {
    if (used.has(p.index) || rows.length + created >= 8) continue;
    const { rows: ins } = await db.query('insert into users (parent_id, label) values ($1, $2) returning id', [root, p.name]);
    await rotateToken(ins[0].id, { ...DEFAULT_SETTINGS, inherit: true, nuvioProfile: p.index });
    created++;
  }
  void recomputeAll(root);
  return created;
}

app.post('/configure', auth, async (req, res) => {
  const userId = res.locals.userId as string;
  const cfg = await configByUser(userId);
  const b = req.body;
  const picked = list(b.rows);
  const customRows = [1, 2, 3].map((n) => ({ prompt: field(b[`custom${n}`]).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 150) }));
  const hours = Number(b.refreshHours);
  const language = field(b.language);
  const names: Record<string, string> = {};
  for (const id of Object.keys(ROWS)) {
    const n = field(b[`name_${id}`]).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 60);
    if (n && n !== ROWS[id].name && n !== defaultName(id, 'de')) names[id] = n; // default names (any language) stay unset
  }
  const provider = field(b.aiProvider);
  let baseUrl = field(b.aiBaseUrl).slice(0, 300);
  if (provider === 'ollama') {
    try {
      baseUrl = await assertPublicUrl(baseUrl);
    } catch (err) {
      return renderConfig(res, { ok: false, text: `Ollama URL: ${(err as Error).message}. Nothing saved.` }, 400);
    }
  }
  const anilistUser = field(b.anilistUser);
  if (anilistUser && !/^[A-Za-z0-9_-]{2,20}$/.test(anilistUser)) return renderConfig(res, { ok: false, text: 'Invalid AniList username. Nothing saved.' }, 400);
  const profile = Number(b.nuvioProfile);
  const tz = field(b.timezone);
  const settings: Settings = {
    ...cfg.settings,
    // own AI rows are shown exactly when they have a prompt
    rows: Object.keys(ROWS).filter((id) => (id.startsWith('custom-') ? !!customRows[Number(id.slice(7)) - 1]?.prompt : picked.includes(id))),
    order: [...new Set(list(b.order).filter((id) => id in ROWS))],
    names,
    refreshHours: REFRESH_HOURS.includes(hours) ? hours : DEFAULT_SETTINGS.refreshHours,
    language: language in LANGUAGES ? language : DEFAULT_SETTINGS.language,
    timezone: VALID_TZ.has(tz) ? tz : DEFAULT_SETTINGS.timezone,
    ai: { provider: (provider in PROVIDERS ? provider : '') as AiProvider, model: field(b.aiModel).replace(/[^\w.:/@-]/g, '').slice(0, 100), baseUrl },
    aiPrompt: field(b.aiPrompt).slice(0, 500),
    aiReasons: b.aiReasons === '1',
    hideWatched: b.hideWatched === '1',
    customRows,
    meta: {
      source: b.metaSource === 'cinemeta' ? 'cinemeta' : 'enhanced',
      localize: b.metaLocalize === '1',
      cast: b.metaCast === '1',
      trailers: b.metaTrailers === '1',
      episodes: b.metaEpisodes === '1',
    },
    nuvioProfile: cfg.settings.nuvioProfiles.some((p) => p.index === profile) ? profile : cfg.settings.nuvioProfile,
    anilistUser,
  };
  const tmdbKey = field(b.tmdbKey).slice(0, 400);
  if (tmdbKey && !b.removeTmdb && !(await checkTmdbKey(tmdbKey)))
    return renderConfig(res, { ok: false, text: 'Invalid TMDB key, nothing saved.' }, 400);
  const aiKey = field(b.aiKey).slice(0, 400);
  // Security: if the provider or Ollama URL changes, the old key is deleted. Otherwise someone with the
  // install URL could point it to their own server and have the stored key sent there.
  const keyUpdate = (prev: Settings['ai']) => (sec: Secrets) => {
    if (b.removeTmdb) delete sec.tmdbKey;
    else if (tmdbKey) sec.tmdbKey = tmdbKey;
    if (b.removeAiKey) delete sec.aiKey;
    else if (aiKey) sec.aiKey = aiKey;
    else if (settings.ai.provider !== prev.provider || settings.ai.baseUrl !== prev.baseUrl) delete sec.aiKey;
  };
  const root = await rootOf(userId);
  const profiles = await profilesOf(root);
  const sharedId = await defaultProfileOf(userId);
  const perProfile = { nuvioProfile: settings.nuvioProfile, anilistUser: settings.anilistUser };
  if (b.scope === 'all' && profiles.length > 1) {
    // Save to all profiles: the shared settings live in the default profile, every other profile follows them again
    const own = await ownSettings(sharedId);
    await updateSecrets(sharedId, keyUpdate(own.ai));
    await saveSettings(sharedId, { ...settings, ...(sharedId === userId ? {} : { nuvioProfile: own.nuvioProfile, anilistUser: own.anilistUser }), nuvioProfiles: own.nuvioProfiles, inherit: false, defaultProfile: own.defaultProfile });
    for (const p of profiles) {
      if (p.id === sharedId) continue;
      await saveSettings(p.id, { ...(await ownSettings(p.id)), ...(p.id === userId ? perProfile : {}), inherit: true });
    }
    void recomputeAll(root);
    return res.redirect(303, '/configure?ok=savedall');
  }
  // Only this profile: profiles that followed it keep their current settings
  if (userId === sharedId) for (const p of profiles) if (p.id !== userId && (await ownSettings(p.id)).inherit) await customize(p.id);
  if (cfg.inheritedFrom) await customize(userId);
  await updateSecrets(userId, keyUpdate(cfg.settings.ai));
  await saveSettings(userId, { ...settings, inherit: false });
  void runJob(userId);
  res.redirect(303, '/configure?ok=saved');
});

// Live status for the config page (polled while a job runs)
app.get('/status', auth, async (_req, res) => {
  const jobs = await jobsOf(res.locals.userId);
  res.json({ running: jobs.some((j) => j.running), jobs: jobs.map(({ label, text, state }) => ({ label, text, state })) });
});

// ---------- Backup: export / import settings as a JSON file (for people without a password) ----------

const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : '');

app.post('/export', auth, async (req, res) => {
  const cfg = await configByUser(res.locals.userId);
  const s = cfg.settings;
  const data: Record<string, unknown> = {
    app: 'couchpilot',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: {
      rows: s.rows, order: s.order, names: s.names, refreshHours: s.refreshHours, language: s.language, timezone: s.timezone,
      ai: s.ai, aiPrompt: s.aiPrompt, aiReasons: s.aiReasons, meta: s.meta, anilistUser: s.anilistUser, hideWatched: s.hideWatched, customRows: s.customRows,
    },
  };
  // Keys only on request; Nuvio/Trakt/Simkl logins are never exported (rotating tokens must exist only once)
  if (req.body.keys === '1') data.keys = { tmdbKey: cfg.secrets.tmdbKey, aiKey: cfg.secrets.aiKey };
  res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="couchpilot-settings-${new Date().toISOString().slice(0, 10)}.json"` });
  res.send(JSON.stringify(data, null, 2));
});

app.post('/import', auth, async (req, res) => {
  const userId = res.locals.userId as string;
  let x: any;
  try {
    x = JSON.parse(String(req.body.data ?? ''));
    if (x?.app !== 'couchpilot' || typeof x.settings !== 'object') throw 0;
  } catch {
    return renderConfig(res, { ok: false, text: 'This is not a Couchpilot settings file.' }, 400);
  }
  const i = x.settings;
  const own = await ownSettings(userId);
  const names: Record<string, string> = {};
  for (const id of Object.keys(ROWS)) if (clean(i.names?.[id], 60)) names[id] = clean(i.names[id], 60);
  const provider = clean(i.ai?.provider, 20);
  let baseUrl = clean(i.ai?.baseUrl, 300);
  if (provider === 'ollama') baseUrl = await assertPublicUrl(baseUrl).catch(() => '');
  const anilist = clean(i.anilistUser, 20);
  const tz = clean(i.timezone, 60);
  const settings: Settings = {
    ...own,
    inherit: false, // importing means this profile gets its own settings
    rows: Array.isArray(i.rows) ? Object.keys(ROWS).filter((id) => i.rows.includes(id)) : DEFAULT_SETTINGS.rows,
    order: Array.isArray(i.order) ? [...new Set<string>(i.order.map(String).filter((id: string) => id in ROWS))] : [],
    names,
    refreshHours: REFRESH_HOURS.includes(Number(i.refreshHours)) ? Number(i.refreshHours) : DEFAULT_SETTINGS.refreshHours,
    language: clean(i.language, 10) in LANGUAGES ? clean(i.language, 10) : DEFAULT_SETTINGS.language,
    timezone: VALID_TZ.has(tz) ? tz : DEFAULT_SETTINGS.timezone,
    ai: { provider: (provider in PROVIDERS ? provider : '') as AiProvider, model: clean(i.ai?.model, 100).replace(/[^\w.:/@-]/g, ''), baseUrl },
    aiPrompt: clean(i.aiPrompt, 500),
    aiReasons: i.aiReasons !== false,
    meta: {
      source: i.meta?.source === 'cinemeta' ? 'cinemeta' : 'enhanced',
      localize: i.meta?.localize !== false,
      cast: i.meta?.cast !== false,
      trailers: i.meta?.trailers !== false,
      episodes: i.meta?.episodes !== false,
    },
    anilistUser: /^[A-Za-z0-9_-]{2,20}$/.test(anilist) ? anilist : '',
    hideWatched: i.hideWatched !== false,
    customRows: (Array.isArray(i.customRows) ? i.customRows : []).slice(0, 3).map((r: any) => ({ prompt: clean(r?.prompt, 150) })),
  };
  const tmdbKey = clean(x.keys?.tmdbKey, 400);
  const aiKey = clean(x.keys?.aiKey, 400);
  const tmdbOk = tmdbKey ? await checkTmdbKey(tmdbKey) : false;
  await updateSecrets(userId, (sec) => {
    if (tmdbOk) sec.tmdbKey = tmdbKey;
    if (aiKey) sec.aiKey = aiKey;
    else if (settings.ai.provider !== own.ai.provider || settings.ai.baseUrl !== own.ai.baseUrl) delete sec.aiKey; // same rule as on save
  });
  await saveSettings(userId, settings);
  void runJob(userId);
  res.redirect(303, '/configure?ok=imported');
});

app.post('/account/password', auth, async (req, res) => {
  const password = field(req.body.password);
  if (password.length < 10 || password.length > 200) return renderConfig(res, { ok: false, text: 'Password must be 10 to 200 characters.' }, 400);
  if (password !== field(req.body.password2)) return renderConfig(res, { ok: false, text: 'Passwords do not match.' }, 400);
  const root = await rootOf(res.locals.userId);
  await db.query('update users set pw_hash = $2 where id = $1', [root, await hashPassword(password)]);
  for (const p of await profilesOf(root)) await destroyAllSessions(p.id, res.locals.sid);
  res.redirect(303, '/configure?ok=password');
});

app.post('/refresh', auth, async (req, res) => {
  if (!(await rateLimit(`refresh:${res.locals.userId}`, 6, 3600))) return renderConfig(res, { ok: false, text: 'At most 6 recomputes per hour.' }, 429);
  if (req.body.all === '1') void recomputeAll(await rootOf(res.locals.userId));
  else void runJob(res.locals.userId);
  res.redirect(303, '/configure?ok=refresh');
});

// ---------- History sources ----------

app.post('/connect/nuvio', auth, async (req, res) => {
  const userId = res.locals.userId as string;
  if (!(await rateLimit(`nuvio:${userId}`, 5, 900))) return renderConfig(res, { ok: false, text: 'Too many attempts, try again in 15 minutes.' }, 429);
  try {
    const { refreshToken, profiles } = await nuvioSignIn(field(req.body.email).slice(0, 200), field(req.body.password).slice(0, 200));
    const owner = (await configByUser(userId)).nuvioOwner ?? (await defaultProfileOf(userId)); // one login per account
    await updateSecrets(owner, (sec) => void (sec.nuvio = { refreshToken }));
    await saveSettings(owner, { ...(await ownSettings(owner)), nuvioProfiles: profiles, nuvioProfile: (await ownSettings(owner)).nuvioProfile });
    await redis.del(`nuvio:at:${owner}`);
    await syncNuvioProfiles(userId);
    res.redirect(303, '/configure?ok=nuvio');
  } catch (err) {
    console.error('nuvio connect:', (err as Error).message);
    await renderConfig(res, { ok: false, text: 'Nuvio login failed. Check email and password.' }, 400);
  }
});

app.post('/profile/sync', auth, async (_req, res) => {
  try {
    const n = await syncNuvioProfiles(res.locals.userId);
    res.redirect(303, `/configure?ok=${n ? 'synced' : 'syncednone'}`);
  } catch (err) {
    console.error('nuvio profiles:', (err as Error).message);
    await renderConfig(res, { ok: false, text: 'Could not load your Nuvio profiles. Try reconnecting Nuvio Sync.' }, 502);
  }
});

app.post('/disconnect/nuvio', auth, async (_req, res) => {
  const userId = res.locals.userId as string;
  await updateSecrets(userId, (sec) => void delete sec.nuvio);
  await saveSettings(userId, { ...(await ownSettings(userId)), nuvioProfiles: [] });
  await redis.del(`nuvio:at:${userId}`);
  res.redirect(303, '/configure?ok=saved');
});

app.post('/connect/trakt', auth, async (_req, res) => {
  const userId = res.locals.userId as string;
  if (!TRAKT_ID) return renderConfig(res, { ok: false, text: 'Trakt is not set up on this server.' }, 400);
  if (!(await rateLimit(`trakt:${userId}`, 5, 900))) return renderConfig(res, { ok: false, text: 'Too many attempts, try again in 15 minutes.' }, 429);
  const d = await traktDeviceCode();
  await redis.set(`trakt:dev:${userId}`, JSON.stringify(d), 'EX', d.expiresIn);
  res.redirect(303, '/configure#history');
});

app.post('/connect/trakt/check', auth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const pending = await redis.get(`trakt:dev:${userId}`);
  if (!pending) return renderConfig(res, { ok: false, text: 'Code expired, please connect again.' }, 400);
  const tokens = await traktPoll(JSON.parse(pending).deviceCode);
  if (!tokens) return renderConfig(res, { ok: false, text: 'Not confirmed yet. Enter the code on the Trakt page and check again.' });
  await updateSecrets(userId, (sec) => void (sec.trakt = tokens));
  await redis.del(`trakt:dev:${userId}`);
  void runJob(userId);
  res.redirect(303, '/configure?ok=trakt');
});

app.post('/disconnect/trakt', auth, async (_req, res) => {
  await updateSecrets(res.locals.userId, (sec) => void delete sec.trakt);
  res.redirect(303, '/configure?ok=saved');
});

app.post('/connect/simkl', auth, async (_req, res) => {
  const userId = res.locals.userId as string;
  if (!SIMKL_ID) return renderConfig(res, { ok: false, text: 'Simkl is not set up on this server.' }, 400);
  if (!(await rateLimit(`simkl:${userId}`, 5, 900))) return renderConfig(res, { ok: false, text: 'Too many attempts, try again in 15 minutes.' }, 429);
  const d = await simklPin();
  await redis.set(`simkl:pin:${userId}`, JSON.stringify(d), 'EX', d.expiresIn);
  res.redirect(303, '/configure#history');
});

app.post('/connect/simkl/check', auth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const pending = await redis.get(`simkl:pin:${userId}`);
  if (!pending) return renderConfig(res, { ok: false, text: 'Code expired, please connect again.' }, 400);
  const token = await simklPoll(JSON.parse(pending).userCode).catch(() => null);
  if (!token) return renderConfig(res, { ok: false, text: 'Not confirmed yet. Enter the code on the Simkl page and check again.' });
  await updateSecrets(userId, (sec) => void (sec.simkl = { accessToken: token }));
  await redis.del(`simkl:pin:${userId}`);
  void runJob(userId);
  res.redirect(303, '/configure?ok=simkl');
});

app.post('/disconnect/simkl', auth, async (_req, res) => {
  await updateSecrets(res.locals.userId, (sec) => void delete sec.simkl);
  res.redirect(303, '/configure?ok=saved');
});

// ---------- Install URL, profiles, account ----------

app.post('/configure/token', auth, async (_req, res) => {
  const userId = res.locals.userId as string;
  const cfg = await configByUser(userId);
  await rotateToken(userId, cfg.settings);
  await destroyAllSessions(userId, res.locals.sid); // anyone who only knew the old URL is kicked out
  res.redirect(303, '/configure?ok=token');
});

// New profile (e.g. for a second Nuvio profile): own install URL and history, settings follow the default profile
app.post('/profile/new', auth, async (req, res) => {
  const userId = res.locals.userId as string;
  const root = await rootOf(userId);
  if ((await profilesOf(root)).length >= 8) return renderConfig(res, { ok: false, text: 'At most 8 profiles.' }, 400);
  const label = field(req.body.label).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 30) || 'New profile';
  const { rows } = await db.query('insert into users (parent_id, label) values ($1, $2) returning id', [root, label]);
  const id = rows[0].id as string;
  // Pre-select the first Nuvio profile no other profile uses yet, so each profile gets its own history
  const { settings: ds } = await configByUser(await defaultProfileOf(root));
  const { rows: siblings } = await db.query('select c.settings from configs c join users u on u.id = c.user_id where coalesce(u.parent_id, u.id) = $1', [root]);
  const taken = new Set(siblings.map((r) => ({ ...DEFAULT_SETTINGS, ...r.settings }).nuvioProfile));
  const nuvioProfile = ds.nuvioProfiles.find((p) => !taken.has(p.index))?.index ?? DEFAULT_SETTINGS.nuvioProfile;
  await rotateToken(id, { ...DEFAULT_SETTINGS, inherit: true, nuvioProfile }); // follows the default profile until customized
  void runJob(id);
  await login(res, id, '/configure?ok=profile');
});

// Use the shared settings again (on), or copy them once to fine-tune this profile (off)
app.post('/profile/inherit', auth, async (req, res) => {
  const userId = res.locals.userId as string;
  const cfg = await configByUser(userId);
  if (req.body.on === '1') {
    await saveSettings(userId, { ...(await ownSettings(userId)), inherit: true });
  } else {
    await customize(userId);
  }
  void runJob(userId);
  res.redirect(303, '/configure?ok=saved');
});

// Delete a sub-profile (the main profile is deleted together with the account in step 7)
app.post('/profile/delete', auth, async (req, res) => {
  const userId = res.locals.userId as string;
  const target = field(req.body.id);
  const root = await rootOf(userId);
  if (target === root || !(await profilesOf(root)).some((p) => p.id === target))
    return renderConfig(res, { ok: false, text: 'This profile cannot be deleted here.' }, 400);
  if ((await defaultProfileOf(root)) === target) await saveSettings(root, { ...(await ownSettings(root)), defaultProfile: '' }); // main profile becomes default again
  await db.query('delete from users where id = $1 and parent_id = $2', [target, root]);
  await purgeUser(target);
  if (target === userId) return login(res, root, '/configure?ok=profiledeleted');
  res.redirect(303, '/configure?ok=profiledeleted');
});

app.post('/profile/switch', auth, async (req, res) => {
  const target = field(req.body.id);
  const root = await rootOf(res.locals.userId);
  if (!(await profilesOf(root)).some((p) => p.id === target)) return renderConfig(res, { ok: false, text: 'Profile not found.' }, 404);
  await destroySession(res.locals.sid);
  await login(res, target, '/configure?ok=profile');
});

app.post('/account/delete', auth, async (req, res) => {
  if (req.body.confirm !== 'yes') return renderConfig(res, { ok: false, text: 'Please confirm deletion.' }, 400);
  const userId = res.locals.userId as string;
  const root = await rootOf(userId);
  // Main profile = whole account incl. profiles; sub-profile = only this profile
  const targets = userId === root ? await profilesOf(root) : [{ id: userId }];
  await db.query('delete from users where id = $1', [userId]); // configs + sub-profiles via cascade
  for (const t of targets) await purgeUser(t.id);
  res.clearCookie(COOKIE, { path: '/', secure: HTTPS });
  if (userId === root) return res.redirect(303, '/');
  await login(res, root, '/configure?ok=profile');
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err.message);
  res.status(500).send('Internal error');
});

// ---------- Startup + background tasks ----------

// Log instead of crashing on stray promise errors; a crash would leave jobs stuck in "running"
process.on('unhandledRejection', (err) => console.error('unhandled rejection:', (err as Error)?.message ?? err));
db.on('error', (err) => console.error('postgres:', err.message));
redis.on('error', (err) => console.error('redis:', err.message));

await migrate();
void loadAnimeMap();
setInterval(loadAnimeMap, 24 * 3600 * 1000).unref();
startScheduler();
// Cleanup: delete configs that were created but never installed and have no password after 7 days
setInterval(async () => {
  try {
    const { rows } = await db.query(
      `delete from users u using configs c where c.user_id = u.id and u.parent_id is null and u.pw_hash is null
       and c.last_seen is null and u.created_at < now() - interval '7 days' returning u.id`,
    );
    for (const r of rows) await purgeUser(r.id);
  } catch (err) {
    console.error('cleanup:', (err as Error).message);
  }
}, 6 * 3600 * 1000).unref();
app.listen(PORT, () => console.log(`Couchpilot running at ${PUBLIC_URL}`));
