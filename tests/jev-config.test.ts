import assert from "node:assert/strict";
import test from "node:test";
import { resolveJevConfig } from "../src/config";

test("Jev config supports a custom environment variable and separate feature switches", () => {
  const resolved = resolveJevConfig({
    apiKeyEnv: "MY_TYPESAFE_KEY", enabled: "auto", mode: "shadow",
    features: { completionCheck: false, wakeTriage: false },
  });
  assert.equal(resolved.apiKeyEnv, "MY_TYPESAFE_KEY");
  assert.equal(resolved.enabled, "auto");
  assert.equal(resolved.mode, "shadow");
  assert.deepEqual(resolved.features, {
    completionCheck: false, stuckDetection: true, evidenceSelection: true, wakeTriage: false,
  });
});

test("Jev config bounds request limits and accepts an explicit off switch", () => {
  const resolved = resolveJevConfig({
    enabled: false, mode: "off", timeoutMs: Infinity,
    maxCallsPerGoal: 0, maxCallsPerSession: -10, maxInputChars: 1_000_000,
    apiKeyEnv: "not a variable", model: "not a Jev model",
  });
  assert.equal(resolved.enabled, false);
  assert.equal(resolved.mode, "off");
  assert.equal(resolved.timeoutMs, 1500);
  assert.equal(resolved.maxCallsPerGoal, 0);
  assert.equal(resolved.maxCallsPerSession, 0);
  assert.equal(resolved.maxInputChars, 48_000);
  assert.equal(resolved.apiKeyEnv, "TYPESAFE_API_KEY");
  assert.equal(resolved.model, "jev-1.13.0");
});
