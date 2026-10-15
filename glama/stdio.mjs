#!/usr/bin/env node
/**
 * Stdio MCP for Glama introspection.
 * Tool names, titles, descriptions, input schemas, and annotations are the
 * production public tools (glama/tools.json). Calls return an in-memory
 * sample: no live checks, no x402 payment, no email.
 */
import { readFileSync } from "node:fs";
import readline from "node:readline";

const VERSION = "0.2.0";
const TOOLS = JSON.parse(readFileSync(new URL("./tools.json", import.meta.url), "utf8"));
const ALIAS = { get_status: "check_api_status", get_model: "check_model_deprecation", get_changes: "list_recent_api_changes" };
const INSTRUCTIONS = "Use check_api_status before calling an AI/dev API or after 5xx/timeouts; check_model_deprecation before using a model id; list_recent_api_changes to explain sudden breakage. Every result starts with a one-line summary. The hosted server (https://upstream.toolweather.workers.dev/mcp) is free within the daily quota (500/day with a free key, 50/day without), then x402. This stdio process returns a sample snapshot for introspection and does not take payment or send email.";
const SAMPLE_NOTE = "sample snapshot for introspection; not a live check";
const SERVER_INFO = { name: "upstream", title: "Upstream", version: VERSION };

const BOOTED = Date.now();
const iso = (msAgo = 0) => new Date(BOOTED - msAgo).toISOString();
const CHECKED = iso(120_000);
const SINCE_CHANGE = iso(2 * 3600_000);
const SEEN = iso(3 * 3600_000);

// id, name, category, type, status page. Same providers as src/providers.js.
const PROVIDERS = [
  ["openai", "OpenAI", "ai", "sp", "https://status.openai.com"],
  ["anthropic", "Anthropic (Claude)", "ai", "sp", "https://status.claude.com"],
  ["google-ai", "Google AI (Gemini / Vertex AI)", "ai", "gcp", "https://status.cloud.google.com"],
  ["mistral", "Mistral AI", "ai", "http", "https://status.mistral.ai"],
  ["groq", "Groq", "ai", "sp", "https://groqstatus.com"],
  ["cohere", "Cohere", "ai", "sp", "https://status.cohere.com"],
  ["perplexity", "Perplexity", "ai", "sp", "https://status.perplexity.com"],
  ["fireworks", "Fireworks AI", "ai", "sp", "https://status.fireworks.ai"],
  ["together", "Together AI", "ai", "http", "https://status.together.ai"],
  ["openrouter", "OpenRouter", "ai", "http", "https://status.openrouter.ai"],
  ["deepseek", "DeepSeek", "ai", "http", "https://status.deepseek.com"],
  ["xai", "xAI", "ai", "http", "https://status.x.ai"],
  ["huggingface", "Hugging Face", "ai", "http", "https://status.huggingface.co"],
  ["replicate", "Replicate", "ai", "http", "https://replicate.com"],
  ["elevenlabs", "ElevenLabs", "ai", "sp", "https://status.elevenlabs.io"],
  ["pinecone", "Pinecone", "ai", "sp", "https://status.pinecone.io"],
  ["github", "GitHub", "dev", "sp", "https://www.githubstatus.com"],
  ["npm", "npm", "dev", "sp", "https://status.npmjs.org"],
  ["docker", "Docker Hub", "dev", "sp", "https://www.dockerstatus.com"],
  ["atlassian", "Atlassian (Jira/Confluence/Bitbucket)", "dev", "sp", "https://status.atlassian.com"],
  ["linear", "Linear", "dev", "sp", "https://linearstatus.com"],
  ["sentry", "Sentry", "dev", "sp", "https://status.sentry.io"],
  ["datadog", "Datadog", "dev", "sp", "https://status.datadoghq.com"],
  ["stripe", "Stripe", "payments", "http", "https://status.stripe.com"],
  ["shopify", "Shopify", "payments", "sp", "https://www.shopifystatus.com"],
  ["cloudflare", "Cloudflare", "infra", "sp", "https://www.cloudflarestatus.com"],
  ["vercel", "Vercel", "infra", "sp", "https://www.vercel-status.com"],
  ["netlify", "Netlify", "infra", "sp", "https://www.netlifystatus.com"],
  ["digitalocean", "DigitalOcean", "infra", "sp", "https://status.digitalocean.com"],
  ["render", "Render", "infra", "sp", "https://status.render.com"],
  ["fly", "Fly.io", "infra", "sp", "https://status.flyio.net"],
  ["supabase", "Supabase", "data", "sp", "https://status.supabase.com"],
  ["planetscale", "PlanetScale", "data", "sp", "https://www.planetscalestatus.com"],
  ["mongodb", "MongoDB Atlas", "data", "sp", "https://status.mongodb.com"],
  ["upstash", "Upstash", "data", "sp", "https://status.upstash.com"],
  ["clerk", "Clerk", "auth", "sp", "https://status.clerk.com"],
  ["twilio", "Twilio (incl. SendGrid)", "comms", "sp", "https://status.twilio.com"],
  ["resend", "Resend", "comms", "sp", "https://resend-status.com"],
  ["discord", "Discord", "comms", "sp", "https://discordstatus.com"],
  ["zoom", "Zoom", "comms", "sp", "https://www.zoomstatus.com"],
].map(([id, name, category, type, page]) => ({ id, name, category, type, page }));
const PBY = Object.fromEntries(PROVIDERS.map((p) => [p.id, p]));

