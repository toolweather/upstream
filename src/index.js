import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { PROVIDERS, PAGES } from "./providers.js";
import { pageTokens, parseModels, markdownTokens, textFromTokens } from "./models.js";
import { twSnapshot, buildDigest, saveDigest, digestOut, atom, subscribe, confirmOrUnsub, enqueueDigest } from "./digest.js";
import { drainOutbox, mailReady } from "./mailer.js";
import { LLMS, openapi, SITE } from "./docs.js";
import { STATUS_FRESH_SECONDS, cronPlan, planStatusWrites, pagePersistPlan, modelWriteNeeded, metaWriteNeeded, parseProbe, mergePageProbe, laterIso, modelSeenAt, pageIdForSource, docAlternateUrl, isMarkdownBody, docReadError } from "./persist.js";

const VERSION = "0.2.1";
const PRICES = { status: "$0.003", changes: "$0.01", model: "$0.003", watch: "$0.05" };
const PBY = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
const now = () => new Date().toISOString();
const today = () => now().slice(0, 10);
const enc = new TextEncoder();
const hex = (b) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha = async (s) => hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
const ipOf = (req) => req.headers.get("cf-connecting-ip") || "0.0.0.0";
// privacy: raw IPs are never stored; only a hash salted with a secret and the UTC day (so hashes cannot be linked across days)
const ipHash = (env, scope, req) => sha(`${scope}|${today()}|${env.SALT || env.ADMIN_TOKEN}|${ipOf(req)}`);

// ---------- x402 (lazy per isolate; PAY_TO / network / facilitator come from env so mainnet is a config change) ----------
let X = null;
function x402(env) {
  if (X) return X;
  const net = env.X402_NETWORK;
  const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: env.FACILITATOR_URL })).register(net, new ExactEvmScheme());
  const opt = (price) => ({ scheme: "exact", price, network: net, payTo: env.PAY_TO });
  const routes = {
    "GET /status/:provider": { accepts: [opt(PRICES.status)], description: "Upstream: live status of one AI/dev API provider (free quota exhausted)", mimeType: "application/json" },
    "GET /changes": { accepts: [opt(PRICES.changes)], description: "Upstream: normalized change feed (status, deprecations, model retirements, pricing)", mimeType: "application/json" },
    "GET /model/:id": { accepts: [opt(PRICES.model)], description: "Upstream: is this model live, deprecated or retiring", mimeType: "application/json" },
    "GET /x402/status/:provider": { accepts: [opt(PRICES.status)], description: "Upstream: live status (incidents, affected components) of one AI/dev API provider", mimeType: "application/json" },
    "GET /x402/changes": { accepts: [opt(PRICES.changes)], description: "Upstream: change feed of status changes, deprecations, model retirements and pricing-page edits", mimeType: "application/json" },
    "GET /x402/model/:id": { accepts: [opt(PRICES.model)], description: "Upstream: is this model active, deprecated or retired, shutdown date and replacement", mimeType: "application/json" },
    "POST /v1/watches": { accepts: [opt(PRICES.watch)], description: "Upstream: one extra change-alert webhook watch for 30 days", mimeType: "application/json" },
  };
  X = { server, opt, mw: paymentMiddleware(routes, server, undefined, undefined, true), ready: null };
  return X;
}

// ---------- free tier ----------
async function keyRow(env, c) {
  const k = c.req.header("x-api-key") || c.req.query("key");
  if (!k) return null;
  return await env.DB.prepare("SELECT * FROM keys WHERE key_hash=?").bind(await sha(k)).first();
}
async function takeFree(env, c) {
  const d = today(), kr = await keyRow(env, c);
  if (kr) {
    const lim = +env.FREE_KEY_DAILY, used = kr.day === d ? kr.used : 0;
    if (used < lim) { await env.DB.prepare("UPDATE keys SET day=?, used=? WHERE key_hash=?").bind(d, used + 1, kr.key_hash).run(); return { free: true, plan: "free_key", remaining: lim - used - 1 }; }
    return { free: false, plan: "free_key", remaining: 0 };
  }
  // Toolweather suite proxy: per-client free quota (same as free-key daily) identified by X-Tw-Bundle-Client
  const bsec = c.req.header("x-tw-bundle-secret"), bcli = c.req.header("x-tw-bundle-client");
  if (env.BUNDLE_PROXY_SECRET && bsec && bsec === env.BUNDLE_PROXY_SECRET && bcli && /^[a-f0-9]{16,128}$/i.test(bcli)) {
    const lim = +env.FREE_KEY_DAILY, ih = await sha("bundle|" + bcli.toLowerCase());
    const r = await env.DB.prepare("INSERT INTO anon(ip_hash,day,used) VALUES(?,?,1) ON CONFLICT(ip_hash,day) DO UPDATE SET used=used+1 WHERE used<? RETURNING used").bind(ih, d, lim).first();
    return r ? { free: true, plan: "bundle", remaining: lim - r.used } : { free: false, plan: "bundle", remaining: 0 };
  }
  const ih = await ipHash(c.env, "anon", c.req.raw), lim = +env.FREE_ANON_DAILY;
  const r = await env.DB.prepare("INSERT INTO anon(ip_hash,day,used) VALUES(?,?,1) ON CONFLICT(ip_hash,day) DO UPDATE SET used=used+1 WHERE used<? RETURNING used").bind(ih, d, lim).first();
  return r ? { free: true, plan: "anonymous", remaining: lim - r.used } : { free: false, plan: "anonymous", remaining: 0 };
}
const paidHeader = (c) => c.req.header("payment-signature") || c.req.header("x-payment");

