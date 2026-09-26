import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { WakeDispatcher } from "../src/subagents/wake";
import { emptyUsage, type ChildRecord } from "../src/subagents/types";

const record: ChildRecord = {
  id: "child", type: "subagent", description: "Read docs", prompt: "Find the API docs.",
  depth: 1, status: "completed", background: true, startedAt: 1, endedAt: 2,
  usage: emptyUsage(), output: "The information is unchanged.", transcriptPath: "/tmp/child.jsonl",
};

function harness(mode: "active" | "shadow" = "active") {
  const sent: Array<{ record: ChildRecord; trigger: boolean }> = [];
  const actions: string[] = [];
  let complete!: (answer: Record<string, number> | undefined) => void;
  let calls = 0;
  const state = { idle: false, busy: true, current: true, enabled: true };
  const dispatcher = new WakeDispatcher({
    client: {
      mode,
      canUse: () => state.enabled,
      evaluate: () => { calls++; return new Promise(resolve => { complete = resolve; }); },
      recordAction: (_feature, action) => { actions.push(action); },
    },
    isIdle: () => state.idle,
    hasOtherBusy: () => state.busy,
    isCurrent: () => state.current,
    send: (record, trigger) => { sent.push({ record, trigger }); },
  });
  return { dispatcher, state, sent, actions, complete: (answer: Record<string, number> | undefined) => complete(answer), calls: () => calls };
}

test("disabled Jev and failed children keep immediate notices", () => {
  const h = harness();
  h.state.enabled = false;
  h.dispatcher.notify(record);
  h.state.enabled = true;
  h.dispatcher.notify({ ...record, status: "failed" });
  assert.deepEqual(h.sent.map(item => item.trigger), [true, true]);
  assert.equal(h.calls(), 0);
});

test("routine reports still reach context without an extra parent turn", async () => {
  const h = harness();
  h.dispatcher.notify(record);
  h.complete({ routine: 0.98, attention: 0.02 });
  await setImmediate();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].record.output, record.output);
  assert.equal(h.sent[0].trigger, false);
  assert.deepEqual(h.actions, ["deferred-turn"]);
});

test("the last child always wakes an idle parent, including a changed state during a request", async () => {
  const h = harness();
  h.dispatcher.notify(record);
  h.state.idle = true;
  h.state.busy = false;
  h.complete({ routine: 0.99, attention: 0.01 });
  await setImmediate();
  assert.equal(h.sent[0].trigger, true);
  h.dispatcher.notify(record);
  assert.equal(h.calls(), 1);
  assert.equal(h.sent[1].trigger, true);
});

test("uncertain and failed decisions preserve the normal wake", async () => {
  for (const answer of [undefined, { routine: 0.5, attention: 0.5 }, { routine: 0.99, attention: 0.4 }]) {
    const h = harness();
    h.dispatcher.notify(record);
    h.complete(answer);
    await setImmediate();
    assert.equal(h.sent[0].trigger, true);
  }
});

test("session resets and resumed children discard stale decisions", async () => {
  for (const reset of [true, false]) {
    const h = harness();
    h.dispatcher.notify(record);
    if (reset) h.dispatcher.reset();
    else h.state.current = false;
    h.complete({ routine: 0.99, attention: 0.01 });
    await setImmediate();
    assert.equal(h.sent.length, 0);
  }
});

test("shadow mode does not delay or duplicate the normal wake", async () => {
  const h = harness("shadow");
  h.dispatcher.notify(record);
  assert.equal(h.sent[0].trigger, true);
  h.complete({ routine: 0.99, attention: 0.01 });
  await setImmediate();
  assert.equal(h.sent.length, 1);
  assert.equal(h.actions.length, 0);
});
