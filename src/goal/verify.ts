/**
 * Skeptic panel: spawn N adversarial verifier subagents, parse their JSON
 * verdicts, and decide pass / refuted / panel-dead.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { GOAL_SKEPTICS } from "../config";
import type { SubagentRegistry } from "../subagents/registry";
import { spawnBackground } from "../subagents/spawn";
import type { ChildRecord } from "../subagents/types";
import { skepticPrompt } from "./prompts";
import type { GoalState } from "./state";
import { goalDirFor } from "./state";

export interface SpawnDeps {
  registry: SubagentRegistry;
  cwd: string;
  model?: string;
  thinkingLevel?: string;
}

export function spawnPanel(deps: SpawnDeps, goal: GoalState): GoalState {
  const dir = goalDirFor(goal.id);
  goal.panelAttempt++;
  goal.panelIds = [];
  for (let i = 0; i < GOAL_SKEPTICS; i++) {
    const record = deps.registry.newRecord({
      type: "goal-skeptic",
      description: `verify attempt ${goal.panelAttempt} (${i + 1}/${GOAL_SKEPTICS})`,
      prompt: skepticPrompt(goal, dir, i, GOAL_SKEPTICS),
      depth: 1,
      background: true,
      cwd: deps.cwd,
      model: deps.model,
    });
    fs.mkdirSync(path.join(dir, "scratch", `skeptic-${i + 1}`), { recursive: true });
    const handle = spawnBackground({
      prompt: skepticPrompt(goal, dir, i, GOAL_SKEPTICS),
      cwd: deps.cwd,
      depth: 0,
      childId: record.id,
      registryFile: deps.registry.registryFile,
      parentModel: deps.model,
      parentThinkingLevel: deps.thinkingLevel,
      transcriptPath: record.transcriptPath,
      sessionPath: record.sessionPath!,
    });
    deps.registry.update(record.id, { pid: handle.pid });
    deps.registry.startWatcher(record.id);
    goal.panelIds.push(record.id);
  }
  return goal;
}

export interface Verdict {
  refuted: boolean;
  gaps: string[];
  details: string;
  parsed: boolean;
}

/** Parse the last JSON object in the skeptic's final output. */
export function parseVerdict(output: string | undefined): Verdict {
  const text = output ?? "";
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  const candidates = fenced.length
    ? fenced.map((m) => m[1])
    : [text];
  for (let i = candidates.length - 1; i >= 0; i--) {
    const block = candidates[i];
    const start = block.lastIndexOf("{");
    const end = block.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      const obj = JSON.parse(block.slice(start, end + 1));
      if (typeof obj === "object" && obj !== null && typeof obj.refuted === "boolean") {
        return {
          refuted: obj.refuted,
          gaps: Array.isArray(obj.gaps) ? obj.gaps.map(String).filter(Boolean).slice(0, 8) : [],
          details: typeof obj.details === "string" ? obj.details : "",
          parsed: true,
        };
      }
    } catch {
      /* try next */
    }
  }
  return { refuted: true, gaps: [], details: "", parsed: false };
}

export type PanelOutcome =
  | { kind: "pending" }
  | { kind: "pass" }
  | { kind: "refuted"; gaps: string[] }
  | { kind: "dead"; reason: string };

export function aggregatePanel(goal: GoalState, registry: SubagentRegistry): PanelOutcome {
  const records = goal.panelIds
    .map((id) => registry.get(id) ?? registry.readTree().find((r) => r.id === id))
    .filter((r): r is ChildRecord => Boolean(r));
  if (records.length === 0) return { kind: "dead", reason: "no panel records" };
  if (records.some((r) => r.status === "running" || r.status === "waiting")) {
    return { kind: "pending" };
  }

  // Panel-wide provider failure: every skeptic died with a model error.
  const allFailedWithError = records.every(
    (r) => r.status === "failed" && r.stopReason === "error",
  );
  if (allFailedWithError) {
    const msgs = records.map((r) => r.errorMessage).filter(Boolean).join("; ");
    return { kind: "dead", reason: msgs || "all skeptics failed with provider errors" };
  }

  const gaps: string[] = [];
  let refuted = false;
  records.forEach((r, i) => {
    const verdict = parseVerdict(r.output);
    if (!verdict.parsed) {
      refuted = true;
      gaps.push(`skeptic ${i + 1} returned no verdict (counts as refuted)`);
      return;
    }
    if (verdict.refuted) {
      refuted = true;
      for (const gap of verdict.gaps) gaps.push(gap);
      if (verdict.gaps.length === 0) gaps.push(verdict.details.slice(0, 200) || `skeptic ${i + 1} refuted without gaps`);
    }
  });

  const deduped = [...new Set(gaps.map((g) => g.trim()).filter(Boolean))].slice(0, 8);
  return refuted ? { kind: "refuted", gaps: deduped } : { kind: "pass" };
}
