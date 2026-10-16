// Decide which D1 rows to write. Unchanged status/page/model/meta content must not be sent
// to D1 at all (an ON CONFLICT update still counts as a row write). Freshness for status
// responses comes from one probe_clock meta row per cron. Doc pages also touch checked_at
// on every read so a stable hash cannot freeze the row clock. That touch is one row.
import { PAGES } from "./providers.js";

export const CRON_MS = 5 * 60 * 1000;
// Recheck every 5 minutes. Stay fresh across one late or missed run.
export const STATUS_FRESH_SECONDS = 10 * 60;
// Every 6 hours, 35 minutes past the hour (72 ticks of 5 min, offset 7).
const CATALOG_TICKS = 72;
const CATALOG_PHASE = 7;
// Once an hour at minute 30.
const TW_TICKS = 12;
const TW_PHASE = 6;

export function cronPlan(scheduledTime) {
  const tick = Math.floor(scheduledTime / CRON_MS);
  const d = new Date(scheduledTime);
  return {
    tick,
    pageIndex: tick % PAGES.length,
    catalog: tick % CATALOG_TICKS === CATALOG_PHASE,
    tw: tick % TW_TICKS === TW_PHASE,
    digest: d.getUTCHours() === 12 && d.getUTCMinutes() === 0,
  };
}

function stable(v) {
  if (typeof v === "string") { try { return stable(JSON.parse(v)); } catch { return v; } }
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === "object") return Object.keys(v).sort().reduce((o, k) => (o[k] = stable(v[k]), o), {});
  return v ?? null;
}
export function stableJson(v, empty) {
  if (v == null || v === "") return empty;
  return JSON.stringify(stable(v));
}
// Reachability probes include latency ("HTTP 200, 842 ms"). The milliseconds change every
// check and are not a status change.
export function canonicalDescription(s) {
  if (s == null || s === "") return null;
  return String(s).replace(/\d+ ms/g, "N ms");
}
export function statusWriteNeeded(old, next) {
  if (!old) return true;
  return old.indicator !== next.indicator
    || canonicalDescription(old.description) !== canonicalDescription(next.description)
    || stableJson(old.incidents, "[]") !== stableJson(next.incidents ?? [], "[]")
    || stableJson(old.components, "[]") !== stableJson(next.components ?? [], "[]")
    || (old.error || null) !== (next.error || null);
}
export function planStatusWrites(oldById, results, t) {
  const writes = [], events = [];
  for (const [p, r] of results) {
    const o = oldById[p.id] || null;
    const indicatorChanged = !o || o.indicator !== r.indicator;
    const incidents = r.incidents || [], components = r.components || [];
    if (o && indicatorChanged && r.indicator !== "unknown" && o.indicator !== "unknown") {
      events.push({ provider: p.id, kind: "status", title: `${p.name}: ${o.indicator} → ${r.indicator}`, detail: { from: o.indicator, to: r.indicator, summary: r.description, incidents: incidents.slice(0, 5) }, source: p.page, at: t });
    }
    if (!statusWriteNeeded(o, { ...r, incidents, components })) continue;
    writes.push({ provider: p.id, indicator: r.indicator, description: r.description || null, incidents: JSON.stringify(incidents), components: JSON.stringify(components), checked_at: t, changed_at: indicatorChanged ? t : o.changed_at, error: r.error || null });
  }
  return { writes, events };
}

export function pageWriteNeeded(old, hash) {
  if (!old || old.error || !old.hash) return true;
  return old.hash !== hash;
}
export function pageErrorWriteNeeded(old, error) {
  if (!old) return true;
  return (old.error || null) !== error;
}
// content = rewrite text/hash (and checked_at). touch = checked_at only, one row.
// insert_error = first time we have seen this page, and the read failed.
// A matching hash must still touch. Skipping that write is what froze pages.checked_at.
export function pagePersistPlan(old, hash, error) {
  if (error) return old ? "touch" : "insert_error";
  if (pageWriteNeeded(old, hash)) return "content";
  return "touch";
}
// OpenAI documents this: append .md to a docs URL for the public Markdown source.
export function docAlternateUrl(url) {
  if (typeof url !== "string") return null;
  if (!/^https:\/\/developers\.openai\.com\/api\/docs\/[^\s]+$/.test(url)) return null;
  if (url.endsWith(".md")) return null;
  return url + ".md";
}
export function isMarkdownBody(contentType, url) {
  const c = String(contentType || "").toLowerCase();
  if (c.includes("html")) return false;
  if (c.includes("markdown") || c.startsWith("text/plain")) return true;
  return /\.md(?:$|\?)/.test(url || "");
}
export function docReadError(status, triedAlternate) {
  if (status === 403 || status === 401) {
    return triedAlternate
      ? `stale: HTTP ${status} from OpenAI docs (HTML and the public .md page). Stored copy was not updated.`
      : `stale: HTTP ${status} from the docs host. Stored copy was not updated.`;
  }
  return "HTTP " + status;
}
export function modelWriteNeeded(prev, next) {
  if (!prev) return true;
  return prev.status !== next.status
    || stableJson(prev.dates, "null") !== stableJson(next.dates, "null")
    || (prev.snippet || null) !== (next.snippet || null)
    || (prev.source || null) !== (next.source || null);
}
export function metaWriteNeeded(oldV, newV) {
  return (oldV ?? null) !== (newV ?? null);
}

export function laterIso(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return a > b ? a : b;
}
export function parseProbe(v) {
  let j = null;
  try { j = JSON.parse(v || "null"); } catch { j = null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return { status: null, pages: {} };
  return { status: typeof j.status === "string" ? j.status : null, pages: j.pages && typeof j.pages === "object" && !Array.isArray(j.pages) ? j.pages : {} };
}
export function mergePageProbe(prev, next) {
  if (!next) return prev || { at: null };
  if (next.ok_at) {
    const out = { at: next.at, ok_at: next.ok_at };
    if (Array.isArray(next.models)) out.models = next.models;
    return out;
  }
  const out = { at: next.at };
  if (prev?.ok_at) out.ok_at = prev.ok_at;
  if (Array.isArray(prev?.models)) out.models = prev.models;
  return out;
}
export function pageIdForSource(url) {
  return PAGES.find((p) => p.url === url)?.id || null;
}
// ok_at is the last successful read. Models dropped from the page keep their stored seen_at.
export function modelSeenAt(seenAt, pageProbe, modelId) {
  if (!pageProbe?.ok_at || !Array.isArray(pageProbe.models) || !pageProbe.models.includes(modelId)) return seenAt || null;
  return laterIso(seenAt, pageProbe.ok_at);
}

export function snapshotUnchanged(prev, cur) {
  if (!prev || typeof prev !== "object" || Array.isArray(prev)) return false;
  const keys = Object.keys(cur);
  if (Object.keys(prev).length !== keys.length) return false;
  for (const k of keys) {
    const p = prev[k], c = cur[k];
    if (!p || p[0] !== c[0] || p[1] !== c[1]) return false;
  }
  return true;
}