// ---------- data ----------
const STATE = { none: "operational", minor: "degraded", major: "partial_outage", critical: "major_outage", maintenance: "maintenance" };
function rowOut(p, r) {
  if (!r) return { provider: p.id, name: p.name, state: "unknown", note: "not checked yet" };
  const age = r.checked_at ? Math.round((Date.now() - Date.parse(r.checked_at)) / 1000) : null;
  return { provider: p.id, name: p.name, category: p.category, state: r.indicator, summary: r.description, incidents: JSON.parse(r.incidents || "[]"), affected_components: JSON.parse(r.components || "[]"),
    source: p.type === "sp" ? "official status page" : p.type === "gcp" ? "Google Cloud status incidents + API reachability" : "API reachability probe (no machine-readable status page)",
    status_page: p.page, checked_at: r.checked_at, age_seconds: age, state_since: r.changed_at, error: r.error || undefined,
    safe_to_call: ["operational", "maintenance"].includes(r.indicator) ? true : r.indicator === "major_outage" ? false : r.indicator === "unknown" ? null : "with_retries", sponsored: null };
}
async function loadProbe(env) {
  const rows = (await env.DB.prepare("SELECT k,v FROM meta WHERE k IN ('probe_clock','last_cron')").all()).results;
  const m = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  const probe = parseProbe(m.probe_clock);
  return { probe, lastCron: probe.status || m.last_cron || null };
}
async function getStatus(env, id) {
  const p = PBY[id]; if (!p) return { code: 404, body: { error: "unknown_provider", hint: "GET /providers for the list" } };
  const [r, clock] = await Promise.all([env.DB.prepare("SELECT * FROM status WHERE provider=?").bind(id).first(), loadProbe(env)]);
  if (r) r.checked_at = laterIso(r.checked_at, clock.probe.status);
  const pages = PAGES.filter((x) => x.provider === id).map((x) => ({ kind: x.kind, url: x.url }));
  const recent = (await env.DB.prepare("SELECT kind,title,at FROM changes WHERE provider=? ORDER BY id DESC LIMIT 5").bind(id).all()).results;
  const o = rowOut(p, r), fr = freshness(o.age_seconds, STATUS_FRESH_SECONDS);
  const act = { operational: "Safe to call.", maintenance: "Safe to call; scheduled maintenance in progress, expect brief errors.", degraded: "Call with retries and backoff; have a fallback provider ready.", partial_outage: "Expect failures; retry with backoff or route to a fallback provider.", major_outage: "Do not rely on it now; route to a fallback provider.", unknown: "Status unknown (our check failed, not necessarily the provider); proceed with retries." }[o.state] || "Proceed with care.";
  const verdict = { operational: "up", maintenance: "up", degraded: "degraded", partial_outage: "partially down", major_outage: "down", unknown: "unknown" }[o.state] || o.state;
  const line = `${p.name} is ${verdict}${o.summary ? " (" + o.summary + ")" : ""}${o.state_since ? " since " + o.state_since : ""}. ${act}`;
  const { summary: provider_description, ...status } = o;
  return { code: 200, body: { summary: line, verdict, recommended_action: act, freshness: fr, ...status, provider_description, tracked_pages: pages, recent_changes: recent } };
}
async function getChanges(env, q) {
  let sql = "SELECT * FROM changes WHERE at>?", a = [q.since || new Date(Date.now() - 7 * 864e5).toISOString()];
  if (q.provider) { sql += " AND provider=?"; a.push(q.provider); }
  if (q.kind) { sql += " AND kind=?"; a.push(q.kind); }
  sql += " ORDER BY id DESC LIMIT ?"; a.push(Math.min(+q.limit || 100, 500));
  const rs = (await env.DB.prepare(sql).bind(...a).all()).results.map((r) => ({ ...r, detail: JSON.parse(r.detail || "null") }));
  const byKind = rs.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
  const summ = rs.length ? `${rs.length} change(s) since ${a[0]}${q.provider ? " for " + q.provider : ""}: ` + Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ") + `. Latest: ${rs[0].title}.` : `No changes since ${a[0]}${q.provider ? " for " + q.provider : ""}. Nothing to act on.`;
  return { code: 200, body: { summary: summ, checked_at: now(), freshness: { data_as_of: rs[0]?.at || null, note: "status changes recorded within ~5 min; doc pages re-read every few hours" }, since: a[0], count: rs.length, kinds: ["status", "deprecations", "model_retirement", "pricing"], changes: rs } };
}
const norm = (s) => String(s).toLowerCase().replace(/^models\//, "").trim();
async function getModel(env, id) {
  const m = norm(id);
  if (!m || m.length > 120) return { code: 400, body: { error: "bad_model_id" } };
  const rows = (await env.DB.prepare("SELECT * FROM models WHERE model=?").bind(m).all()).results;
  const sugg = rows.length ? [] : (await env.DB.prepare("SELECT model,provider,status FROM models WHERE model LIKE ? LIMIT 8").bind("%" + m.replace(/[%_]/g, "") + "%").all()).results;
  let orIds = null;
  try { const cat = JSON.parse((await env.DB.prepare("SELECT v FROM meta WHERE k='openrouter_models'").first())?.v || "[]"); orIds = cat.filter((x) => x === m || x.endsWith("/" + m)).slice(0, 5); } catch {}
  const order = { retired: 3, deprecated: 2, active: 1 };
  const best = rows.sort((a, b) => (order[b.status] || 0) - (order[a.status] || 0))[0];
  const info = best ? JSON.parse(best.dates || "{}") : {};
  const st = best ? best.status : "unknown", rep = info.replacement || null;
  const summary = st === "retired" ? `${m} is RETIRED${info.shutdown_date ? " (shut down " + info.shutdown_date + ")" : ""}. Switch to ${rep || "a current model from the same provider"} now.`
    : st === "deprecated" ? `${m} is DEPRECATED${info.shutdown_date ? ", shutdown " + info.shutdown_date : ""}. Plan migration to ${rep || "a current model from the same provider"}.`
    : st === "active" ? `${m} is active with no announced shutdown. Safe to keep using.`
    : `${m} is not listed on any tracked deprecation page. Probably fine, but not confirmed${sugg.length ? "; see did_you_mean" : ""}.`;
  const urls = [...new Set(rows.map((r) => r.source).filter(Boolean))];
  const [clock, pageErrRows] = rows.length ? await Promise.all([
    loadProbe(env),
    urls.length ? env.DB.prepare(`SELECT url,error FROM pages WHERE url IN (${urls.map(() => "?").join(",")})`).bind(...urls).all() : { results: [] },
  ]) : [null, { results: [] }];
  const pageErrs = Object.fromEntries((pageErrRows.results || []).map((r) => [r.url, r.error || null]));
  const seenOf = (r) => modelSeenAt(r.seen_at, clock?.probe.pages[pageIdForSource(r.source)], r.model);
  const seen = best ? seenOf(best) : null;
  const pageErr = best ? pageErrs[best.source] || null : null;
  return { code: 200, body: { summary, verdict: st, recommended_action: st === "retired" ? "switch_now" : st === "deprecated" ? "plan_migration" : st === "active" ? "keep_using" : "verify_with_provider",
    checked_at: now(), freshness: { data_as_of: seen, age_seconds: seen ? Math.round((Date.now() - Date.parse(seen)) / 1000) : null, source_error: pageErr || undefined, note: pageErr ? "Stored copy is stale: " + pageErr : "deprecation pages are re-read about every 45 minutes" },
    model: m, status: st,
    shutdown_date: info.shutdown_date || null, deprecated_on: info.deprecated_on || null, replacement: info.replacement || null,
    evidence: rows.map((r) => ({ provider: r.provider, status: r.status, ...JSON.parse(r.dates || "{}"), row: r.snippet, source: r.source, seen_at: seenOf(r), source_error: pageErrs[r.source] || undefined })),
    did_you_mean: sugg.length ? sugg : undefined, on_openrouter: orIds?.length ? orIds : undefined,
    states: "active = the provider's page explicitly lists it as active or with no shutdown date; deprecated = explicitly deprecated, shutdown in the future; retired = shutdown date has passed; unknown = not explicitly listed on any tracked deprecation page (not a guarantee it is live).",
    sponsored: null } };
}
function freshness(age, fresh) { return { age_seconds: age, fresh: age != null && age <= fresh, note: age == null ? "never checked" : age <= fresh ? "checked within the last " + Math.round(fresh / 60) + " minutes" : "stale: last check " + Math.round(age / 60) + " min ago" }; }
// ---------- scheduled collection ----------
async function fetchT(url, ms = 8000, init = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal, headers: { "user-agent": "UpstreamBot/0.1 (+https://github.com/toolweather/upstream)", ...(init.headers || {}) } }); } finally { clearTimeout(t); }
}
async function discardBody(r) { try { if (r.body?.cancel) await r.body.cancel(); else await r.arrayBuffer(); } catch {} }
function docFail(message) { const e = new Error(message); e.docMessage = message; return e; }
// HTML first. On 401/403 from OpenAI docs, retry the public Markdown URL they document
// (same path + `.md`). cache:no-store so a CDN HIT is not treated as a fresh re-read.
async function readDoc(url) {
  const r = await fetchT(url, 15000, { cache: "no-store", headers: { accept: "text/html" } });
  if (r.ok) return { response: r, markdown: isMarkdownBody(r.headers.get("content-type"), url), url };
  const status = r.status;
  await discardBody(r);
  const alt = (status === 403 || status === 401) ? docAlternateUrl(url) : null;
  if (alt) {
    const md = await fetchT(alt, 15000, { cache: "no-store", headers: { accept: "text/markdown, text/plain;q=0.9" } });
    if (md.ok) return { response: md, markdown: isMarkdownBody(md.headers.get("content-type"), alt), url: alt };
    await discardBody(md);
    throw docFail(docReadError(status, true));
  }
  if (status === 403 || status === 401) throw docFail(docReadError(status, false));
  throw new Error("HTTP " + status);
}
const pageTouch = (env, pg, t, error) => env.DB.prepare("UPDATE pages SET checked_at=?, error=? WHERE id=?").bind(t, error, pg.id);
async function checkProvider(p) {
  try {
    if (p.type === "sp") {
      const j = await (await fetchT(p.source)).json();
      const ind = STATE[j.status?.indicator] || "unknown";
      const inc = (j.incidents || []).map((i) => ({ name: i.name, status: i.status, impact: i.impact, updated_at: i.updated_at, url: i.shortlink }));
      const mnt = (j.scheduled_maintenances || []).filter((m) => m.status === "in_progress").map((m) => ({ name: m.name, status: "maintenance", impact: m.impact, updated_at: m.updated_at, url: m.shortlink }));
      const comps = (j.components || []).filter((c) => c.status !== "operational" && !c.group).map((c) => ({ name: c.name, status: c.status })).slice(0, 50);
      return { indicator: ind === "operational" && mnt.length ? "maintenance" : ind, description: j.status?.description, incidents: [...inc, ...mnt], components: comps };
    }
    if (p.type === "gcp") {
      const [inc, pr] = await Promise.all([fetchT(p.source).then((r) => r.json()), fetchT(p.probe).then((r) => r.status).catch(() => 0)]);
      const open = inc.filter((i) => !i.end && (i.affected_products || []).some((a) => /vertex|gemini|generative|ai studio|ai platform/i.test(a.title)))
        .map((i) => ({ name: i.external_desc?.slice(0, 200), status: i.most_recent_update?.status, impact: i.severity, updated_at: i.modified, url: "https://status.cloud.google.com/" + i.uri }));
      const ind = !pr || pr >= 500 ? "partial_outage" : open.some((i) => i.impact === "high") ? "partial_outage" : open.length ? "degraded" : "operational";
      return { indicator: ind, description: open.length ? `${open.length} open Google AI incident(s)` : pr >= 500 || !pr ? "Gemini API not responding normally" : "No open Google AI incidents; Gemini API reachable", incidents: open, components: [] };
    }
    const t0 = Date.now(); let st = 0; try { st = (await fetchT(p.source, 8000)).status; } catch {}
    const ms = Date.now() - t0, ok = st && st < 500;
    return { indicator: ok ? (ms > 6000 ? "degraded" : "operational") : "partial_outage", description: ok ? `API reachable (HTTP ${st}, ${ms} ms)` : `API not reachable (HTTP ${st || "timeout"})`, incidents: [], components: [] };
  } catch (e) { return { indicator: "unknown", description: "status source unreachable", incidents: [], components: [], error: String(e).slice(0, 200) }; }
}
const changeStmt = (env, e) => env.DB.prepare("INSERT INTO changes(provider,kind,title,detail,source,at) VALUES(?,?,?,?,?,?)").bind(e.provider, e.kind, e.title, JSON.stringify(e.detail), e.source, e.at);
const probeStmt = (env, probe) => env.DB.prepare("INSERT INTO meta VALUES('probe_clock',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(probe));
async function batchAll(env, st) { for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90)); }
async function collectStatus(env, t) {
  const res = await Promise.all(PROVIDERS.map(async (p) => [p, await checkProvider(p)]));
  const oldRows = (await env.DB.prepare(`SELECT provider,indicator,description,incidents,components,changed_at,error FROM status WHERE provider IN (${PROVIDERS.map(() => "?").join(",")})`).bind(...PROVIDERS.map((p) => p.id)).all()).results;
  const { writes, events } = planStatusWrites(Object.fromEntries(oldRows.map((r) => [r.provider, r])), res, t);
  const statements = writes.map((w) => env.DB.prepare("INSERT INTO status VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET indicator=excluded.indicator,description=excluded.description,incidents=excluded.incidents,components=excluded.components,checked_at=excluded.checked_at,changed_at=excluded.changed_at,error=excluded.error").bind(w.provider, w.indicator, w.description, w.incidents, w.components, w.checked_at, w.changed_at, w.error));
  for (const e of events) statements.push(changeStmt(env, e));
  return { statements, events };
}

