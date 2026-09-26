import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import extension from "../src/index";
import { JEV_CONFIG } from "../src/config";
import { JevClient, type JevFeature } from "../src/jev/client";
import { jev } from "../src/jev/index";
import { SubagentRegistry, type RegistryChange } from "../src/subagents/registry";
import { emptyUsage, type ChildRecord } from "../src/subagents/types";

function record(id: string, type = "subagent"): ChildRecord {
  return {
    id, type, description: "Read source material", prompt: "Read the alpha topic.",
    depth: 1, status: "completed", background: true, startedAt: 1, endedAt: 2,
    usage: emptyUsage(), output: "The child completed the task.", transcriptPath: `/tmp/${id}.jsonl`,
  };
}

function harness(t: TestContext, records: ChildRecord[]) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let changed: RegistryChange | undefined;
  t.mock.method(SubagentRegistry.prototype, "setOnChange", (callback: RegistryChange) => { changed = callback; });
  t.mock.method(SubagentRegistry.prototype, "readTree", () => records);
  t.mock.method(SubagentRegistry.prototype, "list", () => records);
  t.mock.method(SubagentRegistry.prototype, "get", (id: string) => records.find(item => item.id === id));
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const handlers = new Map<string, any[]>();
  const messages: { message: any; options: any }[] = [];
  const pi = {
    registerTool: (definition: any) => tools.set(definition.name, definition),
    registerCommand: (name: string, definition: any) => commands.set(name, definition),
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    appendEntry: () => {},
    sendMessage: (message: any, options: any) => messages.push({ message, options }),
    getActiveTools: () => [...tools.keys()],
    setActiveTools: () => {},
  };
  extension(pi as any);
  return {
    tools, commands, handlers, messages,
    complete: (child: ChildRecord) => changed!(child, { fromRunning: true }),
  };
}

for (const disabled of [false, true]) {
  test(`extension registration preserves normal tools when Jev ${disabled ? "is disabled" : "has no key"}`, async (t) => {
    let requests = 0;
    const isolated = new JevClient({ ...JEV_CONFIG, enabled: disabled ? false : "auto", mode: "active" }, {
      env: {}, depth: 0,
      fetch: (async () => { requests++; throw new Error("The test must not send requests."); }) as typeof fetch,
    });
    t.mock.method(jev, "canUse", (feature: JevFeature) => isolated.canUse(feature));
    t.mock.method(jev, "evaluate", (...args: Parameters<JevClient["evaluate"]>) => isolated.evaluate(...args));
    const child = record("fallback-child");
    child.output = "A complete paragraph describes the source evidence.\n\n".repeat(150);
    const h = harness(t, [child]);
    for (const name of ["web_search", "web_fetch", "task", "task_output", "task_list", "task_kill", "task_message", "goal_update"]) {
      assert.ok(h.tools.has(name), `${name} must remain available`);
    }
    for (const name of ["jev", "tasks", "goal"]) assert.ok(h.commands.has(name));
    const output = await h.tools.get("task_output").execute("output-test", { wait: false });
    assert.ok(output.content[0].text.endsWith(child.output));
    h.complete(child);
    assert.equal(h.messages.length, 1);
    assert.equal(h.messages[0].message.customType, "subagent_completed");
    assert.equal(h.messages[0].options.triggerTurn, true);
    assert.equal(requests, 0);
  });
}

test("goal roles and waiting children bypass Jev wake triage", (t) => {
  t.mock.method(jev, "canUse", () => true);
  const evaluate = t.mock.method(jev, "evaluate", async () => ({ routine: 1, attention: 0 }));
  const records = ["goal-planner", "goal-skeptic", "goal-idea", "goal-summary"].map(type => record(type, type));
  records.push({ ...record("waiting-child"), status: "waiting" });
  const h = harness(t, records);
  for (const child of records) h.complete(child);
  assert.equal(evaluate.mock.calls.length, 0);
  assert.equal(h.messages.length, 0);
});

test("the root extension discards an old wake result after a session change", async (t) => {
  const previousMode = jev.config.mode;
  jev.config.mode = "active";
  t.after(() => { jev.config.mode = previousMode; });
  t.mock.method(jev, "canUse", () => true);
  let answer!: (value: Record<string, number>) => void;
  t.mock.method(jev, "evaluate", () => new Promise(resolve => { answer = resolve; }));
  const child = record("old-session-child");
  const busy = { ...record("other-child"), status: "running" as const };
  const h = harness(t, [child, busy]);
  h.complete(child);
  for (const handler of h.handlers.get("session_before_switch") ?? []) handler({}, {});
  answer({ routine: 1, attention: 0 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.messages.length, 0);
});

test("the root extension discards a terminal result after the child resumes", async (t) => {
  const previousMode = jev.config.mode;
  jev.config.mode = "active";
  t.after(() => { jev.config.mode = previousMode; });
  t.mock.method(jev, "canUse", () => true);
  let answer!: (value: Record<string, number>) => void;
  t.mock.method(jev, "evaluate", () => new Promise(resolve => { answer = resolve; }));
  const child = record("resumed-child");
  const busy = { ...record("other-child"), status: "running" as const };
  const h = harness(t, [child, busy]);
  h.complete(child);
  child.status = "running";
  child.endedAt = undefined;
  answer({ routine: 1, attention: 0 });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(h.messages.length, 0);
});
