import assert from "node:assert/strict";
import { test } from "node:test";
import { JevClient, type JevClientConfig, type JevDependencies } from "../src/jev/client.ts";
import { registerJev } from "../src/jev/index.ts";

const KEY = "ts_test_key_DO_NOT_LOG_123456789";
const QUESTION = { applies: "Does this evidence apply to the task?" };
function config(overrides: Partial<JevClientConfig> = {}): JevClientConfig {
  return {
    enabled: "auto", mode: "active", apiKeyEnv: "TYPESAFE_API_KEY", model: "jev-1.13.0",
    timeoutMs: 500, maxCallsPerGoal: 30, maxCallsPerSession: 100, maxInputChars: 24_000,
    features: { completionCheck: true, stuckDetection: true, evidenceSelection: true, wakeTriage: true },
    ...overrides,
  };
}
const data = () => ({ answers: { applies: { type: "noul", noul: 0.8 } }, usage: { input_tokens: 123, output_tokens: 0 } });
const response = (body: unknown = data(), status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const transport = (fn: (...args: Parameters<typeof fetch>) => Response | Promise<Response>) => fn as typeof fetch;
function client(overrides: Partial<JevClientConfig> = {}, dependencies: JevDependencies = {}): JevClient {
  return new JevClient(config(overrides), { env: { TYPESAFE_API_KEY: KEY }, fetch: transport(() => response()), ...dependencies });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("unavailable Jev never sends a request", async () => {
  let calls = 0;
  const fetcher = transport(() => { calls++; return response(); });
  const cases = [
    client({ enabled: false }, { fetch: fetcher }),
    client({ mode: "off" }, { fetch: fetcher }),
    client({}, { env: {}, fetch: fetcher }),
    client({}, { env: { TYPESAFE_API_KEY: "bad\nkey" }, fetch: fetcher }),
    client({}, { depth: 1, fetch: fetcher }),
    client({ timeoutMs: -1 }, { fetch: fetcher }),
    client({ features: { ...config().features, completionCheck: false } }, { fetch: fetcher }),
  ];
  for (const item of cases) {
    assert.equal(item.canUse("completionCheck"), false);
    assert.equal(await item.evaluate("completionCheck", "state", QUESTION), undefined);
  }
  assert.equal(calls, 0);
});

test("the client sends typed questions to the fixed endpoint and removes credentials", async () => {
  const env = { TYPESAFE_API_KEY: KEY, OTHER_API_KEY: "other_private_value_123456789" };
  let sent = "";
  const item = client({}, { env, fetch: transport((url, init) => {
    assert.equal(url, "https://api.typesafe.ai/v1/systemone");
    assert.equal(init?.redirect, "error");
    assert.equal(init?.credentials, "omit");
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${KEY}`);
    sent = String(init?.body);
    return response();
  }) });
  const result = await item.evaluate("completionCheck", { task: `Read ${KEY} ${env.OTHER_API_KEY}`, password: "local-password" }, QUESTION);
  assert.deepEqual(result, { applies: 0.8 });
  assert.equal(sent.includes(KEY), false);
  assert.equal(sent.includes(env.OTHER_API_KEY), false);
  assert.equal(sent.includes("local-password"), false);
  assert.equal(JSON.parse(sent).questions.applies.type, "noul");
  assert.equal(item.snapshot().inputTokens, 123);
});

test("the client rejects oversized or invalid questions without a request or budget use", async () => {
  let calls = 0;
  const item = client({ maxInputChars: 300 }, { fetch: transport(() => { calls++; return response(); }) });
  assert.equal(await item.evaluate("evidenceSelection", "x".repeat(1000), QUESTION), undefined);
  assert.equal(await item.evaluate("evidenceSelection", "small", {}), undefined);
  assert.equal(await item.evaluate("evidenceSelection", "small", { invalid: "" }), undefined);
  assert.equal(await item.evaluate("evidenceSelection", "small", { "raw text must not enter metadata": "Question" }), undefined);
  assert.equal(calls, 0);
  assert.equal(item.snapshot().calls, 0);
});

test("all returned answers must be finite Noul probabilities with exactly the requested names", async () => {
  const malformed = [
    {}, { answers: {} }, { answers: { applies: { type: "score", noul: 0.8 } } },
    { answers: { applies: { type: "noul", noul: "0.8" } } },
    { answers: { applies: { type: "noul", noul: -0.1 } } },
    { answers: { applies: { type: "noul", noul: 1.1 } } },
    { answers: { applies: { type: "noul", noul: Number.NaN } } },
    { answers: { applies: { type: "noul", noul: 0.8 }, extra: { type: "noul", noul: 1 } } },
  ];
  for (const body of malformed) {
    const item = client({}, { fetch: transport(() => response(body)) });
    assert.equal(await item.evaluate("completionCheck", "state", QUESTION), undefined);
    assert.equal(item.snapshot().errors, 1);
    assert.equal(item.snapshot().recent[0].outcome, "invalid_response");
  }
  const partial = client({}, { fetch: transport(() => response()) });
  assert.equal(await partial.evaluate("completionCheck", "state", { ...QUESTION, second: "Another question" }), undefined);
});

test("concurrent requests reserve the goal budget before the network resolves", async () => {
  const gate = deferred<Response>();
  let calls = 0;
  const item = client({ maxCallsPerGoal: 2 }, { fetch: transport(() => { calls++; return gate.promise; }) });
  item.setGoal("goal-a");
  const first = item.evaluate("completionCheck", "state", QUESTION);
  const second = item.evaluate("stuckDetection", "state", QUESTION);
  assert.equal(await item.evaluate("wakeTriage", "state", QUESTION), undefined);
  assert.equal(calls, 2);
  gate.resolve(response());
  await Promise.all([first, second]);
  assert.equal(item.snapshot().goalCalls, 2);
  item.setGoal("goal-b");
  assert.equal(item.snapshot().goalCalls, 0);
  assert.equal(item.snapshot().calls, 2);
});

test("the session budget survives goal changes", async () => {
  const item = client({ maxCallsPerSession: 1 });
  await item.evaluate("completionCheck", "state", QUESTION);
  item.setGoal("another-goal");
  assert.equal(item.canUse("completionCheck"), false);
  assert.match(item.availability("completionCheck").reason, /session request budget/);
});

test("zero budgets stop requests and the goal budget applies only to an active goal", async () => {
  const session = client({ maxCallsPerSession: 0 });
  assert.match(session.availability("wakeTriage").reason, /session request budget/);
  const goal = client({ maxCallsPerGoal: 0 });
  assert.equal(goal.canUse("wakeTriage"), true);
  await goal.evaluate("wakeTriage", "state", QUESTION);
  assert.equal(goal.snapshot().goalCalls, 0);
  goal.setGoal("active");
  assert.match(goal.availability("wakeTriage").reason, /goal request budget/);
});

test("the cache shares requests and separates features and goals", async () => {
  let calls = 0;
  const item = client({}, { fetch: transport(() => { calls++; return response(); }) });
  item.setGoal("goal-a");
  const [a, b] = await Promise.all([
    item.evaluate("completionCheck", "private state", QUESTION, { key: "same" }),
    item.evaluate("completionCheck", "private state", QUESTION, { key: "same" }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  a!.applies = 0;
  assert.equal(b!.applies, 0.8);
  await item.evaluate("stuckDetection", "state", QUESTION, { key: "same" });
  assert.equal(calls, 2);
  item.setGoal("goal-b");
  await item.evaluate("completionCheck", "state", QUESTION, { key: "same" });
  assert.equal(calls, 3);
  assert.equal(item.snapshot().cacheHits, 1);
});

test("timeouts include a stalled body reader and preserve the normal fallback", async () => {
  let requestSignal: AbortSignal | undefined;
  const item = client({ timeoutMs: 10 }, { fetch: transport((_url, init) => {
    requestSignal = init?.signal as AbortSignal;
    return new Response(new ReadableStream({ start() {} }));
  }) });
  assert.equal(await item.evaluate("completionCheck", "state", QUESTION), undefined);
  assert.equal(requestSignal?.aborted, true);
  assert.equal(item.snapshot().recent[0].outcome, "timeout");
  assert.equal(item.snapshot().errors, 1);
});

test("a cached key cannot reuse a decision for changed state or questions", async () => {
  let calls = 0;
  const item = client({}, { fetch: transport(() => { calls++; return response(); }) });
  await item.evaluate("completionCheck", "first state", QUESTION, { key: "same" });
  await item.evaluate("completionCheck", "second state", QUESTION, { key: "same" });
  await item.evaluate("completionCheck", "second state", { applies: "Changed question" }, { key: "same" });
  assert.equal(calls, 3);
});

test("a duplicate request can use the cache after its request budget is spent", async () => {
  let calls = 0;
  const item = client({ maxCallsPerSession: 1 }, { fetch: transport(() => { calls++; return response(); }) });
  const first = item.evaluate("completionCheck", "state", QUESTION, { key: "same" });
  const second = item.evaluate("completionCheck", "state", QUESTION, { key: "same" });
  assert.deepEqual(await first, await second);
  assert.equal(calls, 1);
});

test("oversized response bodies return the fallback", async () => {
  const item = client({}, { fetch: transport(() => response({ ...data(), extra: "x".repeat(70_000) })) });
  assert.equal(await item.evaluate("completionCheck", "state", QUESTION), undefined);
  assert.equal(item.snapshot().recent[0].outcome, "invalid_response");
});

test("invalidation preserves request and cancellation counts within the session", async () => {
  const item = client({}, { fetch: transport(() => new Promise(() => {})) });
  const pending = item.evaluate("completionCheck", "state", QUESTION);
  item.invalidate();
  assert.equal(await pending, undefined);
  assert.equal(item.snapshot().calls, 1);
  assert.equal(item.snapshot().aborted, 1);
});

test("invalidation without pending requests does not write metadata", () => {
  const item = client({}, { env: {} });
  const saved: unknown[] = [];
  item.setPersistence(snapshot => saved.push(snapshot));
  item.invalidate();
  item.invalidate();
  assert.equal(saved.length, 0);
});

test("caller cancellation ends a request even when the transport ignores the signal", async () => {
  const controller = new AbortController();
  const item = client({}, { fetch: transport(() => new Promise(() => {})) });
  const pending = item.evaluate("completionCheck", "state", QUESTION, { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, undefined);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.snapshot().aborted, 1);
  assert.equal(item.snapshot().errors, 0);
});

test("session reset aborts old requests and ignores their late results", async () => {
  const gate = deferred<Response>();
  const item = client({}, { fetch: transport(() => gate.promise) });
  const pending = item.evaluate("completionCheck", "state", QUESTION);
  item.reset();
  assert.equal(await pending, undefined);
  gate.resolve(response());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(item.snapshot().calls, 0);
  assert.equal(item.snapshot().successes, 0);
  assert.equal(item.snapshot().recent.length, 0);
});

test("three errors pause requests until the breaker delay expires", async () => {
  let now = 100;
  let calls = 0;
  const item = client({}, { now: () => now, fetch: transport(() => { calls++; return response({}, 503); }) });
  for (let index = 0; index < 3; index++) await item.evaluate("completionCheck", "state", QUESTION);
  assert.equal(item.canUse("completionCheck"), false);
  await item.evaluate("completionCheck", "state", QUESTION);
  assert.equal(calls, 3);
  now += 30_001;
  assert.equal(item.canUse("completionCheck"), true);
  await item.evaluate("completionCheck", "state", QUESTION);
  assert.equal(calls, 4);
});

test("an API key rejection stops requests until the key changes", async () => {
  const env = { TYPESAFE_API_KEY: KEY };
  const item = client({}, { env, fetch: transport(() => response({}, 401)) });
  await item.evaluate("completionCheck", "state", QUESTION);
  assert.match(item.availability("completionCheck").reason, /API rejected/);
  env.TYPESAFE_API_KEY = "ts_another_test_key_123456789";
  assert.equal(item.canUse("completionCheck"), true);
});

test("metadata persistence restores budgets and never includes request text or secrets", async () => {
  const snapshots: unknown[] = [];
  const item = client();
  item.setPersistence(snapshot => snapshots.push(snapshot));
  item.setGoal("private goal title");
  await item.evaluate("completionCheck", `private body ${KEY}`, { applies: "Private question text" }, { key: "private dedupe key" });
  item.recordAction("completionCheck", "retry");
  const raw = JSON.stringify(snapshots);
  for (const secret of [KEY, "private goal title", "private body", "Private question text", "private dedupe key"]) assert.equal(raw.includes(secret), false);
  const restored = client();
  restored.reset(item.snapshot());
  assert.equal(restored.snapshot().calls, 1);
  assert.equal(restored.snapshot().goalCalls, 1);
  assert.equal(restored.snapshot().features.completionCheck.actions.retry, 1);
  assert.equal(restored.snapshot().recent[0].probabilities?.applies, 0.8);
  restored.setGoal("private goal title");
  assert.equal(restored.snapshot().goalCalls, 1);
});

test("question names and action labels cannot put credentials into metadata", async () => {
  const item = client();
  assert.equal(await item.evaluate("completionCheck", "state", { [KEY]: "Question" }), undefined);
  item.recordAction("completionCheck", KEY);
  assert.equal(JSON.stringify(item.snapshot()).includes(KEY), false);
  assert.equal(item.snapshot().calls, 0);
});

test("shadow mode still records decisions but reports its mode to action owners", async () => {
  const item = client({ mode: "shadow" });
  assert.equal(item.mode, "shadow");
  assert.deepEqual(await item.evaluate("wakeTriage", "state", QUESTION), { applies: 0.8 });
});

function commandHarness(item: JevClient, entries: unknown[] = []) {
  const messages: string[] = [];
  const saved: unknown[] = [];
  const handlers = new Map<string, (event: unknown, ctx: any) => unknown>();
  let command!: { handler: (args: string, ctx: any) => Promise<void> };
  const ctx = {
    hasUI: true,
    ui: { notify: (message: string) => messages.push(message) },
    sessionManager: { getEntries: () => entries },
  };
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: any) => unknown) => handlers.set(event, handler),
    registerCommand: (name: string, definition: typeof command) => { assert.equal(name, "jev"); command = definition; },
    appendEntry: (type: string, snapshot: unknown) => { assert.equal(type, "lystic-jev"); saved.push(snapshot); },
    sendMessage: (message: { content: string }) => messages.push(message.content),
  };
  registerJev(pi as any, item);
  return {
    messages, saved, ctx,
    start: () => handlers.get("session_start")!({}, ctx),
    fire: (event: string) => handlers.get(event)!({}, ctx),
    command: (args: string) => command.handler(args, ctx),
  };
}

test("the status command shows the key variable name and availability without a request", async () => {
  let requests = 0;
  const item = client({ apiKeyEnv: "CUSTOM_JEV_KEY" }, { env: {}, fetch: transport(() => { requests++; return response(); }) });
  const harness = commandHarness(item);
  harness.start();
  await harness.command("status");
  const status = harness.messages.at(-1)!;
  assert.match(status, /Jev reads the API key from CUSTOM_JEV_KEY/);
  assert.match(status, /CUSTOM_JEV_KEY key is absent or invalid/);
  assert.match(status, /No goal is active/);
  assert.equal(requests, 0);
});

test("the status command reports off, shadow, and active modes with a custom key variable", async () => {
  for (const mode of ["off", "shadow", "active"] as const) {
    const item = client({ mode, apiKeyEnv: "CUSTOM_JEV_KEY" }, { env: { CUSTOM_JEV_KEY: KEY } });
    const harness = commandHarness(item);
    harness.start();
    await harness.command("");
    const status = harness.messages.at(-1)!;
    assert.match(status, new RegExp(`Jev mode is ${mode}`));
    assert.match(status, /CUSTOM_JEV_KEY/);
    assert.match(status, mode === "off" ? /Jev is off in the settings/ : /Jev is available/);
    assert.equal(status.includes(KEY), false);
  }
});

test("the report command restores metadata and never shows state, questions, or keys", async () => {
  const prior = client();
  prior.setGoal("private goal title");
  await prior.evaluate("completionCheck", "private request body", { applies: "private question" });
  prior.recordAction("completionCheck", "retry");
  const item = client();
  const harness = commandHarness(item, [{ type: "custom", customType: "lystic-jev", data: prior.snapshot() }]);
  harness.start();
  await harness.command("report");
  const report = harness.messages.at(-1)!;
  assert.match(report, /1\/100 session requests/);
  assert.match(report, /1\/30 goal requests/);
  assert.match(report, /recorded retry 1 times/);
  assert.match(report, /applies=0.800/);
  for (const value of [KEY, "private goal title", "private request body", "private question"]) assert.equal(report.includes(value), false);
  item.recordAction("completionCheck", "retry");
  assert.equal(harness.saved.length, 1);
  assert.equal(JSON.stringify(harness.saved).includes(KEY), false);
});

test("the command gives usage for an unknown action and supports sessions without a UI", async () => {
  const harness = commandHarness(client());
  harness.start();
  await harness.command("enable");
  assert.equal(harness.messages.at(-1), "Use /jev status or /jev report.");
  harness.ctx.hasUI = false;
  await harness.command("status");
  assert.match(harness.messages.at(-1)!, /Jev mode is active/);
});

test("session lifecycle events abort pending requests", async () => {
  for (const event of ["session_before_switch", "session_before_fork", "session_tree", "session_shutdown"]) {
    const item = client({}, { fetch: transport(() => new Promise(() => {})) });
    const harness = commandHarness(item);
    harness.start();
    const pending = item.evaluate("completionCheck", "state", QUESTION);
    harness.fire(event);
    assert.equal(await pending, undefined);
    assert.equal(item.snapshot().aborted, 1);
  }
});
