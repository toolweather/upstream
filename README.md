# Upstream

[![Toolweather](https://toolweather.toolweather.workers.dev/badge/io.github.toolweather/upstream.svg)](https://toolweather.pages.dev/servers/io.github.toolweather--upstream/)

Part of the **Toolweather suite**. The same tools are also available on the Toolweather MCP at `https://toolweather.toolweather.workers.dev/mcp` (proxied here). This Worker remains the source of truth for REST, digests and x402 payments.


Live status and breaking-change feed for the AI and developer APIs agents depend on: outages, model deprecations and retirements, pricing-page changes. ~40 providers.

- Site: https://upstream-api.pages.dev
- API: https://upstream.toolweather.workers.dev ([llms.txt](https://upstream.toolweather.workers.dev/llms.txt), [OpenAPI](https://upstream.toolweather.workers.dev/openapi.json))
- MCP: `https://upstream.toolweather.workers.dev/mcp`

## Free tier
500 calls/day with a free key (`POST /v1/keys`), 50/day anonymous, 1 free change-alert webhook. Above that, pay per call with x402 (Base mainnet, real USDC): `/status/:provider` $0.003, `/model/:id` $0.003, `/changes` $0.01, extra watch $0.05/30 days.

## Stack
Cloudflare Worker (free plan) + D1, Hono, `@x402/hono` with the PayAI facilitator (Base mainnet). Pay-to address, network and facilitator are env vars in `wrangler.toml`, so switching to mainnet is a config change.
Cron every 5 minutes: all ~40 providers each run, and one tracked docs page per run (skipped on the 12:00 UTC digest run; a full pass of the docs pages is about 45 min). Doc fetches use `cache: no-store`. Status, model, and catalog rows are written only when the content changed. Doc page text is rewritten only when its hash changes; each read still updates that page's `checked_at` (one row) plus the `probe_clock` meta row. An unchanged provider status does not cost a D1 write.
