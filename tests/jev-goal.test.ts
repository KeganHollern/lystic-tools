import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  canCheckCompletion, completionCheck, completionGaps, CRITERIA_LIMIT,
  EVIDENCE_LIMIT, EVIDENCE_TEXT_LIMIT, GoalDecisionGuard, GoalEvidenceHistory,
  needsIdeas, readEvidenceFile, stuckCheck, unresolvedFailures,
  type GoalEvidence,
} from "../src/goal/jev.ts";
import { goalDirFor, loadGoal, planPath, saveGoal, type GoalState } from "../src/goal/state.ts";
import type { ChildRecord } from "../src/subagents/types.ts";

function goal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    id: "test-goal", objective: "Fix the parser", createdAt: 100, status: "executing", round: 2,
    pendingCompletion: true, completedMessage: "The parser now accepts the input.",
    failedVerifications: 0, consecutiveBlocked: 0, idleRounds: 0, userSpokeSincePause: false,
    panelIds: [], panelAttempt: 0, ideasPending: false, gaps: [], notes: [], ...overrides,
  };
}

function evidence(overrides: Partial<GoalEvidence> = {}): GoalEvidence {
  return {
    id: "E1", round: 1, source: "worker", tool: "bash", action: "npm test",
    text: "Parser test failed: expected 2, got 1.", failed: true, ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("completion checks use bounded plan criteria and evidence references", () => {
  const plan = `## Acceptance criteria\n${Array.from({ length: 20 }, (_, index) => `${index + 1}. Criterion ${index}`).join("\n")}\n` +
    "## Verification plan\n1. Run npm test.\n## Non-goals\nDo not add a database.";
  const check = completionCheck(goal(), plan, [evidence()])!;
  assert.equal(Object.keys(check.questions).length, CRITERIA_LIMIT * 2);
  assert.equal((check.state.criteria as string[]).length, CRITERIA_LIMIT);
  assert.equal(check.state.verificationPlan, "1. Run npm test.");
  assert.equal(JSON.stringify(check.state).includes("database"), false);
  const gaps = completionGaps(check, { criterion1_E1: 0.99 });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /criterion 1: Criterion 0/);
  assert.match(gaps[0], /Evidence E1 \(worker, bash\)/);
  assert.match(gaps[0], /expected 2, got 1/);
  assert.ok(Object.values(check.questions).every((question) => question.includes("absent proof")));
});

test("absent evidence, resolved failures, prose, and uncertain scores keep the normal panel", () => {
  const plan = "## Acceptance criteria\n- Explain the architecture.\n## Verification plan\nRead the answer.";
  const withoutEvidence = completionCheck(goal(), plan, [])!;
  assert.deepEqual(Object.keys(withoutEvidence.questions), ["claim_incomplete_1"]);
  assert.deepEqual(completionGaps(withoutEvidence, undefined), []);
  assert.equal(completionCheck(goal({ completedMessage: undefined }), plan, []), undefined);
  assert.equal(completionCheck(goal(), "", [evidence()]), undefined);
  const success = evidence({ id: "E2", round: 2, failed: false, text: "All tests passed." });
  assert.deepEqual(unresolvedFailures([evidence(), success]), []);
  assert.deepEqual(Object.keys(completionCheck(goal(), plan, [evidence(), success])!.questions), ["claim_incomplete_1"]);
  const check = completionCheck(goal(), plan, [evidence()])!;
  assert.equal(check.state.verificationPlan, "Read the answer.");
  const uncertain: Array<Record<string, number> | undefined> = [undefined, {}, { criterion1_E1: 0.89 }, { criterion1_E1: Infinity }, { criterion1_E1: 2 }];
  for (const scores of uncertain) {
    assert.deepEqual(completionGaps(check, scores), []);
  }
});

test("an admitted incomplete claim uses the literal criterion without demanding new tests", () => {
  const current = goal({ completedMessage: "The parser change is complete, but I did not run the required parser test." });
  const plan = "## Acceptance criteria\n- The parser test passes.\n- Document the syntax.\n## Verification plan\nRun the parser test.";
  const check = completionCheck(current, plan, [])!;
  assert.deepEqual(Object.keys(check.questions), ["claim_incomplete_1", "claim_incomplete_2"]);
  const gaps = completionGaps(check, { claim_incomplete_1: 0.99, claim_incomplete_2: 0.1 });
  assert.equal(gaps.length, 1);
  assert.match(gaps[0], /The parser test passes/);
  assert.match(gaps[0], /I did not run the required parser test/);
  assert.ok(Object.values(check.questions).every((question) => question.includes("tests not required by this criterion")));
});

test("preflight permits only one correction per panel cycle and one check per round", () => {
  const current = goal();
  assert.equal(canCheckCompletion(current), true);
  current.jevCompletionCheckedRound = current.round;
  assert.equal(canCheckCompletion(current), false);
  current.jevCompletionCorrectedPanel = current.panelAttempt;
  current.round++;
  assert.equal(canCheckCompletion(current), false);
  current.panelAttempt++;
  assert.equal(canCheckCompletion(current), true);
});

test("evidence history bounds excerpts, deduplicates tool events, and needs real error flags", () => {
  const history = new GoalEvidenceHistory();
  const result = { toolCallId: "call1", toolName: "read", content: [{ type: "text", text: "Source code says error and failed." }] };
  history.add(1, "worker", result);
  history.add(1, "worker", result);
  assert.equal(history.recent(1).length, 1);
  assert.equal(history.recent(1)[0].failed, false);
  history.add(1, "worker", { ...result, toolCallId: "goal", toolName: "goal_update", isError: true });
  assert.equal(history.recent(1).length, 1);
  for (let index = 0; index < 50; index++) {
    history.add(2, "worker", {
      toolCallId: `call${index + 2}`, toolName: "bash", input: { command: "npm test" },
      details: { exitCode: 1 }, content: [{ type: "text", text: "X".repeat(20_000) }],
    });
  }
  assert.equal(history.recent(2).length, EVIDENCE_LIMIT);
  assert.ok(history.recent(2).every((item) => item.text.length <= EVIDENCE_TEXT_LIMIT && item.failed));
  assert.equal(history.recent(6).length, 0);
});

test("child evidence comes from tool results, not assistant claims", () => {
  const dir = mkdtempSync(join(tmpdir(), "jev-goal-evidence-"));
  try {
    const transcript = join(dir, "child.jsonl");
    writeFileSync(transcript, [
      { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "All tests passed." }] } },
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } },
      { type: "tool_execution_end", toolCallId: "t1", toolName: "bash", isError: true,
        result: { content: [{ type: "text", text: "Parser test failed." }] } },
      { type: "message_end", message: { role: "toolResult", toolName: "bash", toolCallId: "t1", isError: true,
        content: [{ type: "text", text: "Parser test failed." }] } },
    ].map((event) => JSON.stringify(event)).join("\n"));
    const child = { id: "child1", type: "task", startedAt: 101, endedAt: 102, status: "completed", transcriptPath: transcript } as ChildRecord;
    const history = new GoalEvidenceHistory();
    history.collectChildren([child], goal());
    history.collectChildren([child], goal());
    const captured = history.recent(2);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].action, "npm test");
    assert.equal(captured[0].failed, true);
    assert.equal(captured[0].source, "child:child1");
    assert.equal(captured[0].text, "Parser test failed.");
    assert.equal(readEvidenceFile(dir, 100), "");
    assert.ok(readEvidenceFile(transcript, 100).length <= 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stuck checks need observed failures across rounds and respect idea cooldown", () => {
  const failures = [evidence(), evidence({ id: "E2", round: 2 })];
  assert.ok(stuckCheck(goal({ pendingCompletion: false }), failures));
  assert.equal(stuckCheck(goal(), [failures[0]]), undefined);
  assert.equal(stuckCheck(goal(), failures.map((item) => ({ ...item, round: 2 }))), undefined);
  assert.equal(stuckCheck(goal({ jevLastIdeaRound: 1 }), failures), undefined);
  assert.equal(stuckCheck(goal({ ideasPending: true }), failures), undefined);
  assert.equal(needsIdeas({ repeatedFailure: 0.99, noProgress: 0.89 }), false);
  assert.equal(needsIdeas({ repeatedFailure: 0.99, noProgress: 0.99 }), true);
  assert.equal(needsIdeas({ repeatedFailure: Infinity, noProgress: 1 }), false);
});