const PAGES = {
  openai: [
    { kind: "deprecations", url: "https://developers.openai.com/api/docs/deprecations" },
    { kind: "pricing", url: "https://developers.openai.com/api/docs/pricing" },
  ],
  anthropic: [
    { kind: "deprecations", url: "https://platform.claude.com/docs/en/about-claude/model-deprecations" },
    { kind: "pricing", url: "https://platform.claude.com/docs/en/about-claude/pricing" },
  ],
  "google-ai": [
    { kind: "deprecations", url: "https://ai.google.dev/gemini-api/docs/deprecations" },
    { kind: "pricing", url: "https://ai.google.dev/gemini-api/docs/pricing" },
  ],
  mistral: [{ kind: "deprecations", url: "https://docs.mistral.ai/models" }],
  groq: [{ kind: "deprecations", url: "https://console.groq.com/docs/deprecations" }],
  cohere: [{ kind: "deprecations", url: "https://docs.cohere.com/docs/deprecations" }],
};

const SAMPLE_STATUS = {
  anthropic: {
    indicator: "degraded",
    description: "Elevated error rate on the Messages API",
    incidents: [{ name: "Elevated errors on Messages API", status: "investigating", impact: "minor", updated_at: SINCE_CHANGE, url: "https://status.claude.com" }],
    components: [{ name: "Claude API", status: "degraded_performance" }],
  },
  stripe: {
    indicator: "partial_outage",
    description: "Some API requests failing",
    incidents: [{ name: "Intermittent API errors", status: "monitoring", impact: "major", updated_at: SINCE_CHANGE, url: "https://status.stripe.com" }],
    components: [{ name: "API", status: "partial_outage" }],
  },
  zoom: {
    indicator: "maintenance",
    description: "Scheduled maintenance in progress",
    incidents: [{ name: "Scheduled maintenance", status: "maintenance", impact: "minor", updated_at: SINCE_CHANGE, url: "https://www.zoomstatus.com" }],
    components: [],
  },
};

const SOURCE = {
  sp: "official status page",
  gcp: "Google Cloud status incidents + API reachability",
  http: "API reachability probe (no machine-readable status page)",
};
const ACTION = {
  operational: "Safe to call.",
  maintenance: "Safe to call; scheduled maintenance in progress, expect brief errors.",
  degraded: "Call with retries and backoff; have a fallback provider ready.",
  partial_outage: "Expect failures; retry with backoff or route to a fallback provider.",
  major_outage: "Do not rely on it now; route to a fallback provider.",
  unknown: "Status unknown (our check failed, not necessarily the provider); proceed with retries.",
};
const VERDICT = { operational: "up", maintenance: "up", degraded: "degraded", partial_outage: "partially down", major_outage: "down", unknown: "unknown" };

