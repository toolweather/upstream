// Daily breaking-changes digest: Upstream (AI/dev APIs) + Toolweather (MCP servers). Real data only.
import { PROVIDERS } from "./providers.js";
const PBY = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));
const iso = () => new Date().toISOString();
const fmtT = (s) => (s ? s.slice(0, 16).replace("T", " ") + " UTC" : "");
const fmtD = (d) => new Date(d + "T12:00:00Z").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
const SITE = "https://upstream-api.pages.dev";

// hourly: diff Toolweather's current server states against our last snapshot -> down / back / auth events
export async function twSnapshot(env) {
  if (!env.TW) return;
  const rows = (await env.TW.prepare("SELECT url,name,status,verdict,json_extract(auth,'$.state') st,json_extract(auth,'$.state_detail') sd FROM servers").all()).results;
  const prev = JSON.parse((await env.DB.prepare("SELECT v FROM meta WHERE k='tw_snapshot'").first())?.v || "null");
  const cur = {}, t = iso(), ev = [];
  for (const r of rows) {
    const up = r.status === "ok" || r.status === "auth_required";
    cur[r.url] = [up ? 1 : 0, r.st || ""];
    const p = prev?.[r.url]; if (!p) continue;
    if (p[0] === 1 && !up) ev.push([r.url, r.name, "down", `status ${r.status}`]);
    if (p[0] === 0 && up) ev.push([r.url, r.name, "back", `status ${r.status}`]);
    if (p[1] !== "auth_broken" && r.st === "auth_broken") ev.push([r.url, r.name, "auth_broken", r.sd || "OAuth login flow broken"]);
    if (p[1] === "auth_broken" && r.st === "auth_ok") ev.push([r.url, r.name, "auth_fixed", r.sd || "OAuth login flow reachable again"]);
  }
  const st = [env.DB.prepare("INSERT INTO meta VALUES('tw_snapshot',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(JSON.stringify(cur)),
    env.DB.prepare("INSERT INTO meta VALUES('tw_snapshot_at',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(t)];
  if (!prev) st.push(env.DB.prepare("INSERT INTO meta VALUES('tw_baseline_at',?) ON CONFLICT(k) DO NOTHING").bind(t));
  for (const e of ev.slice(0, 300)) st.push(env.DB.prepare("INSERT INTO tw_events(url,name,kind,detail,at) VALUES(?,?,?,?,?)").bind(...e, t));
  await env.DB.batch(st);
  return { servers: rows.length, events: ev.length, baseline: !prev };
}

export async function buildDigest(env, date, windowEnd) {
  const prevIssue = await env.DB.prepare("SELECT window_end FROM digests WHERE date<? ORDER BY date DESC LIMIT 1").bind(date).first();
  const end = windowEnd || iso();
  const start = prevIssue?.window_end || new Date(Date.parse(end) - 864e5).toISOString();
  const q = (db, sql, ...a) => db.prepare(sql).bind(...a).all().then((r) => r.results);
  const ch = await q(env.DB, "SELECT * FROM changes WHERE at>=? AND at<? ORDER BY at", start, end);
  const by = (k) => ch.filter((c) => c.kind === k).map((c) => ({ ...c, detail: JSON.parse(c.detail || "null") }));
  const status = by("status"), models = by("model_retirement"), pricing = by("pricing"), deps = by("deprecations");
  const openNow = (await q(env.DB, "SELECT provider,indicator,description,incidents FROM status WHERE indicator NOT IN ('operational','unknown')")).map((r) => ({ ...r, incidents: JSON.parse(r.incidents || "[]") }));
  const in30 = new Date(Date.parse(end) + 30 * 864e5).toISOString().slice(0, 10), today = end.slice(0, 10);
  const soon = (await q(env.DB, "SELECT model,provider,status,dates FROM models WHERE status='deprecated'")).map((r) => ({ ...r, ...JSON.parse(r.dates || "{}") }))
    .filter((r) => r.shutdown_date && r.shutdown_date >= today && r.shutdown_date <= in30).sort((a, b) => a.shutdown_date.localeCompare(b.shutdown_date));
  // Toolweather (timestamps there are +00:00 ISO)
  const twStart = start.replace("Z", "+00:00").replace(/\.\d+/, ""), twEnd = end.replace("Z", "+00:00").replace(/\.\d+/, "");
  const breaking = env.TW ? await q(env.TW, "SELECT name,url,ts,kind,tool,detail FROM changes WHERE severity='breaking' AND ts>=? AND ts<? ORDER BY ts", twStart, twEnd) : [];
  const harmless = env.TW ? (await env.TW.prepare("SELECT COUNT(*) n, COUNT(DISTINCT url) s FROM changes WHERE severity!='breaking' AND ts>=? AND ts<?").bind(twStart, twEnd).first()) : { n: 0, s: 0 };
  const twTotal = env.TW ? (await env.TW.prepare("SELECT COUNT(*) n, SUM(verdict='safe') safe FROM servers").first()) : null;
  const tev = await q(env.DB, "SELECT * FROM tw_events WHERE at>=? AND at<? ORDER BY at", start, end);
  const twEv = (k) => tev.filter((e) => e.kind === k);
  const baselineAt = (await env.DB.prepare("SELECT v FROM meta WHERE k='tw_baseline_at'").first())?.v;
  const upSince = (await env.DB.prepare("SELECT MIN(changed_at) v FROM status").first())?.v;

  const L = [], nm = (id) => PBY[id]?.name || id;
  L.push(`# Breaking changes digest — ${fmtD(date)}`, "", `Covers ${fmtT(start)} to ${fmtT(end)}. Sources: official status pages and docs for ${PROVIDERS.length} AI and developer APIs (Upstream), and ${twTotal?.n?.toLocaleString("en-US") || "~2,000"} MCP servers checked every 15 minutes (Toolweather).`, "");
  const cnt = { status: status.length, models: models.length, pricing: pricing.length, deps: deps.length, breaking: breaking.length, down: twEv("down").length, back: twEv("back").length, auth: twEv("auth_broken").length };
  const quiet = Object.values(cnt).every((n) => n === 0);
  const sumParts = [];
  if (cnt.status) sumParts.push(plural(cnt.status, "provider status change"));
  if (cnt.models) sumParts.push(plural(cnt.models, "model lifecycle change"));
  if (cnt.pricing) sumParts.push(plural(cnt.pricing, "pricing page edit"));
  if (cnt.breaking) sumParts.push(plural(cnt.breaking, "breaking MCP tool change"));
  if (cnt.down) sumParts.push(plural(cnt.down, "MCP server") + " went down");
  if (cnt.auth) sumParts.push(plural(cnt.auth, "MCP login breakage"));
  const summary = quiet ? "A quiet day: no provider status changes, model retirements, pricing edits or breaking MCP changes in this window." : sumParts.join(", ") + ".";
  L.push(`**In short:** ${summary}`, "");

  L.push("## AI and developer APIs", "");
  if (upSince && upSince > start) L.push(`Upstream started tracking provider status at ${fmtT(upSince)}, so this first issue only covers status changes since then.`, "");
  if (status.length) { L.push("Status changes:"); for (const s of status) L.push(`- ${fmtT(s.at)} — **${nm(s.provider)}**: ${s.detail.from.replace("_", " ")} → ${s.detail.to.replace("_", " ")}${s.detail.incidents?.[0] ? ` (${s.detail.incidents[0].name})` : ""}`); L.push(""); }
  else L.push("No status changes in this window.", "");
  if (openNow.length) { L.push(`Not fully operational at ${fmtT(end)}:`); for (const o of openNow) L.push(`- **${nm(o.provider)}** — ${o.indicator.replace("_", " ")}${o.incidents.length ? ": " + o.incidents.slice(0, 2).map((i) => `${i.name}${i.url ? ` (${i.url})` : ""}`).join("; ") : ""}`); L.push(""); }
  else L.push(`All ${PROVIDERS.length} tracked providers were operational at ${fmtT(end)}.`, "");

  L.push("## Model deprecations and retirements", "");
  if (models.length) { for (const m of models.slice(0, 30)) L.push(`- **${m.detail.model}** (${nm(m.provider)}): ${m.detail.from || "newly listed"} → ${m.detail.to}${m.detail.shutdown_date ? `, shutdown ${m.detail.shutdown_date}` : ""}${m.detail.replacement ? `, replacement ${m.detail.replacement}` : ""}. [Source](${m.source})`); L.push(""); }
  else L.push("No new deprecations or retirements on the tracked deprecation pages.", "");
  if (soon.length) {
    L.push(`Shutting down in the next 30 days (${plural(soon.length, "model ID")}):`);
    const g = {}; for (const x of soon) (g[x.shutdown_date + "|" + x.provider] ||= []).push(x);
    for (const [k, xs] of Object.entries(g)) { const [dt, pv] = k.split("|"); const reps = [...new Set(xs.map((x) => x.replacement).filter(Boolean))];
      L.push(`- ${dt} — **${nm(pv)}**: ${xs.slice(0, 12).map((x) => x.model).join(", ")}${xs.length > 12 ? ` and ${xs.length - 12} more` : ""}${reps.length && reps.length <= 3 ? `. Suggested replacement: ${reps.join("; ")}` : ""}`); }
    L.push("");
  }
  if (deps.length) { L.push("Deprecation pages edited:"); for (const d of deps) L.push(`- ${nm(d.provider)}: +${d.detail.added.length} / −${d.detail.removed.length} lines. [Page](${d.source})`); L.push(""); }

  L.push("## Pricing", "");
  if (pricing.length) { for (const p of pricing) { L.push(`- **${nm(p.provider)}** pricing page changed (+${p.detail.added.length} / −${p.detail.removed.length} lines). [Page](${p.source})`); for (const a of p.detail.added.slice(0, 3)) L.push(`  - added: “${a.slice(0, 160)}”`); } L.push(""); }
  else L.push("No changes on the tracked pricing pages (OpenAI, Anthropic, Google).", "");

  L.push("## MCP servers", "");
  if (breaking.length) { L.push("Breaking tool changes:"); for (const b of breaking.slice(0, 30)) L.push(`- ${fmtT(b.ts.replace("+00:00", "Z"))} — **${b.name}**: ${b.kind.replace(/_/g, " ")}${b.tool ? ` \`${b.tool}\`` : ""}${b.detail ? ` (${b.detail})` : ""}`); L.push(""); }
  else L.push("No breaking tool changes.", "");
  if (harmless.n) L.push(`Plus ${plural(harmless.n, "non-breaking change")} across ${plural(harmless.s, "server")} (descriptions, optional parameters, output schemas).`, "");
  const evLines = (k, label) => { const e = twEv(k); if (e.length) { L.push(`${label}:`); for (const x of e.slice(0, 20)) L.push(`- ${fmtT(x.at)} — **${x.name}**${x.kind === "auth_broken" ? `: ${x.detail}` : ""}`); if (e.length > 20) L.push(`- …and ${e.length - 20} more`); L.push(""); } };
  evLines("down", "Went down"); evLines("back", "Came back"); evLines("auth_broken", "Login (OAuth) flow broke"); evLines("auth_fixed", "Login flow fixed");
  if (!baselineAt || baselineAt > start) L.push(`Up/down and login tracking started ${fmtT(baselineAt || end)}, so this issue only covers part of the window for those.`, "");
  else if (!cnt.down && !cnt.back && !cnt.auth) L.push("No servers went down, came back, or broke their login flow.", "");

  L.push("---", "", `Data notes: Upstream status tracking began ${fmtT(upSince)}. "Status change" means the provider's own status page changed state. Model dates come from each provider's deprecation page. Live data: ${SITE} · JSON: /digest/${date}`);
  const data = { counts: cnt, quiet, status, open_now: openNow, model_changes: models, shutting_down_30d: soon, pricing, deprecation_page_edits: deps, mcp: { breaking, non_breaking: harmless, down: twEv("down"), back: twEv("back"), auth_broken: twEv("auth_broken"), auth_fixed: twEv("auth_fixed") } };
  return { date, window_start: start, window_end: end, title: `Breaking changes digest — ${fmtD(date)}`, summary, markdown: L.join("\n"), data };
}
export async function saveDigest(env, d) {
  await env.DB.prepare("INSERT INTO digests VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(date) DO UPDATE SET window_start=excluded.window_start,window_end=excluded.window_end,title=excluded.title,summary=excluded.summary,markdown=excluded.markdown,data=excluded.data,created_at=excluded.created_at")
    .bind(d.date, d.window_start, d.window_end, d.title, d.summary, d.markdown, JSON.stringify(d.data), iso()).run();
}
export const digestOut = (r) => r && { date: r.date, title: r.title, summary: r.summary, window_start: r.window_start, window_end: r.window_end, published_at: r.created_at, markdown: r.markdown, data: JSON.parse(r.data), url: `${SITE}/digest/?d=${r.date}`, sponsor: null };

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export function atom(rows, origin) {
  const items = rows.map((r) => `<entry><title>${esc(r.title)}</title><id>tag:upstream-api.pages.dev,2026:digest:${r.date}</id><link href="${SITE}/digest/?d=${r.date}"/><updated>${r.created_at}</updated><summary>${esc(r.summary)}</summary><content type="text">${esc(r.markdown)}</content></entry>`).join("");
  return `<?xml version="1.0" encoding="utf-8"?><feed xmlns="http://www.w3.org/2005/Atom"><title>Upstream breaking-changes digest</title><subtitle>Daily: AI/dev API incidents, model retirements, pricing changes, breaking MCP server changes.</subtitle><id>tag:upstream-api.pages.dev,2026:digest</id><link rel="self" href="${origin}/digest/feed.xml"/><link href="${SITE}/digest/"/><updated>${rows[0]?.created_at || iso()}</updated><author><name>Upstream</name></author>${items}</feed>`;
}

// ---- subscriptions: double opt-in plumbing, sending disabled ----
export async function subscribe(env, email, ipHash, sha, origin) {
  email = String(email || "").trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(email)) return { code: 400, body: { error: "invalid_email" } };
  const d = iso().slice(0, 10);
  const n = await env.DB.prepare("SELECT COUNT(*) n FROM subscribers WHERE ip_hash=? AND created_at>=?").bind(ipHash, d).first();
  if (n.n >= 5) return { code: 429, body: { error: "rate_limited" } };
  const ex = await env.DB.prepare("SELECT status FROM subscribers WHERE email=?").bind(email).first();
  const tok = () => [...crypto.getRandomValues(new Uint8Array(20))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const ct = tok(), ut = tok();
  if (!ex || ex.status === "unsubscribed") await env.DB.prepare("INSERT INTO subscribers(email,status,confirm_hash,unsub_hash,ip_hash,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET status='pending',confirm_hash=excluded.confirm_hash,unsub_hash=excluded.unsub_hash,created_at=excluded.created_at,unsubscribed_at=NULL")
    .bind(email, "pending", await sha(ct), await sha(ut), ipHash, iso()).run();
  if (!ex || ex.status === "unsubscribed") {
    // Queue the confirmation email. Nothing is sent while EMAIL_SENDING_ENABLED != "true" (needs Alberto's approval + a mail provider).
    await env.DB.prepare("INSERT INTO email_outbox(email,kind,subject,body,created_at,state) VALUES(?,?,?,?,?,?)").bind(email, "confirm", "Confirm your Upstream digest subscription",
      `Confirm: ${origin}/digest/confirm?token=${ct}\nIf you didn't ask for this, ignore this email.\nUnsubscribe: ${origin}/digest/unsubscribe?token=${ut}`, iso(), env.EMAIL_SENDING_ENABLED === "true" ? "queued" : "held_sending_disabled").run();
  }
  return { code: 200, body: { ok: true, status: ex?.status === "confirmed" ? "already_confirmed" : "pending_confirmation",
    message: "Thanks, your address is saved. Email delivery isn't switched on yet. When it is, we'll send one confirmation email, and nothing else unless you confirm. Until then, read the digest on the site or via RSS." } };
}
export async function confirmOrUnsub(env, kind, token, sha) {
  if (!/^[0-9a-f]{40}$/.test(token || "")) return false;
  const h = await sha(token);
  const r = kind === "confirm"
    ? await env.DB.prepare("UPDATE subscribers SET status='confirmed',confirmed_at=? WHERE confirm_hash=? AND status='pending' RETURNING email").bind(iso(), h).first()
    : await env.DB.prepare("UPDATE subscribers SET status='unsubscribed',unsubscribed_at=? WHERE unsub_hash=? RETURNING email").bind(iso(), h).first();
  return !!r;
}