test("the guard permits only one active request and applies to freshly read state", async () => {
  const guard = new GoalDecisionGuard();
  const response = deferred<Record<string, number>>();
  let current = goal();
  let applied: GoalState | undefined;
  const pending = guard.start(current, "session1", false, () => response.promise,
    () => ({ goal: current, session: "session1" }), (latest) => { applied = latest; });
  assert.equal(guard.busy, true);
  assert.equal(guard.start(current, "session1", false, async () => ({}),
    () => ({ goal: current, session: "session1" }), () => assert.fail()), undefined);
  current = { ...current, notes: [{ t: 101, text: "A fresh note." }] };
  response.resolve({ result: 1 });
  await pending;
  assert.equal(applied, current);
  assert.equal(guard.busy, false);
});

test("pause, clear, a new goal, session switch, round change, and new claims reject stale responses", async () => {
  const changes: Array<(value: GoalState) => GoalState | undefined> = [
    (value) => ({ ...value, status: "paused" }), () => undefined,
    (value) => ({ ...value, createdAt: 999 }), (value) => ({ ...value, id: "other" }),
    (value) => ({ ...value, round: value.round + 1 }),
    (value) => ({ ...value, completedMessage: "A different claim." }),
    (value) => ({ ...value, pendingCompletion: false }),
    (value) => ({ ...value, panelAttempt: value.panelAttempt + 1 }),
    (value) => ({ ...value, ideasPending: true }),
  ];
  for (const change of changes) {
    const guard = new GoalDecisionGuard();
    const response = deferred<Record<string, number>>();
    let current: GoalState | undefined = goal();
    const pending = guard.start(current, "session1", false, () => response.promise,
      () => ({ goal: current, session: "session1" }), () => assert.fail("A stale request changed the goal."));
    current = change(current);
    response.resolve({ result: 1 });
    await pending;
    assert.equal(guard.busy, false);
  }
  const guard = new GoalDecisionGuard();
  const pending = guard.start(goal(), "session1", false, async () => ({ result: 1 }),
    () => ({ goal: goal(), session: "session2" }), () => assert.fail());
  await pending;
});