function statusRow(p) {
  const s = SAMPLE_STATUS[p.id];
  if (s) return { ...s, changed_at: SINCE_CHANGE };
  const description = p.type === "gcp" ? "No open Google AI incidents; Gemini API reachable" : p.type === "http" ? "API reachable (HTTP 200, 180 ms)" : "All Systems Operational";
  return { indicator: "operational", description, incidents: [], components: [], changed_at: CHECKED };
}

const CHANGES = [
  { id: 4, provider: "anthropic", kind: "status", title: "Anthropic (Claude): operational → degraded", detail: { from: "operational", to: "degraded", summary: "Elevated error rate on the Messages API", incidents: SAMPLE_STATUS.anthropic.incidents.slice(0, 5) }, source: "https://status.claude.com", at: iso(30 * 60_000) },
  { id: 3, provider: "openai", kind: "model_retirement", title: "gpt-4-0613 (OpenAI): deprecated → retired, shutdown 2024-06-13", detail: { model: "gpt-4-0613", from: "deprecated", to: "retired", shutdown_date: "2024-06-13", replacement: "gpt-4o", evidence: "gpt-4-0613 retired" }, source: "https://developers.openai.com/api/docs/deprecations", at: iso(26 * 3600_000) },
  { id: 2, provider: "openai", kind: "deprecations", title: "OpenAI deprecations page changed (+1 / -1 lines)", detail: { added: ["gpt-4-0613 retired"], removed: ["gpt-4-0613 deprecated"] }, source: "https://developers.openai.com/api/docs/deprecations", at: iso(26 * 3600_000) },
  { id: 1, provider: "anthropic", kind: "pricing", title: "Anthropic (Claude) pricing page changed (+1 / -0 lines)", detail: { added: ["sample pricing line"], removed: [] }, source: "https://platform.claude.com/docs/en/about-claude/pricing", at: iso(50 * 3600_000) },
];

const MODELS = [
  { model: "gpt-4o", provider: "openai", status: "active", dates: {}, snippet: "gpt-4o — active, no shutdown date", source: "https://developers.openai.com/api/docs/deprecations", seen_at: SEEN, openrouter: ["openai/gpt-4o"] },
  { model: "gpt-4-0613", provider: "openai", status: "retired", dates: { shutdown_date: "2024-06-13", replacement: "gpt-4o" }, snippet: "gpt-4-0613 retired 2024-06-13; replacement gpt-4o", source: "https://developers.openai.com/api/docs/deprecations", seen_at: SEEN },
  { model: "claude-3-opus-20240229", provider: "anthropic", status: "deprecated", dates: { shutdown_date: "2026-11-15", deprecated_on: "2025-11-15", replacement: "claude-opus-4-1" }, snippet: "claude-3-opus-20240229 deprecated, shutdown 2026-11-15", source: "https://platform.claude.com/docs/en/about-claude/model-deprecations", seen_at: SEEN },
  { model: "gemini-1.5-pro", provider: "google-ai", status: "deprecated", dates: { shutdown_date: "2026-11-01", replacement: "gemini-2.5-pro" }, snippet: "gemini-1.5-pro deprecated, shutdown 2026-11-01", source: "https://ai.google.dev/gemini-api/docs/deprecations", seen_at: SEEN },
];

