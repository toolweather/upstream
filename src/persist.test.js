import { test } from "node:test";
import assert from "node:assert/strict";
import { PAGES } from "./providers.js";
import {
  CRON_MS, cronPlan, planStatusWrites, statusWriteNeeded, pageWriteNeeded, pageErrorWriteNeeded,
  modelWriteNeeded, metaWriteNeeded, laterIso, parseProbe, mergePageProbe, modelSeenAt, pageIdForSource, snapshotUnchanged,
} from "./persist.js";

const t = "2026-10-15T12:00:00.000Z";
const prov = { id: "openai", name: "OpenAI", page: "https://status.openai.com" };
const same = {
  indicator: "operational", description: "All Systems Operational",
  incidents: [{ name: "API", status: "monitoring", impact: "minor" }],
  components: [{ name: "API", status: "degraded" }], error: null,
};

test("unchanged status produces no row write and no change event", () => {
  const old = { ...same, incidents: JSON.stringify(same.incidents), components: JSON.stringify([{ status: "degraded", name: "API" }]), checked_at: "2026-10-15T11:00:00.000Z", changed_at: "2026-10-01T00:00:00.000Z" };
  const { writes, events } = planStatusWrites({ openai: old }, [[prov, same]], t);
  assert.equal(writes.length, 0);
  assert.equal(events.length, 0);
});

test("latency-only reachability text is not a status write", () => {
  const old = { indicator: "operational", description: "API reachable (HTTP 200, 120 ms)", incidents: "[]", components: "[]", error: null, changed_at: "2026-10-01T00:00:00.000Z" };
  const next = { indicator: "operational", description: "API reachable (HTTP 200, 980 ms)", incidents: [], components: [] };
  assert.equal(statusWriteNeeded(old, next), false);
  assert.equal(planStatusWrites({ openai: old }, [[prov, next]], t).writes.length, 0);
});

test("HTTP status code change is a write, indicator change emits one event", () => {
  const old = { indicator: "operational", description: "API reachable (HTTP 200, 120 ms)", incidents: "[]", components: "[]", error: null, changed_at: "2026-10-01T00:00:00.000Z" };
  const next = { indicator: "partial_outage", description: "API not reachable (HTTP 503)", incidents: [], components: [] };
  const plan = planStatusWrites({ openai: old }, [[prov, next]], t);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].changed_at, t);
  assert.equal(plan.events.length, 1);
  assert.equal(plan.events[0].title, "OpenAI: operational → partial_outage");
});

test("incident text change writes the row without a state-change event", () => {
  const old = { indicator: "degraded", description: "Partial outage", incidents: "[]", components: "[]", error: null, changed_at: "2026-10-01T00:00:00.000Z" };
  const next = { indicator: "degraded", description: "Partial outage", incidents: [{ name: "Chat", status: "investigating", impact: "minor" }], components: [] };
  const plan = planStatusWrites({ openai: old }, [[prov, next]], t);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].changed_at, old.changed_at);
  assert.equal(plan.events.length, 0);
});

test("unknown is stored but does not emit a status change", () => {
  const old = { indicator: "operational", description: "All Systems Operational", incidents: "[]", components: "[]", error: null, changed_at: "2026-10-01T00:00:00.000Z" };
  const next = { indicator: "unknown", description: "status source unreachable", incidents: [], components: [], error: "AbortError" };
  const plan = planStatusWrites({ openai: old }, [[prov, next]], t);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.events.length, 0);
  const back = planStatusWrites({ openai: { ...old, indicator: "unknown", error: "AbortError" } }, [[prov, { indicator: "operational", description: "All Systems Operational", incidents: [], components: [] }]], t);
  assert.equal(back.events.length, 0);
  assert.equal(back.writes.length, 1);
});

test("missing status row is inserted", () => {
  const plan = planStatusWrites({}, [[prov, same]], t);
  assert.equal(plan.writes.length, 1);
  assert.equal(plan.writes[0].changed_at, t);
  assert.equal(plan.events.length, 0);
});

test("page and model rows are skipped when content matches", () => {
  assert.equal(pageWriteNeeded({ hash: "abc", error: null }, "abc"), false);
  assert.equal(pageWriteNeeded({ hash: "abc", error: null }, "def"), true);
  assert.equal(pageWriteNeeded({ hash: "abc", error: "HTTP 500" }, "abc"), true);
  assert.equal(pageWriteNeeded(null, "abc"), true);
  assert.equal(pageErrorWriteNeeded({ error: "HTTP 500" }, "HTTP 500"), false);
  assert.equal(pageErrorWriteNeeded({ error: "HTTP 500" }, "HTTP 502"), true);
  assert.equal(pageErrorWriteNeeded(null, "HTTP 500"), true);
  const prev = { status: "deprecated", dates: JSON.stringify({ replacement: "gpt-5", shutdown_date: "2026-11-01" }), snippet: "row", source: "https://example.test" };
  const next = { status: "deprecated", dates: JSON.stringify({ shutdown_date: "2026-11-01", replacement: "gpt-5" }), snippet: "row", source: "https://example.test" };
  assert.equal(modelWriteNeeded(prev, next), false);
  assert.equal(modelWriteNeeded(prev, { ...next, status: "retired" }), true);
  assert.equal(modelWriteNeeded(null, next), true);
});

