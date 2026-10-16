import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownTokens, textFromTokens, parseModels } from "./models.js";

const md = `# Deprecations

## Upcoming deprecations

### 2026-10-14: GPT-4 series model deprecations

On October 14, 2026, we notified developers that these models leave the API on January 14, 2027.

| Shutdown date | Model / system | Recommended replacement |
| --- | --- | --- |
| January 14, 2027 | GPT-4o (\`gpt-4o-2024-08-06\`, \`gpt-4o-2024-11-20\`) | \`gpt-6-luna\` |
| October 23, 2026 | \`gpt-4-0613\` | \`gpt-4\`, \`gpt-4-0613-completions\` | \`gpt-5.6-sol\` |
`;

test("markdown deprecation table parses shutdown, status, and replacement", () => {
  const tok = markdownTokens(md);
  assert.ok(tok.some((t) => t.t === "table"));
  const text = textFromTokens(tok);
  assert.match(text, /gpt-4o-2024-08-06/);
  const live = parseModels(tok, { id: "openai-deprecations", url: "https://developers.openai.com/api/docs/deprecations" }, "2026-10-16");
  const gpt4o = live.get("gpt-4o-2024-08-06");
  assert.equal(gpt4o.status, "deprecated");
  assert.equal(gpt4o.shutdown_date, "2027-01-14");
  assert.equal(gpt4o.replacement, "gpt-6-luna");
  assert.equal(live.get("gpt-4o-2024-11-20").status, "deprecated");
  const past = parseModels(tok, { id: "openai-deprecations" }, "2026-10-24");
  assert.equal(past.get("gpt-4-0613").status, "retired");
  assert.equal(past.get("gpt-4-0613").shutdown_date, "2026-10-23");
  assert.equal(past.get("gpt-4-0613").replacement, "gpt-5.6-sol");
  assert.equal(past.get("gpt-4").replacement, "gpt-5.6-sol");
});
