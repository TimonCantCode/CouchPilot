import fs from 'node:fs';
import pg from 'pg';
import { Redis } from 'ioredis';
import { decrypt, encrypt, randomToken, sha256 } from './crypto.ts';

export const db = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
export const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');

export async function migrate() {
  await db.query(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
}

// ---------- Cache & Rate-Limit ----------

export async function cached<T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> {
  const hit = await redis.get(key);
  if (hit) return JSON.parse(hit) as T;
  const value = await fn();
  await redis.set(key, JSON.stringify(value), 'EX', ttlSec);
  return value;
}

// ponytail: fixed-window counter, enough against brute force and spam; sliding window if bursts become a problem
export async function rateLimit(key: string, max: number, windowSec: number): Promise<boolean> {
  const k = `rl:${key}`;
  const [[, n]] = (await redis.multi().incr(k).expire(k, windowSec, 'NX').exec()) as [[unknown, number]];
  return n <= max;
}

// ---------- Sessions (cookie only holds a random value, Redis only knows its hash) ----------

const SESSION_TTL = 60 * 60 * 24 * 30;

export async function createSession(userId: string): Promise<string> {
  const sid = randomToken();
  const h = sha256(sid);
  await redis.multi().set(`sess:${h}`, userId, 'EX', SESSION_TTL).sadd(`usess:${userId}`, h).expire(`usess:${userId}`, SESSION_TTL).exec();
  return sid;
}
export const sessionUser = (sid: string) => redis.get(`sess:${sha256(sid)}`);
export const destroySession = (sid: string) => redis.del(`sess:${sha256(sid)}`);

// End all sessions of a user (password changed, URL regenerated, account deleted)
export async function destroyAllSessions(userId: string, keepSid?: string) {
  const keep = keepSid ? sha256(keepSid) : '';
  const hashes = await redis.smembers(`usess:${userId}`);
  const drop = hashes.filter((h) => h !== keep);
  if (drop.length) await redis.del(...drop.map((h) => `sess:${h}`));
  await redis.del(`usess:${userId}`);
  if (keep) await redis.sadd(`usess:${userId}`, keep);
}

// ---------- User configuration ----------

export type AiProvider = '' | 'openai' | 'anthropic' | 'gemini' | 'openrouter' | 'ollama';
export type Settings = {
  rows: string[];
  order: string[];
  names: Record<string, string>;
  refreshHours: number;
  language: string;
  timezone: string;
  ai: { provider: AiProvider; model: string; baseUrl: string };
  aiPrompt: string;
  aiReasons: boolean;
  nuvioProfile: number;
  nuvioProfiles: { index: number; name: string }[];
  anilistUser: string;
  meta: { source: 'cinemeta' | 'enhanced'; localize: boolean; cast: boolean; trailers: boolean; episodes: boolean };
  inherit: boolean; // profile follows the default profile's settings (history stays its own)
  defaultProfile: string; // only on the main profile: which profile is the default ('' = main profile)
};
export type Secrets = {
  tmdbKey?: string;
  aiKey?: string;
  nuvio?: { refreshToken: string };
  trakt?: { accessToken: string; refreshToken: string; expiresAt: number };
  simkl?: { accessToken: string };
};

export const DEFAULT_SETTINGS: Settings = {
  rows: ['foryou-movie', 'foryou-series', 'because-movie', 'because-series', 'new-episodes', 'mood-movie', 'trending-movie', 'trending-series', 'popular-movie', 'popular-series', 'new-movie', 'anime-trending'],
  order: [],
  names: {},
  refreshHours: 6,
  language: 'en-US',
  timezone: 'Europe/Berlin',
  ai: { provider: '', model: '', baseUrl: '' },
  aiPrompt: '',
  aiReasons: true,
  nuvioProfile: 1,
  nuvioProfiles: [],
  anilistUser: '',
  meta: { source: 'enhanced', localize: true, cast: true, trailers: true, episodes: true },
  inherit: true,
  defaultProfile: '',
};

export type UserConfig = { userId: string; settings: Settings; secrets: Secrets; inheritedFrom?: string; nuvioOwner?: string };

const aadSecrets = (userId: string) => `secrets:${userId}`;
const aadToken = (userId: string) => `token:${userId}`;
const readSecrets = (userId: string, enc: string | null): Secrets => (enc ? JSON.parse(decrypt(enc, aadSecrets(userId))) : {});
const readSettings = (raw: object): Settings => ({ ...DEFAULT_SETTINGS, ...raw });

// Profiles that inherit get the default profile's settings and API keys, but keep their own history
// (Nuvio profile, AniList user, Trakt/Simkl tokens). The Nuvio login belongs to the account: profiles without
// their own login use the default profile's login, each with its own Nuvio profile.
async function resolve(userId: string, settings: Settings, secrets: Secrets): Promise<UserConfig> {
  const defaultId = await defaultProfileOf(userId);
  const row = defaultId === userId ? undefined : (await db.query('select settings, secrets_enc from configs where user_id = $1', [defaultId])).rows[0];
  const ds = row && readSettings(row.settings);
  const dsec = row && readSecrets(defaultId, row.secrets_enc);
  const shareNuvio = !secrets.nuvio && !!dsec?.nuvio;
  const nuvio = secrets.nuvio ?? (shareNuvio ? dsec!.nuvio : undefined);
  const nuvioOwner = secrets.nuvio ? userId : shareNuvio ? defaultId : undefined;
  const nuvioProfiles = shareNuvio ? ds!.nuvioProfiles : settings.nuvioProfiles;
  if (!settings.inherit || !ds) return { userId, settings: { ...settings, nuvioProfiles }, secrets: { ...secrets, nuvio }, nuvioOwner };
  return {
    userId,
    inheritedFrom: defaultId,
    nuvioOwner,
    settings: { ...ds, nuvioProfile: settings.nuvioProfile, nuvioProfiles, anilistUser: settings.anilistUser, inherit: true, defaultProfile: '' },
    secrets: { ...secrets, nuvio, tmdbKey: dsec!.tmdbKey ?? secrets.tmdbKey, aiKey: dsec!.aiKey },
  };
}

export async function defaultProfileOf(userId: string): Promise<string> {
  const { rows } = await db.query(
    `select coalesce(u.parent_id, u.id) as root, r.settings->>'defaultProfile' as def
     from users u join configs r on r.user_id = coalesce(u.parent_id, u.id) where u.id = $1`,
    [userId],
  );
  return rows[0]?.def || rows[0]?.root || userId;
}

export async function configByToken(token: string): Promise<UserConfig | null> {
  const { rows } = await db.query('select user_id, settings, secrets_enc from configs where token_hash = $1', [sha256(token)]);
  if (!rows[0]) return null;
  return resolve(rows[0].user_id, readSettings(rows[0].settings), readSecrets(rows[0].user_id, rows[0].secrets_enc));
}

export async function configByUser(userId: string): Promise<UserConfig & { token: string }> {
  const { rows } = await db.query('select settings, secrets_enc, token_enc from configs where user_id = $1', [userId]);
  const cfg = await resolve(userId, readSettings(rows[0].settings), readSecrets(userId, rows[0].secrets_enc));
  return { ...cfg, token: decrypt(rows[0].token_enc, aadToken(userId)) };
}

// The profile's own stored settings, without inheritance (for saving per-profile fields)
export async function ownSettings(userId: string): Promise<Settings> {
  const { rows } = await db.query('select settings from configs where user_id = $1', [userId]);
  return readSettings(rows[0]?.settings ?? {});
}

const historyOf = (s: Settings, sec: Secrets) => !!(sec.nuvio || sec.trakt || sec.simkl || s.anilistUser);

// Read-modify-write of secrets in a transaction (e.g. rotating OAuth tokens)
export async function updateSecrets(userId: string, fn: (s: Secrets) => Promise<void> | void) {
  const client = await db.connect();
  try {
    await client.query('begin');
    const { rows } = await client.query('select settings, secrets_enc from configs where user_id = $1 for update', [userId]);
    const secrets = readSecrets(userId, rows[0]?.secrets_enc ?? null);
    await fn(secrets);
    await client.query('update configs set secrets_enc = $2, has_history = $3, updated_at = now() where user_id = $1', [
      userId,
      encrypt(JSON.stringify(secrets), aadSecrets(userId)),
      historyOf(readSettings(rows[0]?.settings ?? {}), secrets),
    ]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}

export async function saveSettings(userId: string, settings: Settings) {
  const cfg = await configByUser(userId); // effective secrets include this profile's own history tokens
  await db.query('update configs set settings = $2, has_history = $3, updated_at = now() where user_id = $1', [
    userId,
    settings,
    historyOf(settings, cfg.secrets),
  ]);
}

// New token = old install URLs stop working immediately
export async function rotateToken(userId: string, settings: Settings = DEFAULT_SETTINGS): Promise<string> {
  const token = randomToken();
  await db.query(
    `insert into configs (user_id, token_hash, token_enc, settings) values ($1, $2, $3, $4)
     on conflict (user_id) do update set token_hash = excluded.token_hash, token_enc = excluded.token_enc`,
    [userId, sha256(token), encrypt(token, aadToken(userId)), settings],
  );
  return token;
}

// Write "last seen" at most once per hour (for precompute and cleanup)
export async function touchSeen(userId: string) {
  if (await redis.set(`seen:${userId}`, '1', 'EX', 3600, 'NX')) await db.query('update configs set last_seen = now() where user_id = $1', [userId]);
}

// ---------- Profiles: several configurations under one account ----------

export async function rootOf(userId: string): Promise<string> {
  const { rows } = await db.query('select coalesce(parent_id, id) as root from users where id = $1', [userId]);
  return rows[0]?.root ?? userId;
}

export async function profilesOf(rootId: string): Promise<{ id: string; label: string }[]> {
  const { rows } = await db.query(
    `select id, coalesce(label, case when parent_id is null then 'Main profile' else 'Profile' end) as label
     from users where id = $1 or parent_id = $1 order by parent_id nulls first, created_at`,
    [rootId],
  );
  return rows;
}

// Delete all Redis data of a user (account/profile deleted)
export async function purgeUser(userId: string) {
  await destroyAllSessions(userId);
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `*${userId}*`, 'COUNT', 500);
    if (keys.length) await redis.del(...keys);
    cursor = next;
  } while (cursor !== '0');
}
