import dns from 'node:dns';
import net from 'node:net';
import { Agent, fetch as safeFetch } from 'undici';

export type AiConfig = { provider: string; model: string; baseUrl: string };

export const PROVIDERS: Record<string, { label: string; model: string; base?: string; keyUrl: string }> = {
  openai: { label: 'OpenAI', model: 'gpt-5.4-mini', base: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  anthropic: { label: 'Anthropic (Claude)', model: 'claude-haiku-4-5', keyUrl: 'https://console.anthropic.com/settings/keys' },
  gemini: { label: 'Google Gemini', model: 'gemini-2.5-flash', base: 'https://generativelanguage.googleapis.com/v1beta/openai', keyUrl: 'https://aistudio.google.com/apikey' },
  openrouter: { label: 'OpenRouter', model: 'openrouter/auto', base: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  ollama: { label: 'Ollama (self-hosted)', model: 'llama3.1', keyUrl: 'https://github.com/ollama/ollama' },
};

// ---------- SSRF protection for the user's Ollama URL ----------

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
    return v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v);
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// DNS lookup that refuses private targets. Runs at connect time, so DNS rebinding does not help either.
function publicLookup(host: string, opts: any, cb: (err: Error | null, address?: any, family?: number) => void) {
  dns.lookup(host, { ...opts, all: true }, (err, addrs) => {
    if (err) return cb(err);
    const list = addrs as unknown as dns.LookupAddress[];
    if (!list.length || list.some((a) => isPrivateIp(a.address))) return cb(new Error('Private addresses are not allowed'));
    opts?.all ? cb(null, list) : cb(null, list[0].address, list[0].family);
  });
}
const publicOnly = new Agent({ connect: { lookup: publicLookup as any } });

export async function assertPublicUrl(raw: string): Promise<string> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('Invalid URL');
  }
  if (url.protocol !== 'https:') throw new Error('Only https URLs are allowed');
  if (url.username || url.password) throw new Error('No credentials in the URL');
  const addrs = await dns.promises.lookup(url.hostname, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new Error('Private addresses are not allowed');
  return url.origin + url.pathname.replace(/\/$/, '');
}

// ---------- One call, two formats: OpenAI-compatible and Anthropic ----------

export type Usage = { in: number; out: number };

// USD per 1M tokens [input, output], checked Oct 2026. Unknown models: tokens are tracked, no cost shown.
export const PRICES: Record<string, [number, number]> = {
  'gpt-5.4-mini': [0.75, 4.5],
  'gpt-4.1-mini': [0.4, 1.6],
  'claude-haiku-4-5': [1, 5],
  'gemini-2.5-flash': [0.3, 2.5],
  'gemini-2.5-flash-lite': [0.1, 0.4],
};
export const priceFor = (cfg: AiConfig): [number, number] | null =>
  cfg.provider === 'ollama' ? [0, 0] : PRICES[(cfg.model || PROVIDERS[cfg.provider]?.model || '').replace(/^.*\//, '')] ?? null;

// Rough size of one ranking call (60 candidates + 25 history titles in, 30 picks with reasons out),
// and up to 5 calls per run (movies, series, anime, 2× mix titles)
export const EST_CALL: Usage = { in: 3500, out: 700 };
export const EST_CALLS_PER_RUN = 5;

export async function complete(cfg: AiConfig, key: string | undefined, system: string, user: string): Promise<{ text: string; usage: Usage }> {
  const p = PROVIDERS[cfg.provider];
  if (!p) throw new Error('No AI provider selected');
  const model = cfg.model || p.model;
  const init = { method: 'POST', redirect: 'error' as const, signal: AbortSignal.timeout(90_000) };

  if (cfg.provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      ...init,
      headers: { 'content-type': 'application/json', 'x-api-key': key ?? '', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error(`Anthropic ${r.status}`);
    const j = await r.json();
    return { text: j.content?.map((c: any) => c.text ?? '').join('') ?? '', usage: { in: j.usage?.input_tokens ?? 0, out: j.usage?.output_tokens ?? 0 } };
  }

  const ollama = cfg.provider === 'ollama';
  const base = ollama ? `${await assertPublicUrl(cfg.baseUrl)}/v1` : p.base;
  const r = await (ollama ? (safeFetch as unknown as typeof fetch) : fetch)(`${base}/chat/completions`, {
    ...init,
    ...(ollama ? { dispatcher: publicOnly } : {}),
    headers: { 'content-type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
    // no temperature: newer reasoning models (e.g. GPT-5.x) reject anything but the default
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  });
  if (!r.ok) throw new Error(`${p.label} ${r.status}`);
  const j: any = await r.json();
  return { text: j.choices?.[0]?.message?.content ?? '', usage: { in: j.usage?.prompt_tokens ?? 0, out: j.usage?.completion_tokens ?? 0 } };
}

export type Pick = { i: number; why?: string };

// Own AI rows: {"title": "...", "items": [{"name": "...", "year": 1999, "type": "movie"|"series"}]}
export function parseItems(text: string): { title: string; items: { name: string; year?: number; type: 'movie' | 'series' }[] } {
  const clean = (v: unknown, n: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);
  try {
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] ?? '');
    const items = (Array.isArray(j.items) ? j.items : [])
      .slice(0, 40)
      .map((x: any) => ({ name: clean(x?.name, 120), year: Number.isInteger(x?.year) ? x.year : undefined, type: x?.type === 'series' ? ('series' as const) : ('movie' as const) }))
      .filter((x: { name: string }) => x.name);
    return { title: clean(j.title, 50), items };
  } catch {
    return { title: '', items: [] };
  }
}

// Extracts indices (and optional short reasons) from the AI reply; anything broken is ignored.
// Reasons are untrusted text: control characters stripped, length capped.
export function parsePicks(text: string, max: number): Pick[] {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return [];
  try {
    const picks = JSON.parse(json).picks;
    if (!Array.isArray(picks)) return [];
    const seen = new Set<number>();
    const out: Pick[] = [];
    for (const p of picks) {
      const i = Number(typeof p === 'object' && p ? p.i : p);
      if (!Number.isInteger(i) || i < 0 || i >= max || seen.has(i)) continue;
      seen.add(i);
      const why = typeof p?.why === 'string' ? p.why.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 140) : undefined;
      out.push(why ? { i, why } : { i });
    }
    return out;
  } catch {
    return [];
  }
}

// Short titles for genre mixes from the AI reply
export function parseTitles(text: string, count: number): string[] {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  try {
    const t = JSON.parse(json ?? '').titles;
    return Array.isArray(t) ? t.slice(0, count).map((x) => String(x).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 50)) : [];
  } catch {
    return [];
  }
}
