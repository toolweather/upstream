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
- GET /status/:provider: $0.003
- GET /changes: $0.01
- GET /model/:id: $0.003
- POST /v1/watches (each extra webhook watch, 30 days): $0.05

## Endpoints
- GET ${o}/providers (always free): list of providers and current state
- GET ${o}/status/{provider}: state (operational | degraded | partial_outage | major_outage | maintenance | unknown), incidents, affected components, safe_to_call
- GET ${o}/changes?since=ISO&provider=&kind=status|deprecations|model_retirement|pricing: change feed
- GET ${o}/model/{id}: deprecated_or_retiring | listed_no_retirement_found | unknown, with dates and the source excerpt
- POST ${o}/v1/watches {"provider","url"}: signed webhooks (X-Upstream-Signature: sha256=HMAC(secret, body))
- POST ${o}/mcp: MCP (streamable HTTP) with tools list_providers, get_status, get_changes, get_model. Over quota, a tool returns the x402 requirement; retry with params._meta["x402/payment"].
- OpenAPI: ${o}/openapi.json

## Notes
- Data comes from official public status pages and docs. "unknown" means our check failed, not that the provider is down.
- Responses include a "sponsored" field, reserved and always null for now. No ads.
`;
export const openapi = (o, env) => {
  const pay = { "402": { description: "Free quota used up: x402 v2 payment required (see PAYMENT-REQUIRED header)" } };
  const ok = { "200": { description: "OK" } };
  const sec = [{ apiKey: [] }, {}];
  return { openapi: "3.1.0", info: { title: "Upstream", version: "0.1.0", description: `Live status and breaking-change feed for AI/dev APIs. Free: ${env.FREE_KEY_DAILY} calls/day per key, ${env.FREE_ANON_DAILY}/day anonymous. Over quota: x402 on ${env.X402_NETWORK}.` },
    servers: [{ url: o }], components: { securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "X-API-Key" } } },
    paths: {
      "/providers": { get: { summary: "List tracked providers (free)", responses: ok } },
      "/status/{provider}": { get: { summary: "Current status of one provider", "x-price-usd": 0.003, security: sec, parameters: [{ name: "provider", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok, ...pay } } },
      "/changes": { get: { summary: "Change feed", "x-price-usd": 0.01, security: sec, parameters: ["since", "provider", "kind", "limit"].map((n) => ({ name: n, in: "query", schema: { type: "string" } })), responses: { ...ok, ...pay } } },
      "/model/{id}": { get: { summary: "Model deprecation/retirement lookup", "x-price-usd": 0.003, security: sec, parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { ...ok, ...pay } } },
      "/v1/keys": { post: { summary: "Get a free API key instantly", responses: { "201": { description: "key" } } } },
      "/v1/watches": { post: { summary: "Create change-alert webhook (1 free per key, extra $0.05 / 30 days)", security: [{ apiKey: [] }], requestBody: { content: { "application/json": { schema: { type: "object", properties: { provider: { type: "string" }, url: { type: "string" } }, required: ["provider", "url"] } } } }, responses: { "201": { description: "created" }, ...pay } }, get: { summary: "List your watches", security: [{ apiKey: [] }], responses: ok } },
      "/mcp": { post: { summary: "MCP endpoint (JSON-RPC)", responses: ok } },
    } };
};
