export const SITE = "https://upstream-api.pages.dev";
export const LLMS = (o, env) => `# Upstream

> Is the AI or developer API your agent depends on up right now, and what's changing? Upstream watches ~40 providers (OpenAI, Anthropic, Google AI, Mistral, Groq, GitHub, Stripe, Cloudflare, Vercel, Supabase, Twilio...) every few minutes, and tracks model deprecation, retirement and pricing pages for the major LLM providers.

## Free tier (most agents never pay)
- ${env.FREE_KEY_DAILY} calls/day with a free key. Get one instantly: POST ${o}/v1/keys, then send header X-API-Key.
- ${env.FREE_ANON_DAILY} calls/day with no key at all.
- 1 free change-alert webhook per key.
- Every response carries X-Free-Remaining.

## Over the free quota: x402 pay-per-call (USDC)
Network: ${env.X402_NETWORK} (currently Base Sepolia testnet). Unpaid calls over quota get HTTP 402 with a PAYMENT-REQUIRED header (x402 v2); retry with PAYMENT-SIGNATURE.
- Always-paid lane (no quota, same data): /x402/status/{provider}, /x402/changes, /x402/model/{id}
- GET /status/:provider: $0.003
- GET /changes: $0.01
- GET /model/:id: $0.003
- POST /v1/watches (each extra webhook watch, 30 days): $0.05

## Endpoints
- GET ${o}/providers (always free): list of providers and current state
- GET ${o}/status/{provider}: state (operational | degraded | partial_outage | major_outage | maintenance | unknown), incidents, affected components, safe_to_call
- GET ${o}/changes?since=ISO&provider=&kind=status|deprecations|model_retirement|pricing: change feed
- GET ${o}/model/{id}: active | deprecated | retired | unknown, with shutdown date, replacement and the exact table row it came from
- POST ${o}/v1/watches {"provider","url"}: signed webhooks (X-Upstream-Signature: sha256=HMAC(secret, body))
- POST ${o}/mcp: MCP (streamable HTTP) with tools list_providers, get_status, get_changes, get_model. Over quota, a tool returns the x402 requirement; retry with params._meta["x402/payment"].
- OpenAPI: ${o}/openapi.json

## Daily breaking-changes digest (free)
- Page + archive: https://upstream-api.pages.dev/digest/
- JSON: ${o}/digest/latest and ${o}/digest/{YYYY-MM-DD}; list: ${o}/digest
- Atom feed: ${o}/digest/feed.xml
- MCP tool: get_digest {date?}
- Published daily at 12:00 UTC; combines Upstream (AI/dev API incidents, model deprecations/retirements, pricing-page changes) with Toolweather (breaking MCP tool changes, servers down/back, broken OAuth logins).

## Legal
- Terms of Service: https://upstream-api.pages.dev/terms
- Privacy Policy: https://upstream-api.pages.dev/privacy
- Contact: toolweather@mail.grokbot.com (operator: Toolweather, Mexico)

## Notes
- Data comes from official public status pages and docs. "unknown" means our check failed, not that the provider is down.
- Responses include a "sponsored" field, reserved and always null for now. No ads.
`;
export const openapi = (o, env) => {
  const pay = { "402": { description: "Payment Required (x402 v2, see PAYMENT-REQUIRED header)" } };
  const ok = { "200": { description: "OK", content: { "application/json": { schema: { type: "object" } } } } };
  const xpi = (amount) => ({ price: { mode: "fixed", currency: "USD", amount }, protocols: [{ x402: {} }] });
  const free = [{ apiKey: [] }, {}];
  const P = (n, d) => ({ name: n, in: "path", required: true, description: d, schema: { type: "string" } });
  const Q = ["since", "provider", "kind", "limit"].map((n) => ({ name: n, in: "query", required: false, schema: { type: "string" } }));
  const ops = (pre, paid) => ({
    [pre + "/status/{provider}"]: { get: { operationId: (paid ? "paid_" : "") + "getStatus", summary: "Status - is this AI/dev API provider up right now (incidents, affected components)", tags: ["Status"], parameters: [P("provider", "provider id from GET /providers, e.g. openai, anthropic, github, stripe")], ...(paid ? { "x-payment-info": xpi("0.003000") } : { security: free, "x-price-over-free-tier": xpi("0.003000") }), responses: { ...ok, ...pay } } },
    [pre + "/changes"]: { get: { operationId: (paid ? "paid_" : "") + "getChanges", summary: "Changes - feed of outages, deprecations, model retirements and pricing-page edits", tags: ["Changes"], parameters: Q, ...(paid ? { "x-payment-info": xpi("0.010000") } : { security: free, "x-price-over-free-tier": xpi("0.010000") }), responses: { ...ok, ...pay } } },
    [pre + "/model/{id}"]: { get: { operationId: (paid ? "paid_" : "") + "getModel", summary: "Model - is this model active, deprecated or retired; shutdown date and replacement", tags: ["Models"], parameters: [P("id", "model id, e.g. gpt-4o-2024-08-06, claude-3-opus-20240229, gemini-2.0-flash")], ...(paid ? { "x-payment-info": xpi("0.003000") } : { security: free, "x-price-over-free-tier": xpi("0.003000") }), responses: { ...ok, ...pay } } },
  });
  return { openapi: "3.1.0",
    info: { title: "Upstream", version: "0.1.0", contact: { email: "toolweather.app@proton.me" },
      description: `Live status and breaking-change feed for ~40 AI and developer APIs. Free tier: ${env.FREE_KEY_DAILY} calls/day per free key (POST /v1/keys), ${env.FREE_ANON_DAILY}/day anonymous, 1 free webhook watch. Over the free tier: x402 pay-per-call on ${env.X402_NETWORK}.`,
      "x-guidance": "Before calling an AI or developer API (OpenAI, Anthropic, Gemini, GitHub, Stripe...), GET /status/{provider} to see if it is up; GET /model/{id} to check if a model is deprecated or retired and its replacement; GET /changes?since=ISO for what changed. The /x402/* paths are the same data and always paid per call; the plain paths are free within the daily quota and switch to x402 when it is used up." },
    servers: [{ url: o }],
    components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } } },
    paths: {
      "/providers": { get: { operationId: "listProviders", summary: "List tracked providers and current state (free)", security: [], responses: ok } },
      ...ops("", false), ...ops("/x402", true),
      "/v1/keys": { post: { operationId: "createKey", summary: "Get a free API key instantly", security: [], responses: { "201": { description: "key" } } } },
      "/v1/watches": { post: { operationId: "createWatch", summary: "Create change-alert webhook (1 free per key, each extra $0.05 / 30 days)", security: [{ apiKey: [] }], "x-price-over-free-tier": xpi("0.050000"), requestBody: { content: { "application/json": { schema: { type: "object", properties: { provider: { type: "string" }, url: { type: "string" } }, required: ["provider", "url"] } } } }, responses: { "201": { description: "created" }, ...pay } }, get: { operationId: "listWatches", summary: "List your watches", security: [{ apiKey: [] }], responses: ok } },
      "/mcp": { post: { operationId: "mcp", summary: "MCP endpoint (JSON-RPC, streamable HTTP)", security: [], responses: ok } },
    } };
};
