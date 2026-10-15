# Upstream

Live status and breaking-change feed for the AI and developer APIs agents depend on: outages, model deprecations and retirements, pricing-page changes. ~40 providers.

- Site: https://upstream-api.pages.dev
- API: https://upstream.toolweather.workers.dev ([llms.txt](https://upstream.toolweather.workers.dev/llms.txt), [OpenAPI](https://upstream.toolweather.workers.dev/openapi.json))
- MCP: `https://upstream.toolweather.workers.dev/mcp`

## Free tier
500 calls/day with a free key (`POST /v1/keys`), 50/day anonymous, 1 free change-alert webhook. Above that, pay per call with x402 (currently Base Sepolia testnet): `/status/:provider` $0.003, `/model/:id` $0.003, `/changes` $0.01, extra watch $0.05/30 days.

## Stack
Cloudflare Worker (free plan) + D1, Hono, `@x402/hono` with the x402.org facilitator. Pay-to address, network and facilitator are env vars in `wrangler.toml`, so switching to mainnet is a config change.
Cron every minute: a quarter of the providers per run (each provider ~every 4 min), one tracked docs page every 5 min.