const norm = (s) => String(s).toLowerCase().replace(/^models\//, "").trim();

function getStatus(id) {
  const p = PBY[id];
  if (!p) return { code: 404, body: { error: "unknown_provider", hint: "GET /providers for the list" } };
  const r = statusRow(p);
  const age = 120;
  const o = {
    provider: p.id, name: p.name, category: p.category, state: r.indicator, summary: r.description,
    incidents: r.incidents, affected_components: r.components, source: SOURCE[p.type], status_page: p.page,
    checked_at: CHECKED, age_seconds: age, state_since: r.changed_at,
    safe_to_call: ["operational", "maintenance"].includes(r.indicator) ? true : r.indicator === "major_outage" ? false : r.indicator === "unknown" ? null : "with_retries",
    sponsored: null,
  };
  const fr = { age_seconds: age, fresh: true, note: SAMPLE_NOTE };
  const act = ACTION[o.state] || "Proceed with care.";
  const verdict = VERDICT[o.state] || o.state;
  const line = `Sample snapshot: ${p.name} is ${verdict}${o.summary ? " (" + o.summary + ")" : ""}${o.state_since ? " since " + o.state_since : ""}. ${act}`;
  const recent = CHANGES.filter((c) => c.provider === id).slice(0, 5).map(({ kind, title, at }) => ({ kind, title, at }));
  return { code: 200, body: { summary: line, verdict, recommended_action: act, freshness: fr, ...o, summary: line, provider_description: o.summary, tracked_pages: PAGES[id] || [], recent_changes: recent } };
}

function getChanges(q) {
  const since = q.since || iso(7 * 864e5);
  let rs = CHANGES.filter((c) => c.at > since);
  if (q.provider) rs = rs.filter((c) => c.provider === q.provider);
  if (q.kind) rs = rs.filter((c) => c.kind === q.kind);
  rs = rs.slice(0, Math.min(+q.limit || 100, 500));
  const byKind = rs.reduce((m, r) => (m[r.kind] = (m[r.kind] || 0) + 1, m), {});
  const summ = rs.length
    ? `Sample snapshot: ${rs.length} change(s) since ${since}${q.provider ? " for " + q.provider : ""}: ` + Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ") + `. Latest: ${rs[0].title}.`
    : `Sample snapshot: no changes since ${since}${q.provider ? " for " + q.provider : ""}. Nothing to act on.`;
  return { code: 200, body: { summary: summ, checked_at: iso(), freshness: { data_as_of: rs[0]?.at || null, note: SAMPLE_NOTE }, since, count: rs.length, kinds: ["status", "deprecations", "model_retirement", "pricing"], changes: rs } };
}

function getModel(id) {
  const m = norm(id);
  if (!m || m.length > 120) return { code: 400, body: { error: "bad_model_id" } };
  const rows = MODELS.filter((r) => r.model === m);
  const needle = m.replace(/[%_]/g, "");
  const sugg = rows.length ? [] : MODELS.filter((r) => r.model.includes(needle)).slice(0, 8).map((r) => ({ model: r.model, provider: r.provider, status: r.status }));
  const order = { retired: 3, deprecated: 2, active: 1 };
  const best = rows.slice().sort((a, b) => (order[b.status] || 0) - (order[a.status] || 0))[0];
  const info = best?.dates || {};
  const st = best ? best.status : "unknown";
  const rep = info.replacement || null;
  const summary = st === "retired" ? `Sample snapshot: ${m} is RETIRED${info.shutdown_date ? " (shut down " + info.shutdown_date + ")" : ""}. Switch to ${rep || "a current model from the same provider"} now.`
    : st === "deprecated" ? `Sample snapshot: ${m} is DEPRECATED${info.shutdown_date ? ", shutdown " + info.shutdown_date : ""}. Plan migration to ${rep || "a current model from the same provider"}.`
    : st === "active" ? `Sample snapshot: ${m} is active with no announced shutdown. Safe to keep using.`
    : `Sample snapshot: ${m} is not listed on any tracked deprecation page. Probably fine, but not confirmed${sugg.length ? "; see did_you_mean" : ""}.`;
  const seen = best?.seen_at || null;
  const orIds = best?.openrouter;
  return { code: 200, body: {
    summary, verdict: st,
    recommended_action: st === "retired" ? "switch_now" : st === "deprecated" ? "plan_migration" : st === "active" ? "keep_using" : "verify_with_provider",
    checked_at: iso(), freshness: { data_as_of: seen, age_seconds: seen ? Math.round((BOOTED - Date.parse(seen)) / 1000) : null, note: SAMPLE_NOTE },
    model: m, status: st, shutdown_date: info.shutdown_date || null, deprecated_on: info.deprecated_on || null, replacement: info.replacement || null,
    evidence: rows.map((r) => ({ provider: r.provider, status: r.status, ...r.dates, row: r.snippet, source: r.source, seen_at: r.seen_at })),
    did_you_mean: sugg.length ? sugg : undefined, on_openrouter: orIds?.length ? orIds : undefined,
    states: "active = the provider's page explicitly lists it as active or with no shutdown date; deprecated = explicitly deprecated, shutdown in the future; retired = shutdown date has passed; unknown = not explicitly listed on any tracked deprecation page (not a guarantee it is live).",
    sponsored: null,
  } };
}

function listProviders() {
  return { code: 200, body: {
    count: PROVIDERS.length,
    note: SAMPLE_NOTE,
    providers: PROVIDERS.map((p) => {
      const r = statusRow(p);
      return { id: p.id, name: p.name, category: p.category, state: r.indicator, checked_at: CHECKED, status_page: p.page };
    }),
  } };
}

function digestIssue(date) {
  const end = iso();
  const start = iso(864e5);
  const summary = "Sample snapshot: 1 provider status change, 1 model lifecycle change. Not a live digest.";
  const title = `Breaking changes digest — ${date}`;
  return {
    date, title, summary, window_start: start, window_end: end, published_at: end,
    markdown: `# ${title}\n\n${summary}\n`,
    data: { counts: { status: 1, models: 1, pricing: 1, deps: 1, breaking: 0, down: 0, back: 0, auth: 0 }, quiet: false, note: SAMPLE_NOTE },
    url: `https://upstream-api.pages.dev/digest/?d=${date}`,
    sponsor: null,
  };
}

function getDigest(date) {
  const today = iso().slice(0, 10);
  if (!date) return { code: 200, body: digestIssue(today) };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { code: 404, body: { error: "no_issue", hint: "issues are published daily at 12:00 UTC" } };
  const day = Date.parse(date + "T00:00:00Z");
  const startToday = Date.parse(today + "T00:00:00Z");
  if (Number.isNaN(day) || day > startToday || startToday - day > 14 * 864e5) return { code: 404, body: { error: "no_issue", hint: "issues are published daily at 12:00 UTC" } };
  return { code: 200, body: digestIssue(date) };
}

function callTool(name, args) {
  const a = args || {};
  if (name === "list_providers") return listProviders();
  if (name === "check_api_status") return getStatus(a.provider);
  if (name === "list_recent_api_changes") return getChanges(a);
  if (name === "check_model_deprecation") return getModel(a.model || a.id);
  if (name === "get_digest") return getDigest(a.date);
  return null;
}

function modern(params) {
  return params?._meta?.["io.modelcontextprotocol/protocolVersion"] === "2026-07-28";
}

function write(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handle(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};
  if (id === undefined || id === null) return null;
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const isModern = modern(params);
  if (method === "initialize") {
    const requested = params.protocolVersion;
    const protocolVersion = typeof requested === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : "2025-06-18";
    return ok({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
  }
  if (method === "server/discover") {
    return ok({
      resultType: "complete",
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "upstream", version: VERSION } },
      instructions: INSTRUCTIONS,
      ttlMs: 3600000,
      cacheScope: "public",
    });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") {
    const result = { tools: TOOLS };
    if (isModern) Object.assign(result, { resultType: "complete", ttlMs: 300000, cacheScope: "public" });
    return ok(result);
  }
  if (method === "resources/list" || method === "resources/templates/list" || method === "prompts/list") {
    const key = method === "prompts/list" ? "prompts" : method === "resources/templates/list" ? "resourceTemplates" : "resources";
    const result = { [key]: [] };
    if (isModern) Object.assign(result, { resultType: "complete", ttlMs: 300000, cacheScope: "public" });
    return ok(result);
  }
  if (method !== "tools/call") return err(-32601, "method not found");
  const name = ALIAS[params.name] || params.name;
  const ran = callTool(name, params.arguments);
  if (!ran) return err(-32602, "unknown tool");
  const result = { content: [{ type: "text", text: JSON.stringify(ran.body) }], structuredContent: ran.body, isError: ran.code >= 400 };
  if (isModern) result.resultType = "complete";
  return ok(result);
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try { msg = JSON.parse(s); } catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); return; }
  try {
    const out = handle(msg);
    if (out) write(out);
  } catch (e) {
    process.stderr.write(String(e?.stack || e) + "\n");
    if (msg && msg.id !== undefined && msg.id !== null) write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "internal error" } });
  }
});
rl.on("close", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
