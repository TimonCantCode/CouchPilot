import { isOn, orderedRowIds, ROWS } from './addon.ts';
import type { Settings } from './store.ts';

// "Save for all" copies only what was changed on the page to the other profiles, so a profile with
// e.g. German metadata keeps it when someone changes the refresh interval for everyone.

type Change = { key: string; sub?: string } | { row: string; on: boolean } | { order: true };
const PER_PROFILE = new Set(['nuvioProfile', 'nuvioProfiles', 'anilistUser', 'inherit', 'defaultProfile', 'rows', 'order']);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const rowIds = Object.keys(ROWS).filter((id) => !id.startsWith('custom-')); // AI rows follow their prompt
const activeOrder = (s: Settings) => orderedRowIds(s).filter((id) => isOn(id, s));

export function changes(before: Settings, after: Settings): Change[] {
  const out: Change[] = [];
  for (const key of Object.keys(after) as (keyof Settings)[]) {
    if (PER_PROFILE.has(key)) continue;
    const a = before[key] as unknown;
    const b = after[key] as unknown;
    if (isObj(a) && isObj(b)) {
      for (const sub of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[sub], b[sub])) out.push({ key, sub });
    } else if (!same(a, b)) out.push({ key });
  }
  // Rows: which rows were switched on/off, and whether the visible order changed
  for (const row of rowIds) if (isOn(row, before) !== isOn(row, after)) out.push({ row, on: isOn(row, after) });
  if (!same(activeOrder(before), activeOrder(after))) out.push({ order: true });
  return out;
}

export function apply(target: Settings, list: Change[], from: Settings): Settings {
  const t = structuredClone(target) as Settings & Record<string, any>;
  const src = from as Settings & Record<string, any>;
  let rows: Set<string> | null = null;
  for (const c of list) {
    if ('row' in c) {
      rows ??= new Set(rowIds.filter((id) => isOn(id, target)));
      if (c.on) rows.add(c.row);
      else rows.delete(c.row);
    } else if ('order' in c) {
      t.order = [...src.order];
    } else if (c.sub === undefined) {
      t[c.key] = structuredClone(src[c.key]);
    } else {
      t[c.key] = { ...(t[c.key] ?? {}) };
      if (c.sub in src[c.key]) t[c.key][c.sub] = structuredClone(src[c.key][c.sub]);
      else delete t[c.key][c.sub];
    }
  }
  if (rows) {
    // write every row explicitly, so rows that are "on by default" don't switch back on
    t.order = orderedRowIds(t);
    t.rows = rowIds.filter((id) => rows!.has(id));
  }
  return t;
}
