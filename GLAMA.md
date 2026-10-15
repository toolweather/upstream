# Glama

Claim file and stdio build so Glama can list and score Upstream (`toolweather/upstream`). The live server stays the Cloudflare Worker at `https://upstream.toolweather.workers.dev/mcp`. This image only exists so Glama can start a process and introspect tools.

## Listing description

Paste this into the Glama admin description after claiming (it is also in `glama.json`):

> Live API status, open incidents, and model deprecations/retirements for ~40 AI/dev providers. Free tier, then x402.

`glama.json` names the GitHub maintainer `toolweather`. The published schema only requires `maintainers`; the directory shows the description you set in the admin UI.

## Admin Dockerfile form

Glama's `…/admin/dockerfile` form does not build the repo `Dockerfile`. It clones this repo into `/app`, runs the build steps, and starts `mcp-proxy -- <CMD>`.

| Field | Value |
| --- | --- |
| Base image | `debian:trixie-slim` (default) |
| Node.js | default (22 is fine) |
| Python | default (unused) |
| Build steps | `[]` |
| CMD arguments | `["node", "glama/stdio.mjs"]` |
| Environment JSON schema | `{"type":"object","properties":{},"required":[]}` |
| Placeholder parameters | `{}` |
| Pinned commit SHA | empty, after Sync Server |

No install step. `glama/stdio.mjs` has no npm dependencies, environment variables, API keys, or wallet keys. Sync Server and leave the pinned SHA empty before Deploy, or the build can use an old commit.

## Local image

```bash
docker build -t upstream-mcp .
docker run -i --rm upstream-mcp
```

Send one JSON-RPC message per line on stdin (`initialize`, then `tools/list`). Responses are one JSON object per line on stdout.

The process exposes the same public tools as production (`check_api_status`, `check_model_deprecation`, `list_recent_api_changes`, `list_providers`, `get_digest`, plus the `get_status` / `get_model` / `get_changes` aliases) with the same titles, descriptions, input schemas, and annotations. Calls return an in-memory sample. It does not take payment or send email, and it does not change Worker pricing.
