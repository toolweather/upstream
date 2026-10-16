// Per-directory source tagging. One aggregated D1 counter per (day, src, tool, outcome); no per-call rows, no PII.
export const SOURCE_TAGS = ["smithery", "glama", "mcpservers", "registry", "awesome", "x", "devto", "hn", "site", "direct"];
const INTERNAL_UA = /toolweather|upstreambot|mcp-health-probe/i;

export const SOURCES_SQL = `CREATE TABLE IF NOT EXISTS source_daily (
  day TEXT NOT NULL,
  src TEXT NOT NULL,
  tool TEXT NOT NULL,
  outcome TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, src, tool, outcome)
);`;

export function normalizeSrc(raw) {
  if (raw == null || raw === "") return "direct";
  const v = String(raw).trim().toLowerCase();
  return SOURCE_TAGS.includes(v) ? v : "other";
}

async function sha256Hex(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function requestKey(req, url) {
  return req.headers.get("x-api-key") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim() || url.searchParams.get("key") || "";
}

async function isInternal(req, url, env) {
  if (INTERNAL_UA.test(req.headers.get("user-agent") || "")) return true;
  const list = String(env.SOURCES_EXCLUDE_KEY_HASHES || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!list.length) return false;
  const k = requestKey(req, url);
  if (!k) return false;
  const h = await sha256Hex(k);
  return list.some((x) => h.startsWith(x));
}

function limitish(s) { return /quota|rate.?limit|limit (reached|exceeded)|payment required|\b402\b|x402|daily_limit|limit_reached/i.test(s); }

function classifyRpc(msg) {
  if (!msg || typeof msg !== "object") return "error";
  if (msg.error) return limitish(JSON.stringify(msg.error)) || msg.error.code === 402 ? "limit" : "error";
  const r = msg.result;
  if (r && r.isError) return limitish(JSON.stringify(r).slice(0, 4000)) ? "limit" : "error";
  return "ok";
}

async function mcpTool(req) {
  try {
    const body = await req.clone().json();
    const msgs = Array.isArray(body) ? body : [body];
    const m = msgs.find((x) => x && x.method === "tools/call");
    if (!m) return null;
    return { tool: String((m.params && m.params.name) || "unknown").slice(0, 64), id: m.id };
  } catch { return null; }
}

async function classifyMcpResponse(res, id) {
  if (res.status === 402 || res.status === 429) return "limit";
  if (res.status >= 400) return "error";
  try {
    const text = await res.clone().text();
    const ct = res.headers.get("content-type") || "";
    let msgs = [];
    if (ct.includes("text/event-stream")) {
      for (const line of text.split("\n")) if (line.startsWith("data:")) { try { msgs.push(JSON.parse(line.slice(5))); } catch {} }
    } else {
      const j = JSON.parse(text); msgs = Array.isArray(j) ? j : [j];
    }
    const m = msgs.find((x) => x && x.id === id) || msgs[0];
    return classifyRpc(m);
  } catch { return "error"; }
}

function classifyRest(res) {
  if (res.status === 402 || res.status === 429) return "limit";
  return res.status >= 200 && res.status < 400 ? "ok" : "error";
}

export async function sourcesSummary(env, days = 7) {
  const since = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare(
    "SELECT day, src, tool, outcome, n FROM source_daily WHERE day >= ? ORDER BY day DESC, src, tool, outcome"
  ).bind(since).all();
  const totals = {};
  for (const r of results || []) {
    const t = (totals[r.src] ||= { ok: 0, error: 0, limit: 0 });
    t[r.outcome] = (t[r.outcome] || 0) + r.n;
  }
  return { since, days, note: "Successful tool calls (ok) are counted separately from errors and limit/402 responses. Internal probes and test keys are excluded. src=direct means no ?src tag.", tags: SOURCE_TAGS, totals, rows: results || [] };
}

// restTools: array of [RegExp on "METHOD /path", toolName]
export function withSources(fetchHandler, restTools = []) {
  return async function (req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/sources" && req.method === "GET") {
      try {
        return new Response(JSON.stringify(await sourcesSummary(env)), { headers: { "content-type": "application/json", "access-control-allow-origin": "*", "cache-control": "max-age=60" } });
      } catch (e) {
        return new Response(JSON.stringify({ error: "sources_unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
      }
    }
    let target = null;
    if (url.pathname === "/mcp" && req.method === "POST") {
      const t = await mcpTool(req);
      if (t) target = { ...t, mcp: true };
    } else {
      const sig = req.method + " " + url.pathname;
      for (const [re, tool] of restTools) if (re.test(sig)) { target = { tool, mcp: false }; break; }
    }
    const res = await fetchHandler(req, env, ctx);
    if (!target || !env.DB) return res;
    const record = (async () => {
      try {
        if (await isInternal(req, url, env)) return;
        const outcome = target.mcp ? await classifyMcpResponse(res, target.id) : classifyRest(res);
        const day = new Date().toISOString().slice(0, 10);
        await env.DB.prepare(
          "INSERT INTO source_daily (day, src, tool, outcome, n) VALUES (?, ?, ?, ?, 1) ON CONFLICT (day, src, tool, outcome) DO UPDATE SET n = n + 1"
        ).bind(day, normalizeSrc(url.searchParams.get("src")), target.tool, outcome).run();
      } catch {}
    })();
    if (ctx && ctx.waitUntil) ctx.waitUntil(record); else await record;
    return res;
  };
}