async function pageText(resp) {
  const parts = []; let inRow = 0;
  const strip = new HTMLRewriter().on("script,style,noscript,svg,head,nav,footer,template,button", { element(e) { e.remove(); } }).transform(resp);
  await new HTMLRewriter()
    .on("tr", { element(e) { inRow++; parts.push("\n"); e.onEndTag(() => { inRow--; parts.push("\n"); }); } })
    .on("li,p,h1,h2,h3,h4,h5,dt,dd,br,div,section,table,pre", { element() { if (!inRow) parts.push("\n"); else parts.push(" "); } })
    .on("td,th", { element() { parts.push(" | "); } })
    .on("*", { text(t) { parts.push(t.text); } })
    .transform(strip).arrayBuffer();
  return parts.join("").replace(/&nbsp;|&#160;/g, " ").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/[ \t]+/g, " ")
    .split("\n").map((l) => l.trim().replace(/^\| ?/, "")).filter((l) => l.length > 2 && l.length < 1500).join("\n");
}
async function collectPage(env, pg, t) {
  try {
    const got = await readDoc(pg.url);
    const isModels = pg.kind === "deprecations";
    let text, models;
    if (got.markdown) {
      const tok = markdownTokens(await got.response.text());
      text = textFromTokens(tok);
      if (text.length < 40) throw docFail("stale: markdown source was empty. Stored copy was not updated.");
      models = isModels ? parseModels(tok, pg, today()) : null;
    } else {
      const r = got.response;
      [text, models] = await Promise.all([pageText(isModels ? r.clone() : r), isModels ? pageTokens(r).then((tk) => parseModels(tk, pg, today())) : null]);
    }
    const h = await sha(text);
    const old = await env.DB.prepare("SELECT hash,text,error FROM pages WHERE id=?").bind(pg.id).first();
    const st = [];
    const events = [];
    const plan = pagePersistPlan(old, h, null);
    if (plan === "content") st.push(env.DB.prepare("INSERT INTO pages VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,text=excluded.text,checked_at=excluded.checked_at,changed_at=CASE WHEN pages.hash=excluded.hash THEN pages.changed_at ELSE excluded.changed_at END,error=NULL").bind(pg.id, pg.provider, pg.url, h, text.slice(0, 900000), t, t));
    else st.push(pageTouch(env, pg, t, null));
    if (old?.text && old.hash !== h) {
      const a = new Set(old.text.split("\n")), b = new Set(text.split("\n"));
      const added = [...b].filter((l) => !a.has(l)), removed = [...a].filter((l) => !b.has(l));
      if (added.length || removed.length) events.push({ provider: pg.provider, kind: pg.kind, title: `${PBY[pg.provider].name} ${pg.kind} page changed (+${added.length} / -${removed.length} lines)`, detail: { added: added.slice(0, 40), removed: removed.slice(0, 40) }, source: pg.url, at: t });
    }
    if (models) {
      const prev = Object.fromEntries((await env.DB.prepare("SELECT model,status,dates,snippet,source FROM models WHERE provider=? AND source=?").bind(pg.provider, pg.url).all()).results.map((row) => [row.model, row]));
      const hadPrev = Object.keys(prev).length > 0;
      for (const [m, v] of models) {
        const info = { shutdown_date: v.shutdown_date || null, deprecated_on: v.deprecated_on || null, replacement: v.replacement || null, section: v.section || null, note: v.note || v.tentative_retirement || null };
        const dates = JSON.stringify(info);
        if (modelWriteNeeded(prev[m], { status: v.status, dates, snippet: v.evidence, source: pg.url })) st.push(env.DB.prepare("INSERT INTO models VALUES(?,?,?,?,?,?,?) ON CONFLICT(model,provider) DO UPDATE SET status=excluded.status,dates=excluded.dates,snippet=excluded.snippet,source=excluded.source,seen_at=excluded.seen_at").bind(m, pg.provider, v.status, dates, v.evidence, pg.url, t));
        if (hadPrev && prev[m]?.status !== v.status && v.status !== "active") events.push({ provider: pg.provider, kind: "model_retirement", title: `${m} (${PBY[pg.provider].name}): ${prev[m]?.status || "new"} → ${v.status}${info.shutdown_date ? ", shutdown " + info.shutdown_date : ""}`, detail: { model: m, from: prev[m]?.status || null, to: v.status, ...info, evidence: v.evidence }, source: pg.url, at: t });
      }
    }
    for (const e of events.slice(0, 50)) st.push(changeStmt(env, e));
    return { statements: st, events, pageState: { at: t, ok_at: t, ...(models ? { models: [...models.keys()].sort() } : {}) } };
  } catch (e) {
    const err = (e?.docMessage || String(e)).slice(0, 200);
    const old = await env.DB.prepare("SELECT error FROM pages WHERE id=?").bind(pg.id).first();
    const plan = pagePersistPlan(old, null, err);
    const st = plan === "insert_error"
      ? [env.DB.prepare("INSERT INTO pages(id,provider,url,checked_at,error) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error").bind(pg.id, pg.provider, pg.url, t, err)]
      : [pageTouch(env, pg, t, err)];
    return { statements: st, events: [], pageState: { at: t } };
  }
}
async function refreshCatalog(env) {
  try {
    const j = await (await fetchT("https://openrouter.ai/api/v1/models", 15000)).json();
    const v = JSON.stringify([...new Set(j.data.map((m) => norm(m.id)))].sort());
    const old = await env.DB.prepare("SELECT v FROM meta WHERE k='openrouter_models'").first();
    if (!metaWriteNeeded(old?.v ?? null, v)) return;
    await env.DB.prepare("INSERT INTO meta VALUES('openrouter_models',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(v).run();
  } catch {}
}

// ---------- webhooks ----------
async function notify(env, events) {
  const provs = [...new Set(events.map((e) => e.provider))];
  const ws = (await env.DB.prepare(`SELECT * FROM watches WHERE active=1 AND expires_at>? AND provider IN (${provs.map(() => "?").join(",")})`).bind(now(), ...provs).all()).results;
  await Promise.all(ws.map(async (w) => {
    const body = JSON.stringify({ type: "upstream.change", watch_id: w.id, provider: w.provider, events: events.filter((e) => e.provider === w.provider), sent_at: now() });
    const key = await crypto.subtle.importKey("raw", enc.encode(w.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
    let ok = false; try { ok = (await fetchT(w.url, 8000, { method: "POST", body, headers: { "content-type": "application/json", "x-upstream-signature": "sha256=" + sig } })).ok; } catch {}
    await env.DB.prepare(ok ? "UPDATE watches SET fails=0 WHERE id=?" : "UPDATE watches SET fails=fails+1, active=CASE WHEN fails+1>=5 THEN 0 ELSE 1 END WHERE id=?").bind(w.id).run();
  }));
}

// ---------- MCP ----------
const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const TOOLS = [
  { name: "check_api_status", title: "Is this API / provider down right now?",
    description: `Check whether one AI or developer API provider (OpenAI, Anthropic, Gemini, Mistral, Groq, GitHub, Stripe, Cloudflare, Vercel, Supabase, Twilio, ~40 total) is up, degraded, or down right now. Use before calling that provider, or right after 5xx/429/timeouts, to choose retry, wait, or a fallback. Not for a model id (check_model_deprecation), the filtered change feed (list_recent_api_changes), or the daily rollup (get_digest). Returns summary, verdict (up|degraded|partially down|down|unknown), recommended_action, incidents, affected_components, checked_at, and freshness; status is rechecked about every 5 minutes. An unknown provider id returns 404 unknown_provider. Example: {"provider":"openai"}. Free within the daily quota, then ${PRICES.status} via x402. Alias: get_status.`,
    inputSchema: { type: "object", properties: { provider: { type: "string", description: "Lowercase provider id from list_providers, not the display name. Examples: openai, anthropic, google-ai, mistral, groq, github, stripe, cloudflare.", examples: ["openai", "anthropic", "github"] } }, required: ["provider"] }, annotations: { title: "Is this API down?", ...RO } },
  { name: "check_model_deprecation", title: "Is this model deprecated, and what replaces it?",
    description: `Check whether one LLM model id is active, deprecated, or retired, plus its shutdown date and replacement, from that provider's deprecation page (OpenAI, Anthropic, Google, and other tracked LLM vendors). Use before hard-coding or calling a model, or when a call fails with model-not-found. Not for API uptime (check_api_status) and not for a retirement feed (list_recent_api_changes with kind model_retirement, or get_digest). Returns summary, verdict (active|deprecated|retired|unknown), recommended_action (keep_using|plan_migration|switch_now|verify_with_provider), replacement, shutdown_date, evidence, and freshness; pages are re-read every few hours. An unlisted id is verdict unknown, not an error; longer than 120 characters returns 400 bad_model_id. Example: {"model":"gpt-4-0613"}. Free within the daily quota, then ${PRICES.model} via x402. Alias: get_model (param id).`,
    inputSchema: { type: "object", properties: { model: { type: "string", minLength: 1, maxLength: 120, description: "Exact API model id, not a display name or provider id. 1–120 characters; lowercased, and a leading models/ is stripped. Examples: gpt-4-0613, claude-3-opus-20240229, gemini-1.5-pro.", examples: ["gpt-4-0613", "claude-3-opus-20240229"] }, id: { type: "string", minLength: 1, maxLength: 120, description: "Deprecated alias of model, only for the get_model tool name. Same 1–120 character API id. Ignored when model is also set." } } }, annotations: { title: "Is this model deprecated?", ...RO } },
  { name: "list_recent_api_changes", title: "What changed recently in AI/dev APIs?",
    description: `List the on-demand feed of recent AI and developer API changes (status flips, deprecation-page edits, model retirements, pricing-page edits). Use for a chosen window, one provider, or one kind, when explaining sudden breakage. Not for live up/down (check_api_status) and not for the once-a-day digest, which also covers MCP server breakage (get_digest). Returns summary, count, freshness, and changes[] with provider, kind, title, detail, source, and at, newest first. Status rows arrive within about 5 minutes; doc-page rows every few hours. A limit above 500 is clamped to 500; an unknown provider returns an empty list, not an error. Example: {"provider":"anthropic","kind":"model_retirement"}. Free within the daily quota, then ${PRICES.changes} via x402. Alias: get_changes.`,
    inputSchema: { type: "object", properties: { since: { type: "string", description: "Exclusive lower bound compared to each change's at. ISO 8601 UTC. Example: 2026-10-01T00:00:00Z. Omit for 7 days ago.", examples: ["2026-10-01T00:00:00Z"] }, provider: { type: "string", description: "Optional lowercase provider id from list_providers, e.g. openai or anthropic. Omit for every provider.", examples: ["openai", "anthropic"] }, kind: { type: "string", enum: ["status", "deprecations", "model_retirement", "pricing"], description: "Optional type filter. status = provider state flips; deprecations = deprecation-page line edits; model_retirement = a model id became deprecated or retired; pricing = pricing-page line edits. Omit for all four.", examples: ["model_retirement"] }, limit: { type: "number", description: "How many changes to return, newest first. Positive integer. Omit for 100.", examples: [100] } } }, annotations: { title: "Recent API changes", ...RO } },
  { name: "list_providers", title: "List tracked API providers", description: "List every AI and developer API provider Upstream tracks (~40) with id, name, category, current state, checked_at, and status page. Use to pick a provider id for check_api_status, or for one all-providers health pass. Not for one provider's incidents (check_api_status) and not for what changed (list_recent_api_changes or get_digest). No parameters. Always free; does not spend the daily quota. State is refreshed about every 5 minutes. Returns {count, providers:[{id, name, category, state, checked_at, status_page}]}; state is operational, degraded, partial_outage, major_outage, maintenance, or unknown.", inputSchema: { type: "object", properties: {} }, annotations: { title: "List providers", ...RO } },
  { name: "get_digest", title: "Daily AI/dev API breaking-changes digest", description: "Read one published daily breaking-changes digest: AI/dev API status flips, model deprecations and retirements, pricing-page edits, and breaking MCP server changes. Use for a once-a-day catch-up. For a filtered on-demand API feed with no MCP section, use list_recent_api_changes; for live up/down, check_api_status; for one model id, check_model_deprecation. Always free (no quota, no x402). Published once at 12:00 UTC as a frozen window since the previous issue (usually ~24h); not updated later. Omit date for the latest; a missing YYYY-MM-DD returns 404 {error:no_issue}. One issue per date, no paging. Returns {date, title, summary, window_start, window_end, published_at, markdown, data, url, sponsor:null}. data holds counts, status, open_now, model_changes, shutting_down_30d, pricing, deprecation_page_edits, and mcp (breaking, non_breaking, down, back, auth_broken, auth_fixed). markdown caps model rows, breaking MCP rows, and each MCP event kind at 30, 30, and 20; data is the full window.", inputSchema: { type: "object", properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Published issue date, YYYY-MM-DD (example 2026-10-14). Omit for the latest issue. A date with no stored issue returns 404 no_issue; issues appear at 12:00 UTC.", examples: ["2026-10-14"] } } }, annotations: { title: "Daily digest", ...RO } },
];
const ALIAS = { get_status: "check_api_status", get_model: "check_model_deprecation", get_changes: "list_recent_api_changes" };
async function mcp(c, env, ctx) {
  let msg; try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  const { id, method, params = {} } = msg || {};
  const ok = (result) => c.json({ jsonrpc: "2.0", id, result });
  if (id === undefined) return c.body(null, 202);
  if (method === "initialize") return ok({ protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "upstream", title: "Upstream", version: VERSION },
    instructions: `Use check_api_status before calling an AI/dev API or after 5xx/timeouts; check_model_deprecation before using a model id; list_recent_api_changes for the on-demand change feed; get_digest for the once-a-day digest (it also includes MCP breakage). Every result starts with a one-line summary. Free: ${env.FREE_KEY_DAILY} calls/day with a free key (POST /v1/keys, send as X-API-Key) or ${env.FREE_ANON_DAILY}/day without one. list_providers and get_digest are always free and do not spend that quota. Over quota, paid tools return an x402 payment requirement; retry with params._meta["x402/payment"] set to the signed payment payload.` });
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method !== "tools/call") return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  const a = params.arguments || {}, name = ALIAS[params.name] || params.name;
  const run = async () => name === "list_providers" ? await listProviders(env) : name === "check_api_status" ? await getStatus(env, a.provider) : name === "list_recent_api_changes" ? await getChanges(env, a) : name === "check_model_deprecation" ? await getModel(env, a.model || a.id) : null;
  const res = (r, extra = {}) => ok({ content: [{ type: "text", text: JSON.stringify(r.body) }], structuredContent: r.body, isError: r.code >= 400, ...extra });
  if (name === "list_providers") return res(await run());
  if (name === "get_digest") { const r = a.date ? await digestBy(env, a.date) : await latestDigest(env); return res(r ? { code: 200, body: digestOut(r) } : { code: 404, body: { error: "no_issue", hint: "issues are published daily at 12:00 UTC" } }); }
  if (!["check_api_status", "list_recent_api_changes", "check_model_deprecation"].includes(name)) return c.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
  const pay = params._meta?.["x402/payment"];
  if (!pay) { const q = await takeFree(env, c); if (q.free) return res(await run()); }
  const x = x402(env); if (!x.ready) x.ready = x.server.initialize(); await x.ready;
  const price = { check_api_status: PRICES.status, list_recent_api_changes: PRICES.changes, check_model_deprecation: PRICES.model }[name];
  const reqs = await x.server.buildPaymentRequirements(x.opt(price));
  const resource = { url: new URL(c.req.url).origin + "/mcp#" + name, description: "Upstream MCP tool " + name, mimeType: "application/json" };
  if (!pay) {
    const pr = await x.server.createPaymentRequiredResponse(reqs, resource, "Free daily quota used up. Pay per call via x402, or come back tomorrow.");
    return ok({ content: [{ type: "text", text: JSON.stringify(pr) }], structuredContent: pr, isError: true, _meta: { "x402/payment-required": pr } });
  }
  const payload = typeof pay === "string" ? JSON.parse(atob(pay)) : pay;
  const match = x.server.findMatchingRequirements(reqs, payload);
  const v = match && (await x.server.verifyPayment(payload, match));
  if (!v?.isValid) return ok({ content: [{ type: "text", text: "payment invalid: " + (v?.invalidReason || "no matching requirement") }], isError: true });
  const r = await run();
  if (r.code >= 400) return res(r); // don't charge for errors
  const s = await x.server.settlePayment(payload, match).catch((e) => ({ success: false, errorReason: String(e).slice(0, 200) }));
  if (!s?.success) return ok({ content: [{ type: "text", text: "payment settlement failed, you were not charged: " + (s?.errorReason || "unknown") }], isError: true, _meta: { "x402/payment-response": { success: false, errorReason: s?.errorReason } } });
  return res(r, { _meta: { "x402/payment-response": s } });
}

// ---------- app ----------
async function listProviders(env) {
  const [listed, clock] = await Promise.all([env.DB.prepare("SELECT * FROM status").all(), loadProbe(env)]);
  const rows = Object.fromEntries(listed.results.map((r) => [r.provider, r]));
  return { code: 200, body: { count: PROVIDERS.length, providers: PROVIDERS.map((p) => { const r = rows[p.id]; return { id: p.id, name: p.name, category: p.category, state: r?.indicator || "unknown", checked_at: r ? laterIso(r.checked_at, clock.probe.status) : null, status_page: p.page }; }) } };
}
const app = new Hono();
app.use("*", cors({ origin: "*", exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "X-PAYMENT-RESPONSE", "X-Free-Remaining", "X-Free-Plan"] }));
app.onError((e, c) => c.json({ error: "internal_error", detail: String(e).slice(0, 200) }, 500));

// freemium gate: free quota first; only when it's used up (or the client already attached a payment) does x402 take over
const gate = async (c, next) => {
  if (!paidHeader(c)) {
    const q = await takeFree(c.env, c);
    c.header("X-Free-Plan", q.plan); c.header("X-Free-Remaining", String(q.remaining));
    if (q.free) return next();
  }
  return x402(c.env).mw(c, next);
};
app.get("/status/:provider", gate, async (c) => { const r = await getStatus(c.env, c.req.param("provider")); return c.json(r.body, r.code); });
app.get("/changes", gate, async (c) => { const r = await getChanges(c.env, c.req.query()); return c.json(r.body, r.code); });
app.get("/model/:id{.+}", gate, async (c) => { const r = await getModel(c.env, c.req.param("id")); return c.json(r.body, r.code); });
// always-paid lane (no free quota), for x402 directories and agents that prefer to just pay
const payOnly = (c, next) => x402(c.env).mw(c, next);
app.get("/x402/status/:provider", payOnly, async (c) => { const r = await getStatus(c.env, c.req.param("provider")); return c.json(r.body, r.code); });
app.get("/x402/changes", payOnly, async (c) => { const r = await getChanges(c.env, c.req.query()); return c.json(r.body, r.code); });
app.get("/x402/model/:id{.+}", payOnly, async (c) => { const r = await getModel(c.env, c.req.param("id")); return c.json(r.body, r.code); });
app.get("/providers", async (c) => { const r = await listProviders(c.env); return c.json(r.body, 200, { "cache-control": "max-age=60" }); });

app.post("/v1/keys", async (c) => {
  const env = c.env, ih = await ipHash(env, "key", c.req.raw), d = today();
  const mine = await env.DB.prepare("SELECT COUNT(*) n FROM keys WHERE ip_hash=? AND created_at>=?").bind(ih, d).first();
  const all = await env.DB.prepare("SELECT COUNT(*) n FROM keys WHERE created_at>=?").bind(d).first();
  if (mine.n >= 3 || all.n >= 300) return c.json({ error: "rate_limited", detail: "Max 3 new keys per network per day. You can still use the anonymous allowance." }, 429);
  const k = "up_" + hex(crypto.getRandomValues(new Uint8Array(20)));
  await env.DB.prepare("INSERT INTO keys(key_hash,created_at,ip_hash,day,used) VALUES(?,?,?,?,0)").bind(await sha(k), now(), ih, d).run();
  return c.json({ api_key: k, free_calls_per_day: +env.FREE_KEY_DAILY, free_watches: 1, note: "Shown once, so store it now. Send it as the X-API-Key header (REST or /mcp)." }, 201);
});
// watches: first one free per key, each extra one is x402-paid (30 days)
const watchGate = async (c, next) => {
  const kr = await keyRow(c.env, c); if (!kr) return c.json({ error: "api_key_required", detail: "Get a free key: POST /v1/keys" }, 401);
  c.set("kr", kr);
  const n = await c.env.DB.prepare("SELECT COUNT(*) n FROM watches WHERE key_hash=? AND active=1 AND expires_at>?").bind(kr.key_hash, now()).first();
  c.set("paid", n.n >= 1);
  return n.n < 1 && !paidHeader(c) ? next() : x402(c.env).mw(c, next);
};
app.post("/v1/watches", watchGate, async (c) => {
  let b = {}; try { b = await c.req.json(); } catch {}
  if (!PBY[b.provider]) return c.json({ error: "unknown_provider" }, 400);
  if (!/^https:\/\/[^\s]{4,500}$/.test(b.url || "")) return c.json({ error: "url must be an https webhook URL" }, 400);
  const w = { id: "w_" + hex(crypto.getRandomValues(new Uint8Array(8))), secret: hex(crypto.getRandomValues(new Uint8Array(24))) };
  const paid = c.get("paid"), exp = paid ? new Date(Date.now() + 30 * 864e5).toISOString() : "9999-12-31";
  await c.env.DB.prepare("INSERT INTO watches(id,key_hash,provider,url,secret,paid,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?)").bind(w.id, c.get("kr").key_hash, b.provider, b.url, w.secret, paid ? 1 : 0, exp, now()).run();
  return c.json({ watch_id: w.id, provider: b.provider, url: b.url, signing_secret: w.secret, plan: paid ? "paid (30 days)" : "free watch", expires_at: paid ? exp : null,
    note: "We POST JSON on status changes, model retirements and deprecation/pricing page edits. Verify X-Upstream-Signature = sha256=HMAC_SHA256(secret, body)." }, 201);
});
app.get("/v1/watches", async (c) => { const kr = await keyRow(c.env, c); if (!kr) return c.json({ error: "api_key_required" }, 401);
  return c.json({ watches: (await c.env.DB.prepare("SELECT id,provider,url,paid,expires_at,active,fails,created_at FROM watches WHERE key_hash=?").bind(kr.key_hash).all()).results }); });
app.delete("/v1/watches/:id", async (c) => { const kr = await keyRow(c.env, c); if (!kr) return c.json({ error: "api_key_required" }, 401);
  await c.env.DB.prepare("UPDATE watches SET active=0 WHERE id=? AND key_hash=?").bind(c.req.param("id"), kr.key_hash).run(); return c.json({ ok: true }); });

app.post("/admin/run", async (c) => {
  if (!c.env.ADMIN_TOKEN || c.req.header("authorization") !== "Bearer " + c.env.ADMIN_TOKEN) return c.json({ error: "forbidden" }, 403);
  const what = c.req.query("what");
  if (what === "status") {
    const t = now(), clock = await loadProbe(c.env), status = await collectStatus(c.env, t);
    clock.probe.status = t;
    await batchAll(c.env, [...status.statements, probeStmt(c.env, clock.probe)]);
    if (status.events.length) c.executionCtx.waitUntil(notify(c.env, status.events));
  }
  else if (what === "catalog") await refreshCatalog(c.env);
  else if (what === "drain") return c.json(await drainOutbox(c.env));
  else if (what === "tw") return c.json(await twSnapshot(c.env));
  else if (what === "digest") { const d = await buildDigest(c.env, c.req.query("date") || today()); if (c.req.query("save") === "1") await saveDigest(c.env, d); return c.json(d); }
  else if (what === "tokens" || what === "parse") {
    const pg = PAGES.find((p) => p.id === c.req.query("page")); if (!pg) return c.json({ error: "unknown" }, 400);
    const got = await readDoc(pg.url);
    const tok = got.markdown ? markdownTokens(await got.response.text()) : await pageTokens(got.response);
    if (what === "tokens") return c.json(tok.filter((t) => t.t !== "p" && t.t !== "li").slice(0, 400));
    return c.json(Object.fromEntries(parseModels(tok, pg, today())));
  }
  else {
    const pg = PAGES.find((p) => p.id === what); if (!pg) return c.json({ error: "unknown" }, 400);
    const t = now(), clock = await loadProbe(c.env), page = await collectPage(c.env, pg, t);
    clock.probe.pages[pg.id] = mergePageProbe(clock.probe.pages[pg.id], page.pageState);
    await batchAll(c.env, [...page.statements, probeStmt(c.env, clock.probe)]);
    if (page.events.length) c.executionCtx.waitUntil(notify(c.env, page.events));
  }
  return c.json({ ok: true, what });
});
// ---- daily digest (always free) ----
const latestDigest = (env) => env.DB.prepare("SELECT * FROM digests ORDER BY date DESC LIMIT 1").first();
const digestBy = (env, d) => env.DB.prepare("SELECT * FROM digests WHERE date=?").bind(d).first();
app.get("/digest/latest", async (c) => { const r = await latestDigest(c.env); return r ? c.json(digestOut(r), 200, { "cache-control": "max-age=300" }) : c.json({ error: "no_issue_yet" }, 404); });
app.get("/digest", async (c) => c.json({ issues: (await c.env.DB.prepare("SELECT date,title,summary,created_at FROM digests ORDER BY date DESC LIMIT 366").all()).results, latest: "/digest/latest", feed: "/digest/feed.xml", page: SITE + "/digest/" }));
app.get("/digest/feed.xml", async (c) => c.body(atom((await c.env.DB.prepare("SELECT * FROM digests ORDER BY date DESC LIMIT 30").all()).results, new URL(c.req.url).origin), 200, { "content-type": "application/atom+xml; charset=utf-8", "cache-control": "max-age=600" }));
app.post("/digest/subscribe", async (c) => {
  let email; const ct = c.req.header("content-type") || "";
  if (ct.includes("json")) { try { email = (await c.req.json()).email; } catch {} } else { const f = await c.req.parseBody(); email = f.email; }
  const r = await subscribe(c.env, email, await ipHash(c.env, "sub", c.req.raw), sha, new URL(c.req.url).origin);
  if (!ct.includes("json") && (c.req.header("accept") || "").includes("text/html")) return c.redirect(SITE + "/digest/?subscribed=" + (r.code === 200 ? "1" : "0"), 303);
  return c.json(r.body, r.code);
});
for (const k of ["confirm", "unsubscribe"]) app.get("/digest/" + k, async (c) => { const ok = await confirmOrUnsub(c.env, k, c.req.query("token"), sha, c.req.query("e")); return c.redirect(SITE + "/digest/?" + k + "=" + (ok ? "1" : "0"), 303); });
// RFC 8058 one-click unsubscribe (List-Unsubscribe-Post)
app.post("/digest/unsubscribe", async (c) => { const ok = await confirmOrUnsub(c.env, "unsubscribe", c.req.query("token"), sha, c.req.query("e")); return c.json({ ok }, ok ? 200 : 400); });
app.get("/digest/:date{\\d{4}-\\d{2}-\\d{2}}", async (c) => { const r = await digestBy(c.env, c.req.param("date")); return r ? c.json(digestOut(r), 200, { "cache-control": "max-age=3600" }) : c.json({ error: "no_issue_for_date" }, 404); });

app.post("/mcp", (c) => mcp(c, c.env, c.executionCtx));
app.get("/mcp", (c) => c.json({ error: "Use POST (streamable HTTP, JSON responses)" }, 405));
const CARD = (o) => ({ name: "upstream", title: "Upstream: is this AI/dev API down? is this model deprecated?", version: VERSION,
  description: "Check if an AI or developer API (OpenAI, Anthropic, Gemini, GitHub, Stripe... ~40 providers) is down right now, whether a model is deprecated and what replaces it, and what changed recently. Decisive one-line summary first. Free daily quota, then x402 USDC on Base.",
  transport: "streamable-http", url: o + "/mcp", serverInfo: { name: "upstream", title: "Upstream", version: VERSION }, capabilities: { tools: {} },
  tools: TOOLS.map((t) => t.name), tool_details: TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, annotations: t.annotations })), deprecated_aliases: ALIAS,
  documentation: SITE, llms_txt: o + "/llms.txt", openapi: o + "/openapi.json", authentication: { required: false, optional: "X-API-Key header (free key: POST /v1/keys)" } });
