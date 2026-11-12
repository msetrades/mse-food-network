import assert from "node:assert/strict";
import test from "node:test";
import { hoursLeft, matchScore } from "../src/lib/matching.ts";

const now = Date.parse("2026-01-01T00:00:00Z");

test("offer matching rewards urgency, local pickup and ambient handling", () => {
  const result = matchScore({ expires_at: "2026-01-01T08:00:00Z", pickup_region: "North District", storage: "ambient" }, " north district ", now);
  assert.deepEqual(result, { score: 100, local: true, urgency: 42 });
});

test("offer matching uses regional overlap and safely handles expired offers", () => {
  assert.equal(hoursLeft("2025-12-31T23:59:00Z", now), 0);
  const result = matchScore({ expires_at: "2025-12-31T23:59:00Z", pickup_region: "North Zone", storage: "chilled" }, "North Region", now);
  assert.equal(result.local, false);
  assert.equal(result.score, 76);
});
