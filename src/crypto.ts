import fs from 'node:fs';
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

// Master key preferably from a file (Docker secret) so it never shows up in env vars / `docker inspect`
let cachedKey: Buffer | undefined;
function masterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const file = process.env.MASTER_KEY_FILE;
  const raw = file ? fs.readFileSync(file, 'utf8').trim() : (process.env.MASTER_KEY ?? '');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('Master key missing or not 32 bytes (base64)');
  return (cachedKey = key);
}

// AES-256-GCM. "aad" binds the ciphertext to its owner (e.g. "secrets:<userId>"):
// Swapping ciphertexts between users in the DB only yields a decryption error.
// Format v2: "v2:" + base64(iv(12) | tag(16) | ciphertext)
export function encrypt(plain: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', masterKey(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return 'v2:' + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

export function decrypt(blob: string, aad: string): string {
  const v2 = blob.startsWith('v2:');
  const buf = Buffer.from(v2 ? blob.slice(3) : blob, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', masterKey(), buf.subarray(0, 12));
  if (v2) d.setAAD(Buffer.from(aad)); // legacy data (v1) had no AAD yet
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${(await scrypt(pw, salt, 64)).toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [salt, hash] = stored.split(':');
  const got = await scrypt(pw, Buffer.from(salt, 'hex'), 64);
  const want = Buffer.from(hash ?? '', 'hex');
  return want.length === got.length && crypto.timingSafeEqual(got, want);
}

// Shows only the start and end of a key, never the whole thing
export const mask = (s: string) => (s.length > 12 ? `${s.slice(0, 3)}…${s.slice(-4)}` : '••••');