app.get("/.well-known/mcp", (c) => c.json(CARD(new URL(c.req.url).origin)));
app.get("/.well-known/mcp.json", (c) => c.json(CARD(new URL(c.req.url).origin)));
app.get("/.well-known/mcp/server-card.json", (c) => c.json(CARD(new URL(c.req.url).origin)));
app.get("/llms.txt", (c) => c.text(LLMS(new URL(c.req.url).origin, c.env)));
app.get("/.well-known/x402", (c) => c.json({ version: 1, resources: ["/x402/status/{provider}", "/x402/changes", "/x402/model/{id}"].map((x) => new URL(c.req.url).origin + x) }));
app.get("/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin, c.env)));
app.get("/health", async (c) => {
  const [r, pg, meta] = await Promise.all([
    c.env.DB.prepare("SELECT MIN(checked_at) oldest, MAX(checked_at) newest, COUNT(*) n FROM status").first(),
    c.env.DB.prepare("SELECT id,checked_at,changed_at,error FROM pages").all(),
    c.env.DB.prepare("SELECT k,v FROM meta WHERE k IN ('probe_clock','last_cron')").all(),
  ]);
  const m = Object.fromEntries(meta.results.map((x) => [x.k, x.v]));
  const probe = parseProbe(m.probe_clock);
  if (probe.status && r?.n) { r.oldest = laterIso(r.oldest, probe.status); r.newest = laterIso(r.newest, probe.status); }
  const pages = pg.results.map((p) => ({ ...p, checked_at: laterIso(p.checked_at, probe.pages[p.id]?.at) }));
  return c.json({ ok: true, version: VERSION, last_cron: probe.status || m.last_cron || null, network: c.env.X402_NETWORK, status_rows: r, pages });
});
app.get("/", (c) => c.json({ name: "Upstream", what: "Is the AI/dev API your agent depends on up right now, and what's changing (deprecations, model retirements, pricing)?",
  free_tier: { with_free_key: `${c.env.FREE_KEY_DAILY} calls/day (POST /v1/keys)`, anonymous: `${c.env.FREE_ANON_DAILY} calls/day`, watches: "1 free change-alert webhook per key" },
  over_quota: { protocol: "x402 v2", network: c.env.X402_NETWORK, prices_usdc: PRICES }, docs: ["/llms.txt", "/openapi.json", SITE],
  digest: { latest: "/digest/latest", list: "/digest", by_date: "/digest/:date", feed: "/digest/feed.xml", page: SITE + "/digest/" }, endpoints: ["GET /providers", "GET /status/:provider", "GET /changes?since=&provider=&kind=", "GET /model/:id", "POST /v1/keys", "POST /v1/watches", "POST /mcp", "GET /health"] }));

export default {
  fetch: app.fetch,
  async scheduled(ev, env, ctx) {
    // Free plan: 50 external subrequests per invocation. One fetch per provider, plus a second
    // for Google AI, plus one docs page = 42 (43 if OpenAI HTML 403s and we retry .md).
    // All providers are checked every run. Unchanged status/text/model rows are not rewritten.
    // Each doc read still touches that page's checked_at (one row) and probe_clock.
    const plan = cronPlan(ev.scheduledTime), t = now(), clock = await loadProbe(env);
    const status = await collectStatus(env, t);
    // The noon digest already walks the Toolweather snapshot. Skip the docs-page parse on that
    // tick so this invocation stays inside the free-plan CPU budget. A page failure must not
    // drop the status batch: that clock is what API freshness reads.
    const pg = PAGES[plan.pageIndex];
    let page = null;
    if (!plan.digest) { try { page = await collectPage(env, pg, t); } catch { page = null; } }
    clock.probe.status = t;
    if (page) clock.probe.pages[pg.id] = mergePageProbe(clock.probe.pages[pg.id], page.pageState);
    await batchAll(env, [...status.statements, ...(page?.statements || []), probeStmt(env, clock.probe)]);
    const events = [...status.events, ...(page?.events || [])];
    if (events.length) ctx.waitUntil(notify(env, events));
    if (plan.catalog) await refreshCatalog(env);
    if (plan.tw) ctx.waitUntil(twSnapshot(env));
    // 12:00 UTC (6:00 AM Mexico City): publish the issue for today's date, covering everything since the previous issue
    if (plan.digest) { await twSnapshot(env); const dg = await buildDigest(env, new Date(ev.scheduledTime).toISOString().slice(0, 10)); await saveDigest(env, dg); if (env.EMAIL_SENDING_ENABLED === "true") await enqueueDigest(env, dg); }
    if (mailReady(env)) ctx.waitUntil(drainOutbox(env));
  },
};
