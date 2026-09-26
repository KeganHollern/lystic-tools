import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import dns from "node:dns/promises";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { JEV_CONFIG } from "../src/config";
import { JevClient, type JevFeature } from "../src/jev/client";
import { selectEvidence } from "../src/jev/evidence";
import { jev } from "../src/jev/index";
import { registerTaskTools } from "../src/subagents/tools";

const paragraph = (name: string) => `${name}\n${"This paragraph contains source details for the requested topic. ".repeat(14)}\n\n`;
const document = [
  paragraph("INTRO_ONE"), paragraph("INTRO_TWO"),
  paragraph("ALPHA_ONE"), paragraph("ALPHA_TWO"),
  paragraph("BETA_ONE"), paragraph("BETA_TWO"),
  paragraph("OTHER_ONE"), paragraph("OTHER_TWO"),
  paragraph("END_ONE"), paragraph("END_TWO"),
].join("");

function setup(t: TestContext, mode: "active" | "shadow" = "active") {
  const oldMode = jev.config.mode;
  const oldLimit = JEV_CONFIG.maxInputChars;
  jev.config.mode = mode;
  JEV_CONFIG.maxInputChars = 24_000;
  t.after(() => { jev.config.mode = oldMode; JEV_CONFIG.maxInputChars = oldLimit; });
  t.mock.method(jev, "canUse", () => true);
  const calls: { state: any; questions: Record<string, string> }[] = [];
  const evaluate = t.mock.method(jev, "evaluate", async (_feature: JevFeature, state: any, questions: Record<string, string>) => {
    calls.push({ state, questions });
    const wanted = state.context.toLowerCase().includes("beta") ? "BETA" : "ALPHA";
    return Object.fromEntries(state.chunks.map((chunk: any) => [chunk.id, chunk.text.includes(wanted) ? 1 : 0]));
  });
  const action = t.mock.method(jev, "recordAction", () => {});
  return { calls, evaluate, action };
}

async function temporaryDirectory(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "jev-evidence-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("evidence selection preserves complete excerpts, source order, and the full file", async (t) => {
  const { calls, action } = setup(t);
  const directory = await temporaryDirectory(t);
  const path = join(directory, "full.txt");
  const selected = await selectEvidence(document, "Explain alpha.", {
    source: "https://example.test/source",
    saveOriginal: async (text) => { await writeFile(path, text); return path; },
  });
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0].questions).length, calls[0].state.chunks.length);
  assert.equal(calls[0].state.chunks.map((chunk: any) => chunk.text).join(""), document);
  assert.ok(selected.includes("https://example.test/source"));
  assert.ok(selected.includes(path));
  assert.ok(selected.includes("[The excerpt omits a section.]"));
  assert.ok(selected.includes(paragraph("ALPHA_ONE")));
  assert.ok(!selected.includes("BETA_ONE"));
  assert.ok(selected.indexOf("INTRO_ONE") < selected.indexOf("ALPHA_ONE"));
  assert.ok(selected.indexOf("ALPHA_ONE") < selected.indexOf("END_TWO"));
  assert.equal(await readFile(path, "utf8"), document);
  assert.equal(action.mock.calls.length, 1);
});

test("summary sections, errors, artifacts, and complete fenced blocks survive selection", async (t) => {
  setup(t);
  const code = "```ts\nconst complete = true;\n\nconsole.log(complete);\n```\n\n";
  const source = document.replace(paragraph("OTHER_ONE"),
    `## Summary\n\n${paragraph("SUMMARY_DETAIL")}${code}## Details\n\nError: The request failed.\n\nArtifact: /tmp/evidence.txt\n\n`);
  const selected = await selectEvidence(source, "Explain alpha.", { artifactPath: "/tmp/full-source.txt" });
  assert.ok(selected !== source);
  assert.ok(selected.includes("SUMMARY_DETAIL"));
  assert.ok(selected.includes(code));
  assert.ok(selected.includes("Error: The request failed."));
  assert.ok(selected.includes("Artifact: /tmp/evidence.txt"));
});

test("uncertain scores keep evidence", async (t) => {
  const { evaluate } = setup(t);
  evaluate.mock.mockImplementation(async (_feature: JevFeature, state: any) => Object.fromEntries(
    state.chunks.map((chunk: any) => [chunk.id, 0.4]),
  ));
  assert.equal(await selectEvidence(document, "alpha", { artifactPath: "/tmp/full.txt" }), document);
});

test("missing keys and child sessions keep output without a request", async (t) => {
  const { evaluate } = setup(t);
  for (const dependencies of [{ env: {}, depth: 0 }, { env: { TYPESAFE_API_KEY: "test-key-only" }, depth: 1 }]) {
    const isolated = new JevClient({ ...JEV_CONFIG, enabled: "auto", mode: "active" }, dependencies);
    t.mock.method(jev, "canUse", (feature: JevFeature) => isolated.canUse(feature));
    assert.equal(await selectEvidence(document, "alpha", { artifactPath: "/tmp/full.txt" }), document);
  }
  assert.equal(evaluate.mock.calls.length, 0);
});

test("shadow mode records a decision but preserves output and creates no artifact", async (t) => {
  const { evaluate, action } = setup(t, "shadow");
  let saved = false;
  const selected = await selectEvidence(document, "alpha", {
    saveOriginal: async () => { saved = true; return "/tmp/full.txt"; },
  });
  assert.equal(selected, document);
  assert.equal(evaluate.mock.calls.length, 1);
  assert.equal(action.mock.calls.length, 0);
  assert.equal(saved, false);
});