test("invalidation aborts pending work and prevents a pause-resume state match", async () => {
  const guard = new GoalDecisionGuard();
  const response = deferred<Record<string, number>>();
  let signal: AbortSignal | undefined;
  const current = goal();
  const pending = guard.start(current, "session1", false, (requestSignal) => {
    signal = requestSignal;
    return response.promise;
  }, () => ({ goal: current, session: "session1" }), () => assert.fail());
  await Promise.resolve();
  guard.invalidate();
  assert.equal(signal?.aborted, true);
  assert.equal(guard.busy, false);
  response.resolve({ result: 1 });
  await pending;
});

test("API failures return control to the normal path and shadow requests never hold the loop", async () => {
  const guard = new GoalDecisionGuard();
  const current = goal();
  let called = false;
  await guard.start(current, "session1", false, async () => { throw new Error("offline"); },
    () => ({ goal: current, session: "session1" }), (_value, scores) => {
      called = true;
      assert.equal(scores, undefined);
    });
  assert.equal(called, true);
  const response = deferred<Record<string, number>>();
  let next = current;
  called = false;
  const pending = guard.start(current, "session1", true, () => response.promise,
    () => ({ goal: next, session: "session1" }), () => { called = true; });
  assert.equal(guard.busy, false);
  next = { ...current, status: "verifying", round: current.round + 1 };
  response.resolve({ result: 1 });
  await pending;
  assert.equal(called, true);
});

