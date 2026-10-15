import { Hono } from "hono";
import { cors } from "hono/cors";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { PROVIDERS, PAGES } from "./providers.js";
import { pageTokens, parseModels } from "./models.js";
import { twSnapshot, buildDigest, saveDigest, digestOut, atom, subscribe, confirmOrUnsub, enqueueDigest } from "./digest.js";
import { drainOutbox, mailReady } from "./mailer.js";
import { LLMS, openapi, SITE } from "./docs.js";

const VERSION = "0.1.0";
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
async function getStatus(env, id) {
  const p = PBY[id]; if (!p) return { code: 404, body: { error: "unknown_provider", hint: "GET /providers for the list" } };
  const r = await env.DB.prepare("SELECT * FROM status WHERE provider=?").bind(id).first();
  const pages = PAGES.filter((x) => x.provider === id).map((x) => ({ kind: x.kind, url: x.url }));
  const recent = (await env.DB.prepare("SELECT kind,title,at FROM changes WHERE provider=? ORDER BY id DESC LIMIT 5").bind(id).all()).results;
  return { code: 200, body: { ...rowOut(p, r), tracked_pages: pages, recent_changes: recent } };
}
async function getChanges(env, q) {
  let sql = "SELECT * FROM changes WHERE at>?", a = [q.since || new Date(Date.now() - 7 * 864e5).toISOString()];
  if (q.provider) { sql += " AND provider=?"; a.push(q.provider); }
  if (q.kind) { sql += " AND kind=?"; a.push(q.kind); }
  sql += " ORDER BY id DESC LIMIT ?"; a.push(Math.min(+q.limit || 100, 500));
  const rs = (await env.DB.prepare(sql).bind(...a).all()).results.map((r) => ({ ...r, detail: JSON.parse(r.detail || "null") }));
  return { code: 200, body: { since: a[0], count: rs.length, kinds: ["status", "deprecations", "model_retirement", "pricing"], changes: rs } };
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
  return { code: 200, body: { model: m, status: best ? best.status : "unknown",
    shutdown_date: info.shutdown_date || null, deprecated_on: info.deprecated_on || null, replacement: info.replacement || null,
    evidence: rows.map((r) => ({ provider: r.provider, status: r.status, ...JSON.parse(r.dates || "{}"), row: r.snippet, source: r.source, seen_at: r.seen_at })),
    did_you_mean: sugg.length ? sugg : undefined, on_openrouter: orIds?.length ? orIds : undefined,
    states: "active = the provider's page explicitly lists it as active or with no shutdown date; deprecated = explicitly deprecated, shutdown in the future; retired = shutdown date has passed; unknown = not explicitly listed on any tracked deprecation page (not a guarantee it is live).",
    sponsored: null } };
}
// ---------- scheduled collection ----------
async function fetchT(url, ms = 8000, init = {}) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal, headers: { "user-agent": "UpstreamBot/0.1 (+https://github.com/toolweather/upstream)", ...(init.headers || {}) } }); } finally { clearTimeout(t); }
}
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
async function runStatusBatch(env, ctx, minute) {
  const batch = PROVIDERS.filter((_, i) => i % 4 === minute % 4);
  const res = await Promise.all(batch.map(async (p) => [p, await checkProvider(p)]));
  const old = Object.fromEntries((await env.DB.prepare(`SELECT provider,indicator,changed_at FROM status WHERE provider IN (${batch.map(() => "?").join(",")})`).bind(...batch.map((p) => p.id)).all()).results.map((r) => [r.provider, r]));
  const t = now(), st = [], events = [];
  for (const [p, r] of res) {
    const o = old[p.id], changed = !o || o.indicator !== r.indicator;
    // "unknown" means our fetch failed, not the provider: don't emit a change for it
    if (o && changed && r.indicator !== "unknown" && o.indicator !== "unknown") {
      const ev = { provider: p.id, kind: "status", title: `${p.name}: ${o.indicator} → ${r.indicator}`, detail: { from: o.indicator, to: r.indicator, summary: r.description, incidents: r.incidents.slice(0, 5) }, source: p.page, at: t };
      events.push(ev);
    }
    st.push(env.DB.prepare("INSERT INTO status VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET indicator=excluded.indicator,description=excluded.description,incidents=excluded.incidents,components=excluded.components,checked_at=excluded.checked_at,changed_at=excluded.changed_at,error=excluded.error")
      .bind(p.id, r.indicator, r.description || null, JSON.stringify(r.incidents), JSON.stringify(r.components), t, changed ? t : o.changed_at, r.error || null));
  }
  for (const e of events) st.push(env.DB.prepare("INSERT INTO changes(provider,kind,title,detail,source,at) VALUES(?,?,?,?,?,?)").bind(e.provider, e.kind, e.title, JSON.stringify(e.detail), e.source, e.at));
  await env.DB.batch(st);
  if (events.length) ctx.waitUntil(notify(env, events));
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
async function runPage(env, ctx, pg) {
  const t = now();
  try {
    const r = await fetchT(pg.url, 15000, { headers: { accept: "text/html" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const isModels = pg.kind === "deprecations";
    const [text, models] = await Promise.all([pageText(isModels ? r.clone() : r), isModels ? pageTokens(r).then((tk) => parseModels(tk, pg, today())) : null]);
    const h = await sha(text);
    const old = await env.DB.prepare("SELECT hash,text FROM pages WHERE id=?").bind(pg.id).first();
    const st = [env.DB.prepare("INSERT INTO pages VALUES(?,?,?,?,?,?,?,NULL) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash,text=excluded.text,checked_at=excluded.checked_at,changed_at=CASE WHEN pages.hash=excluded.hash THEN pages.changed_at ELSE excluded.changed_at END,error=NULL")
      .bind(pg.id, pg.provider, pg.url, h, text.slice(0, 900000), t, t)];
    const events = [];
    if (old && old.hash !== h) {
      const a = new Set(old.text.split("\n")), b = new Set(text.split("\n"));
      const added = [...b].filter((l) => !a.has(l)), removed = [...a].filter((l) => !b.has(l));
      if (added.length || removed.length) events.push({ provider: pg.provider, kind: pg.kind, title: `${PBY[pg.provider].name} ${pg.kind} page changed (+${added.length} / -${removed.length} lines)`, detail: { added: added.slice(0, 40), removed: removed.slice(0, 40) }, source: pg.url, at: t });
    }
    if (models) {
      const prev = Object.fromEntries((await env.DB.prepare("SELECT model,status FROM models WHERE provider=? AND source=?").bind(pg.provider, pg.url).all()).results.map((r) => [r.model, r.status]));
      const hadPrev = Object.keys(prev).length > 0;
      for (const [m, v] of models) {
        const info = { shutdown_date: v.shutdown_date || null, deprecated_on: v.deprecated_on || null, replacement: v.replacement || null, section: v.section || null, note: v.note || v.tentative_retirement || null };
        st.push(env.DB.prepare("INSERT INTO models VALUES(?,?,?,?,?,?,?) ON CONFLICT(model,provider) DO UPDATE SET status=excluded.status,dates=excluded.dates,snippet=excluded.snippet,source=excluded.source,seen_at=excluded.seen_at")
          .bind(m, pg.provider, v.status, JSON.stringify(info), v.evidence, pg.url, t));
        if (hadPrev && prev[m] !== v.status && v.status !== "active") events.push({ provider: pg.provider, kind: "model_retirement", title: `${m} (${PBY[pg.provider].name}): ${prev[m] || "new"} → ${v.status}${info.shutdown_date ? ", shutdown " + info.shutdown_date : ""}`, detail: { model: m, from: prev[m] || null, to: v.status, ...info, evidence: v.evidence }, source: pg.url, at: t });
      }
    }
    for (const e of events.slice(0, 50)) st.push(env.DB.prepare("INSERT INTO changes(provider,kind,title,detail,source,at) VALUES(?,?,?,?,?,?)").bind(e.provider, e.kind, e.title, JSON.stringify(e.detail), e.source, e.at));
    for (let i = 0; i < st.length; i += 90) await env.DB.batch(st.slice(i, i + 90));
    if (events.length) ctx.waitUntil(notify(env, events));
  } catch (e) {
    await env.DB.prepare("INSERT INTO pages(id,provider,url,checked_at,error) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET checked_at=excluded.checked_at,error=excluded.error").bind(pg.id, pg.provider, pg.url, t, String(e).slice(0, 200)).run();
  }
}
async function refreshCatalog(env) {
  try { const j = await (await fetchT("https://openrouter.ai/api/v1/models", 15000)).json();
    await env.DB.prepare("INSERT INTO meta VALUES('openrouter_models',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(j.data.map((m) => norm(m.id)))).run(); } catch {}
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
const TOOLS = [
  { name: "list_providers", description: "List the ~40 AI and developer API providers Upstream tracks, with their current state. Free.", inputSchema: { type: "object", properties: {} } },
  { name: "get_digest", description: "Daily breaking-changes digest (free): AI/dev API incidents, model deprecations/retirements, pricing-page changes, breaking MCP server changes. Optional date YYYY-MM-DD, default latest.", inputSchema: { type: "object", properties: { date: { type: "string", description: "YYYY-MM-DD; omit for the latest issue" } } } },
  { name: "get_status", description: `Is this provider's API up right now? Current state, open incidents, affected components. Free within the daily quota, then ${PRICES.status} via x402.`, inputSchema: { type: "object", properties: { provider: { type: "string", description: "provider id from list_providers, e.g. openai, anthropic, github, stripe" } }, required: ["provider"] } },
  { name: "get_changes", description: `What changed: status transitions, deprecation-page edits, model retirements, pricing-page edits. Free within the daily quota, then ${PRICES.changes} via x402.`, inputSchema: { type: "object", properties: { since: { type: "string", description: "ISO timestamp, default 7 days ago" }, provider: { type: "string" }, kind: { type: "string", enum: ["status", "deprecations", "model_retirement", "pricing"] }, limit: { type: "number" } } } },
  { name: "get_model", description: `Is this model id active, deprecated or retired? Shutdown date and replacement, from the provider's own deprecation page ("unknown" if not explicitly listed). Free within the daily quota, then ${PRICES.model} via x402.`, inputSchema: { type: "object", properties: { id: { type: "string", description: "model id, e.g. gpt-4o, claude-3-opus-20240229, gemini-1.5-pro" } }, required: ["id"] } },
];
async function mcp(c, env, ctx) {
  let msg; try { msg = await c.req.json(); } catch { return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }, 400); }
  const { id, method, params = {} } = msg || {};
  const ok = (result) => c.json({ jsonrpc: "2.0", id, result });
  if (id === undefined) return c.body(null, 202);
  if (method === "initialize") return ok({ protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "upstream", version: VERSION },
    instructions: `Free: ${env.FREE_KEY_DAILY} calls/day with a free key (POST /v1/keys, send as X-API-Key) or ${env.FREE_ANON_DAILY}/day without one. Over quota, paid tools return an x402 payment requirement; retry with params._meta["x402/payment"] set to the signed payment payload.` });
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method !== "tools/call") return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
  const a = params.arguments || {}, name = params.name;
  const run = async () => name === "list_providers" ? await listProviders(env) : name === "get_status" ? await getStatus(env, a.provider) : name === "get_changes" ? await getChanges(env, a) : name === "get_model" ? await getModel(env, a.id) : null;
  const res = (r, extra = {}) => ok({ content: [{ type: "text", text: JSON.stringify(r.body) }], structuredContent: r.body, isError: r.code >= 400, ...extra });
  if (name === "list_providers") return res(await run());
  if (name === "get_digest") { const r = a.date ? await digestBy(env, a.date) : await latestDigest(env); return res(r ? { code: 200, body: digestOut(r) } : { code: 404, body: { error: "no_issue", hint: "issues are published daily at 12:00 UTC" } }); }
  if (!["get_status", "get_changes", "get_model"].includes(name)) return c.json({ jsonrpc: "2.0", id, error: { code: -32602, message: "unknown tool" } });
  const pay = params._meta?.["x402/payment"];
  if (!pay) { const q = await takeFree(env, c); if (q.free) return res(await run()); }
  const x = x402(env); if (!x.ready) x.ready = x.server.initialize(); await x.ready;
  const price = { get_status: PRICES.status, get_changes: PRICES.changes, get_model: PRICES.model }[name];
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
  const rows = Object.fromEntries((await env.DB.prepare("SELECT * FROM status").all()).results.map((r) => [r.provider, r]));
  return { code: 200, body: { count: PROVIDERS.length, providers: PROVIDERS.map((p) => { const r = rows[p.id]; return { id: p.id, name: p.name, category: p.category, state: r?.indicator || "unknown", checked_at: r?.checked_at || null, status_page: p.page }; }) } };
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
  if (what === "status") { for (let i = 0; i < 4; i++) await runStatusBatch(c.env, c.executionCtx, i); }
  else if (what === "catalog") await refreshCatalog(c.env);
  else if (what === "drain") return c.json(await drainOutbox(c.env));
  else if (what === "tw") return c.json(await twSnapshot(c.env));
  else if (what === "digest") { const d = await buildDigest(c.env, c.req.query("date") || today()); if (c.req.query("save") === "1") await saveDigest(c.env, d); return c.json(d); }
  else if (what === "tokens") { const pg = PAGES.find((p) => p.id === c.req.query("page")); const r = await fetchT(pg.url, 15000); return c.json((await pageTokens(r)).filter((t) => t.t !== "p" && t.t !== "li").slice(0, 400)); }
  else if (what === "parse") { const pg = PAGES.find((p) => p.id === c.req.query("page")); const r = await fetchT(pg.url, 15000); const m = await parseModels(await pageTokens(r), pg, today()); return c.json(Object.fromEntries(m)); }
  else { const pg = PAGES.find((p) => p.id === what); if (!pg) return c.json({ error: "unknown" }, 400); await runPage(c.env, c.executionCtx, pg); }
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
app.get("/.well-known/mcp", (c) => c.json({ name: "upstream", version: VERSION, transport: "streamable-http", url: new URL(c.req.url).origin + "/mcp", tools: TOOLS.map((t) => t.name) }));
app.get("/llms.txt", (c) => c.text(LLMS(new URL(c.req.url).origin, c.env)));
app.get("/.well-known/x402", (c) => c.json({ version: 1, resources: ["/x402/status/{provider}", "/x402/changes", "/x402/model/{id}"].map((x) => new URL(c.req.url).origin + x) }));
app.get("/openapi.json", (c) => c.json(openapi(new URL(c.req.url).origin, c.env)));
app.get("/health", async (c) => { const r = await c.env.DB.prepare("SELECT MIN(checked_at) oldest, MAX(checked_at) newest, COUNT(*) n FROM status").first();
  const pg = (await c.env.DB.prepare("SELECT id,checked_at,changed_at,error FROM pages").all()).results; const lc = await c.env.DB.prepare("SELECT v FROM meta WHERE k='last_cron'").first(); return c.json({ ok: true, version: VERSION, last_cron: lc?.v || null, network: c.env.X402_NETWORK, status_rows: r, pages: pg }); });
app.get("/", (c) => c.json({ name: "Upstream", what: "Is the AI/dev API your agent depends on up right now, and what's changing (deprecations, model retirements, pricing)?",
  free_tier: { with_free_key: `${c.env.FREE_KEY_DAILY} calls/day (POST /v1/keys)`, anonymous: `${c.env.FREE_ANON_DAILY} calls/day`, watches: "1 free change-alert webhook per key" },
  over_quota: { protocol: "x402 v2", network: c.env.X402_NETWORK, prices_usdc: PRICES }, docs: ["/llms.txt", "/openapi.json", SITE],
  digest: { latest: "/digest/latest", list: "/digest", by_date: "/digest/:date", feed: "/digest/feed.xml", page: SITE + "/digest/" }, endpoints: ["GET /providers", "GET /status/:provider", "GET /changes?since=&provider=&kind=", "GET /model/:id", "POST /v1/keys", "POST /v1/watches", "POST /mcp", "GET /health"] }));

export default {
  fetch: app.fetch,
  async scheduled(ev, env, ctx) {
    await env.DB.prepare("INSERT INTO meta VALUES('last_cron',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(now()).run();
    const m = Math.floor(ev.scheduledTime / 60000);
    await runStatusBatch(env, ctx, m);
    if (m % 5 === 2) await runPage(env, ctx, PAGES[Math.floor(m / 5) % PAGES.length]);
    if (m % 360 === 7) await refreshCatalog(env);
    if (m % 60 === 31) ctx.waitUntil(twSnapshot(env));
    // 12:00 UTC (6:00 AM Mexico City): publish the issue for today's date, covering everything since the previous issue
    const d = new Date(ev.scheduledTime);
    if (d.getUTCHours() === 12 && d.getUTCMinutes() === 3) { await twSnapshot(env); const dg = await buildDigest(env, d.toISOString().slice(0, 10)); await saveDigest(env, dg); if (env.EMAIL_SENDING_ENABLED === "true") await enqueueDigest(env, dg); }
    if (mailReady(env)) ctx.waitUntil(drainOutbox(env));
  },
};