test("invalid, missing, and failed decisions keep the exact output", async (t) => {
  const { evaluate } = setup(t);
  for (const value of [undefined, {}, { chunk_0: 1 }, { chunk_0: NaN }]) {
    evaluate.mock.mockImplementation(async () => value as any);
    assert.equal(await selectEvidence(document, "alpha", { artifactPath: "/tmp/full.txt" }), document);
  }
  evaluate.mock.mockImplementation(async () => { throw new Error("offline"); });
  assert.equal(await selectEvidence(document, "alpha", { artifactPath: "/tmp/full.txt" }), document);
});

test("small, oversized, unbounded, and cancelled input skips selection", async (t) => {
  const { evaluate } = setup(t);
  for (const source of ["short", document.repeat(3), "x".repeat(8_000), `\`\`\`\n${document}`]) {
    assert.equal(await selectEvidence(source, "alpha", { artifactPath: "/tmp/full.txt" }), source);
  }
  assert.equal(await selectEvidence(document, "alpha"), document);
  assert.equal(await selectEvidence(document, "alpha", {
    artifactPath: "/tmp/full.txt", signal: AbortSignal.abort(),
  }), document);
  JEV_CONFIG.maxInputChars = document.length + 100;
  assert.equal(await selectEvidence(document, "alpha", { artifactPath: "/tmp/full.txt" }), document);
  assert.equal(evaluate.mock.calls.length, 0);
});

test("failed artifact writes and cancellation after a decision preserve output", async (t) => {
  const { evaluate } = setup(t);
  assert.equal(await selectEvidence(document, "alpha", {
    saveOriginal: async () => { throw new Error("disk full"); },
  }), document);
  const controller = new AbortController();
  evaluate.mock.mockImplementation(async (_feature: JevFeature, state: any) => {
    controller.abort();
    return Object.fromEntries(state.chunks.map((chunk: any) => [chunk.id, 0]));
  });
  assert.equal(await selectEvidence(document, "alpha", {
    artifactPath: "/tmp/full.txt", signal: controller.signal,
  }), document);
});

test("task_output selects by the child prompt and preserves status, usage, and full output", async (t) => {
  const { calls } = setup(t);
  const directory = await temporaryDirectory(t);
  const record = {
    id: "child-test", type: "subagent", status: "completed", description: "Compare the source topics",
    prompt: "Explain alpha.", output: document, startedAt: 1, endedAt: 1001,
    usage: { turns: 2, cost: 0.125 }, transcriptPath: join(directory, "child.jsonl"),
  };
  const definitions = new Map<string, any>();
  registerTaskTools({
    pi: { registerTool: (definition: any) => definitions.set(definition.name, definition) } as any,
    registry: { list: () => [record], readTree: () => [record] } as any,
  });
  const tool = definitions.get("task_output");
  const result = await tool.execute("test-call", { wait: false });
  assert.equal(calls[0].state.context, record.prompt);
  assert.ok(result.content[0].text.includes("child-test (subagent) completed"));
  assert.ok(result.content[0].text.includes("2 turns"));
  assert.ok(result.content[0].text.includes("$0.1250"));
  assert.ok(!result.content[0].text.includes("BETA_ONE"));
  const path = result.content[0].text.match(/Read the full output at: ([^\]]+)/)[1];
  assert.equal(await readFile(path, "utf8"), document);
  const focused = await tool.execute("next-call", { wait: false, focus: "Explain beta." });
  assert.ok(focused.content[0].text.includes("BETA_ONE"));
  assert.ok(!focused.content[0].text.includes("ALPHA_ONE"));
});

test("web_fetch caches normal text and applies the current focus on every call", async (t) => {
  const { calls } = setup(t);
  const lookup = t.mock.method(dns, "lookup", async (..._args: any[]): Promise<any> => [{ address: "93.184.216.34", family: 4 }]);
  syncBuiltinESMExports();
  t.after(() => { lookup.mock.restore(); syncBuiltinESMExports(); });
  const { registerWebFetch } = await import("../src/web/fetch");
  let fetches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    fetches++;
    return new Response(document, { status: 200, headers: { "content-type": "text/plain" } });
  });
  const directory = await temporaryDirectory(t);
  const ctx = { sessionManager: { getSessionFile: () => join(directory, "session.jsonl") } };
  const handlers = new Map<string, any>();
  let tool: any;
  registerWebFetch({ on: (name: string, handler: any) => handlers.set(name, handler), registerTool: (definition: any) => { tool = definition; } } as any);
  handlers.get("input")({ source: "interactive", text: "Explain alpha." });
  const url = "https://developer.mozilla.org/jev-fixture";
  const alpha = await tool.execute("alpha", { url }, undefined, undefined, ctx);
  const beta = await tool.execute("beta", { url, focus: "Explain beta." }, undefined, undefined, ctx);
  assert.equal(fetches, 1);
  assert.equal(calls.length, 2);
  assert.ok(alpha.content[0].text.includes("ALPHA_ONE"));
  assert.ok(!alpha.content[0].text.includes("BETA_ONE"));
  assert.ok(beta.content[0].text.includes("BETA_ONE"));
  assert.ok(!beta.content[0].text.includes("ALPHA_ONE"));
  assert.equal(beta.details.path, "cache");
  const path = beta.content[0].text.match(/Read the full output at: ([^\]]+)/)[1];
  assert.equal(await readFile(path, "utf8"), document.trim());
  t.mock.method(jev, "canUse", () => false);
  const plain = await tool.execute("plain", { url }, undefined, undefined, ctx);
  assert.equal(plain.content[0].text, document.trim());
  assert.equal(plain.details.jevExcerpt, undefined);
});
