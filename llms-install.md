# Installing Upstream (remote MCP server, nothing to run locally)

Upstream is a hosted MCP server. No package, build or API key is required.

Add this to your MCP settings (e.g. Cline `cline_mcp_settings.json`):

```json
{
  "mcpServers": {
    "upstream": {
      "type": "streamableHttp",
      "url": "https://upstream.toolweather.workers.dev/mcp"
    }
  }
}
```

Optional: for 500 free calls/day instead of 50, get a free key with `curl -X POST https://upstream.toolweather.workers.dev/v1/keys` and add `"headers": {"X-API-Key": "<key>"}`.

Verify: call `check_api_status` with `{"provider":"openai"}`. The result starts with a one-line `summary`.

Tools: `check_api_status` (is this API down?), `check_model_deprecation` (is this model deprecated, what replaces it?), `list_recent_api_changes`, `list_providers`, `get_digest`.