test("goal event integration preserves completion, fallback, and lifecycle behavior", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "jev-goal-loop-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  try {
    const { registerGoalFeature, createGoalControl, goalNotify } = await import("../src/goal/loop.ts");
    const { jev } = await import("../src/jev/index.ts");
    let enabled = true;
    let mode: "active" | "shadow" = "active";
    let respond: (questions: Record<string, string>) => Promise<Record<string, number> | undefined> = async () => undefined;
    let evaluations = 0;
    let timers: Array<() => void> = [];
    t.mock.method(jev, "canUse", () => enabled);
    t.mock.getter(jev, "mode", () => mode);
    t.mock.method(jev, "setGoal", () => {});
    t.mock.method(jev, "invalidate", () => {});
    t.mock.method(jev, "recordAction", () => {});
    t.mock.method(jev, "evaluate", async (_feature: string, _state: unknown, questions: Record<string, string>) => {
      evaluations++;
      return respond(questions);
    });
    t.mock.method(childProcess, "spawn", (() => ({ pid: 12345, unref() {} })) as any);
    syncBuiltinESMExports();
    t.mock.method(globalThis, "setTimeout", ((callback: () => void) => {
      timers.push(callback);
      return { unref() {} };
    }) as any);
    let sessionSequence = 0;
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
    function harness(pendingCompletion = true) {
      enabled = true;
      mode = "active";
      evaluations = 0;
      timers = [];
      const id = `session${++sessionSequence}`;
      const handlers = new Map<string, Array<(event: any, ctx: any) => void>>();
      const records: ChildRecord[] = [];
      const messages: any[] = [];
      const transcriptDir = join(dir, id);
      mkdirSync(transcriptDir, { recursive: true });
      const registry = {
        registryFile: join(transcriptDir, "registry.jsonl"),
        readTree: () => records,
        get: (recordId: string) => records.find((record) => record.id === recordId),
        newRecord: (input: any) => {
          const record = {
            ...input, id: `child${records.length}`, status: "running", startedAt: 100,
            transcriptPath: join(transcriptDir, `child${records.length}.jsonl`),
            sessionPath: join(transcriptDir, `child${records.length}.session.jsonl`),
          } as ChildRecord;
          records.push(record);
          return record;
        },
        update: (recordId: string, patch: Partial<ChildRecord>) => Object.assign(records.find((record) => record.id === recordId)!, patch),
        startWatcher() {}, kill() {},
      };
      const api = {
        on: (name: string, handler: (event: any, ctx: any) => void) => {
          const list = handlers.get(name) ?? [];
          list.push(handler);
          handlers.set(name, list);
        },
        registerTool() {}, registerMessageRenderer() {},
        getActiveTools: () => [], setActiveTools() {},
        sendMessage: (message: any) => { messages.push(message); }, sendUserMessage() {},
      };
      const ctx = { cwd: dir, sessionManager: { getSessionFile: () => join(dir, `${id}.jsonl`) }, ui: { notify() {} } };
      const emit = (name: string, event: any = {}) => {
        for (const handler of handlers.get(name) ?? []) handler(event, ctx);
      };
      const initial = goal({ id, pendingCompletion, createdAt: 100 + sessionSequence });
      saveGoal(initial);
      writeFileSync(planPath(goalDirFor(id)), "## Acceptance criteria\n- The parser accepts the input.\n## Verification plan\n1. Run npm test.");
      registerGoalFeature(api as any, { registry: registry as any });
      emit("session_start");
      const addFailure = () => emit("tool_result", {
        toolCallId: `failure${messages.length}`, toolName: "bash", input: { command: "npm test" },
        isError: true, content: [{ type: "text", text: "Parser test failed: expected 2, got 1." }],
      });
      return { id, emit, records, messages, addFailure, current: () => loadGoal(id)!, control: createGoalControl() };
    }

    await t.test("an absent key starts the original skeptic panel", async () => {
      const h = harness();
      enabled = false;
      h.addFailure();
      h.emit("agent_settled");
      await flush();
      assert.equal(evaluations, 0);
      assert.equal(h.current().status, "verifying");
      assert.equal(h.records.filter((record) => record.type === "goal-skeptic").length, 2);
    });

    await t.test("an API error falls back to the skeptic panel", async () => {
      const h = harness();
      respond = async () => { throw new Error("offline"); };
      h.addFailure();
      h.emit("agent_settled");
      await flush();
      assert.equal(evaluations, 1);
      assert.equal(h.current().status, "verifying");
      assert.equal(h.current().jevCompletionPending, false);
      assert.equal(h.records.length, 2);
    });

    await t.test("a delayed active decision cannot complete the goal and permits only one correction", async () => {
      const h = harness();
      const response = deferred<Record<string, number>>();
      respond = () => response.promise;
      h.addFailure();
      h.emit("agent_settled");
      h.emit("agent_settled");
      await flush();
      assert.equal(evaluations, 1);
      assert.equal(h.records.length, 0);
      assert.equal(h.current().status, "executing");
      response.resolve({ criterion1_E1: 0.99 });
      await flush();
      assert.equal(h.current().pendingCompletion, false);
      assert.equal(h.current().status, "executing");
      assert.equal(h.messages.filter((message) => message.customType === "goal_round").length, 1);
      const corrected = h.current();
      corrected.pendingCompletion = true;
      saveGoal(corrected);
      h.emit("agent_settled");
      await flush();
      assert.equal(evaluations, 1);
      assert.equal(h.current().status, "verifying");
      assert.equal(h.records.length, 2);
    });

    await t.test("a paused request cannot restart work and resume starts a new panel", async () => {
      const h = harness();
      const response = deferred<Record<string, number>>();
      respond = () => response.promise;
      h.addFailure();
      h.emit("agent_settled");
      await flush();
      h.control.pause();
      response.resolve({ criterion1_E1: 1 });
      await flush();
      assert.equal(h.current().status, "paused");
      assert.equal(h.records.length, 0);
      assert.equal(h.messages.filter((message) => message.customType === "goal_round").length, 0);
      h.control.resume();
      timers.at(-1)!();
      await flush();
      assert.equal(h.current().status, "verifying");
      assert.equal(h.records.length, 2);
    });

    await t.test("ordinary child completion wakes a pending check without autoWake", async () => {
      const h = harness();
      respond = async () => undefined;
      const child = { id: "ordinary", type: "task", status: "running", startedAt: h.current().createdAt,
        transcriptPath: join(dir, "absent.jsonl") } as ChildRecord;
      h.records.push(child);
      h.addFailure();
      h.emit("agent_settled");
      await flush();
      assert.equal(evaluations, 0);
      child.status = "completed";
      child.endedAt = 1000;
      goalNotify(child, { fromRunning: true });
      timers.at(-1)!();
      await flush();
      assert.equal(evaluations, 1);
      assert.equal(h.current().status, "verifying");
      assert.equal(h.records.filter((record) => record.type === "goal-skeptic").length, 2);
    });

    await t.test("an ordinary completed turn cannot strand a later goal planner", async () => {
      const h = harness(false);
      h.control.clear();
      h.emit("agent_start");
      h.emit("agent_settled");
      h.control.start("Fix the parser", undefined);
      const planner = h.records.find((record) => record.type === "goal-planner")!;
      assert.ok(planner);
      writeFileSync(planPath(goalDirFor(h.id)), "## Acceptance criteria\n- The parser works.");
      planner.status = "completed";
      goalNotify(planner, { fromRunning: true });
      timers.at(-1)!();
      assert.equal(h.current().status, "executing");
      assert.equal(h.current().round, 1);
      assert.equal(h.messages.filter((message) => message.customType === "goal_round").length, 1);
    });

    await t.test("a child timer cannot inject a goal round during a worker turn", async () => {
      const h = harness(false);
      h.emit("agent_start");
      goalNotify({ id: "ordinary", type: "task", status: "completed" } as ChildRecord, { fromRunning: true });
      timers.at(-1)!();
      assert.equal(h.current().round, 2);
      h.emit("agent_settled");
      assert.equal(h.current().round, 3);
      assert.equal(h.messages.filter((message) => message.customType === "goal_round").length, 1);
    });

    await t.test("repeated failed tool results request an early idea agent despite tool activity", async () => {
      const h = harness(false);
      respond = async () => ({ repeatedFailure: 0.99, noProgress: 0.99 });
      h.emit("agent_settled");
      h.emit("tool_call", { toolName: "bash" });
      h.addFailure();
      h.emit("agent_settled");
      h.emit("tool_call", { toolName: "bash" });
      h.addFailure();
      h.emit("agent_settled");
      await flush();
      assert.equal(evaluations, 1);
      assert.equal(h.current().round, 4);
      assert.equal(h.current().ideasPending, true);
      assert.equal(h.current().jevLastIdeaRound, 4);
      assert.equal(h.records.filter((record) => record.type === "goal-idea").length, 1);
      assert.equal(h.current().failedVerifications, 0);
    });

    await t.test("shadow checks preserve the normal panel schedule", async () => {
      const h = harness();
      mode = "shadow";
      const response = deferred<Record<string, number>>();
      respond = () => response.promise;
      h.addFailure();
      h.emit("agent_settled");
      assert.equal(h.current().status, "verifying");
      assert.equal(h.records.length, 2);
      response.resolve({ criterion1_E1: 1 });
      await flush();
      assert.equal(h.current().status, "verifying");
      assert.equal(h.messages.filter((message) => message.customType === "goal_round").length, 0);
    });

    await t.test("timers from an old session cannot advance a new session", async () => {
      harness();
      const oldTimer = timers.at(-1)!;
      const h = harness(false);
      oldTimer();
      await flush();
      assert.equal(h.current().round, 2);
      assert.equal(h.messages.length, 0);
    });

    await t.test("tree navigation replaces a canceled completion check without stale changes", async () => {
      const h = harness();
      const response = deferred<Record<string, number>>();
      respond = () => response.promise;
      h.addFailure();
      h.emit("agent_settled");
      await flush();
      h.emit("session_tree");
      timers.at(-1)!();
      assert.equal(h.current().status, "verifying");
      response.resolve({ criterion1_E1: 1, claim_incomplete_1: 1 });
      await flush();
      assert.equal(h.current().status, "verifying");
      assert.equal(h.messages.filter((message) => message.customType === "goal_round").length, 0);
      assert.equal(evaluations, 1);
    });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(dir, { recursive: true, force: true });
  }
});