test("meta catalog skips an identical value", () => {
  assert.equal(metaWriteNeeded('["a","b"]', '["a","b"]'), false);
  assert.equal(metaWriteNeeded('["a","b"]', '["a","c"]'), true);
  assert.equal(metaWriteNeeded(null, "[]"), true);
});

test("freshness clock overlays stored timestamps without a per-row write", () => {
  const stored = "2026-10-15T11:00:00.000Z";
  const clock = "2026-10-15T12:00:00.000Z";
  assert.equal(laterIso(stored, clock), clock);
  assert.equal(laterIso(clock, stored), clock);
  assert.equal(laterIso(null, clock), clock);
  const failed = mergePageProbe({ at: stored, ok_at: stored, models: ["gpt-4o"] }, { at: clock });
  assert.equal(failed.ok_at, stored);
  assert.deepEqual(failed.models, ["gpt-4o"]);
  assert.equal(failed.at, clock);
  const ok = mergePageProbe(failed, { at: clock, ok_at: clock, models: ["gpt-4o"] });
  assert.equal(ok.ok_at, clock);
  const id = pageIdForSource("https://developers.openai.com/api/docs/deprecations");
  assert.equal(id, "openai-deprecations");
  assert.equal(modelSeenAt(stored, ok, "gpt-4o"), clock);
  assert.equal(modelSeenAt(stored, ok, "removed-model"), stored);
  assert.equal(modelSeenAt(stored, failed, "gpt-4o"), stored);
});

test("probe_clock JSON parses and ignores junk", () => {
  assert.deepEqual(parseProbe(null), { status: null, pages: {} });
  assert.equal(parseProbe(JSON.stringify({ status: t, pages: { "openai-deprecations": { at: t } } })).status, t);
  assert.deepEqual(parseProbe("not-json"), { status: null, pages: {} });
});

test("unchanged toolweather snapshot is not a meta write", () => {
  const cur = { "https://a": [1, "auth_ok"], "https://b": [0, ""] };
  assert.equal(snapshotUnchanged({ "https://b": [0, ""], "https://a": [1, "auth_ok"] }, cur), true);
  assert.equal(snapshotUnchanged(cur, { ...cur, "https://a": [0, "auth_ok"] }), false);
  assert.equal(snapshotUnchanged(null, cur), false);
  assert.equal(snapshotUnchanged(cur, { "https://a": [1, "auth_ok"] }), false);
});

test("5-minute cron keeps page, catalog, snapshot, and digest phases", () => {
  assert.equal(CRON_MS, 300000);
  assert.equal(PAGES.length, 9);
  const noon = Date.parse("2026-10-15T12:00:00.000Z");
  const atNoon = cronPlan(noon);
  assert.equal(atNoon.digest, true);
  assert.equal(atNoon.catalog, false);
  assert.equal(atNoon.tw, false);
  assert.equal(cronPlan(Date.parse("2026-10-15T12:05:00.000Z")).digest, false);
  assert.equal(cronPlan(Date.parse("2026-10-15T12:03:00.000Z")).digest, false);
  assert.equal(cronPlan(Date.parse("2026-10-15T12:30:00.000Z")).tw, true);
  assert.equal(cronPlan(Date.parse("2026-10-15T00:00:00.000Z")).tw, false);
  for (const day of ["2026-10-15", "2024-01-01"]) {
    for (const h of [0, 6, 12, 18]) {
      const stamp = `${day}T${String(h).padStart(2, "0")}:35:00.000Z`;
      assert.equal(cronPlan(Date.parse(stamp)).catalog, true, stamp);
    }
  }
  assert.equal(cronPlan(Date.parse("2026-10-15T12:40:00.000Z")).catalog, false);
  const first = cronPlan(Date.parse("1970-01-01T00:00:00.000Z"));
  const second = cronPlan(Date.parse("1970-01-01T00:05:00.000Z"));
  assert.equal(first.pageIndex, 0);
  assert.equal(second.pageIndex, 1);
  assert.equal(cronPlan(noon + 8 * CRON_MS).pageIndex, (atNoon.pageIndex + 8) % PAGES.length);
});
