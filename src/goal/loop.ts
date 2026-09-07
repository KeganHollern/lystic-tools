/**
 * Goal loop: the harness side of /goal.
 *
 * Everything hangs off `agent_settled`. When the worker and every subagent
 * are idle, the loop advances the state machine: inject the next round,
 * run the skeptic panel on a completion claim, fetch ideas after repeated
 * refutations, summarize on a pass, pause on tokens/blockers/idle.
 *
 * Goal-role subagents (planner/skeptic/idea/summary) never wake the worker
 * directly — the loop owns all timing (delayed re-checks cover the 1s
 * registry poll granularity).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  GOAL_ENABLED,
  GOAL_IDEA_AFTER,
  SUBAGENT_DEPTH,
} from "../config";
import type { SubagentRegistry } from "../subagents/registry";
import { spawnBackground } from "../subagents/spawn";
import type { ChildRecord } from "../subagents/types";
import { ideaPrompt, kickoffPrompt, roundPrompt, summaryPrompt, plannerPrompt } from "./prompts";
import {
  classifyError,
  deleteGoal,
  goalDirFor,
  goalIdForSession,
  isActive,
  isGoalRoleType,
  loadGoal,
  planPath,
  saveGoal,
  type GoalState,
  type PauseReason,
} from "./state";
import { activateGoalTool, deactivateGoalTool, GOAL_TOOL, registerGoalTool } from "./tool";
import { aggregatePanel, spawnPanel } from "./verify";

const IDLE_ROUNDS_LIMIT = 3;
/** Max chars of idea-guy text quoted into a round reminder. */
const IDEA_TEXT_CAP = 4000;

export interface GoalFeatureDeps {
  registry: SubagentRegistry;
}

let thePi: ExtensionAPI | undefined;
let theRegistry: SubagentRegistry | undefined;
let sessionFile: string | undefined;
let cwd = process.cwd();
let model: string | undefined;
let thinkingLevel: string | undefined;

// Per-run signals.
let providerError = false;
let lastErrorMessage = "";
let compactFailed = false;
let toolCallsThisRound = 0;
let goalUpdateThisRound = false;
let userTurn = false;
let expectingRoundSettle = false;
let roundInFlight = false;
let settling = false;

let notifyChange: ((record: ChildRecord, info: { fromRunning: boolean }) => void) | null = null;

// User messages that arrive while the planner runs. They are held back
// from the model and steered into the kickoff round instead.
const queuedUserInput: string[] = [];

function flushQueuedInput(reason: string): void {
  if (queuedUserInput.length === 0) return;
  const text = queuedUserInput.join("\n\n---\n\n");
  queuedUserInput.length = 0;
  notice(`Queued user message not delivered (${reason}):
${text}`, "warning");
}

/** Wired into the registry onChange in index.ts; no-op until registered. */
export function goalNotify(record: ChildRecord, info: { fromRunning: boolean }): void {
  notifyChange?.(record, info);
}

function load(): GoalState | undefined {
  const id = goalIdForSession(sessionFile);
  return id ? loadGoal(id) : undefined;
}

function save(goal: GoalState): void {
  saveGoal(goal);
}

function spawnRole(
  kind: "goal-planner" | "goal-idea" | "goal-summary",
  description: string,
  prompt: string,
): string {
  const record = theRegistry!.newRecord({
    type: kind,
    description,
    prompt,
    depth: SUBAGENT_DEPTH + 1,
    background: true,
    cwd,
    model,
  });
  const handle = spawnBackground({
    prompt,
    cwd,
    depth: SUBAGENT_DEPTH,
    childId: record.id,
    registryFile: theRegistry!.registryFile,
    parentModel: model,
    parentThinkingLevel: thinkingLevel,
    transcriptPath: record.transcriptPath,
    sessionPath: record.sessionPath!,
  });
  theRegistry!.update(record.id, { pid: handle.pid });
  theRegistry!.startWatcher(record.id);
  return record.id;
}

function findRecord(id: string | undefined): ChildRecord | undefined {
  if (!id || !theRegistry) return undefined;
  return theRegistry.get(id) ?? theRegistry.readTree().find((r) => r.id === id);
}

function isBusy(record: ChildRecord | undefined): boolean {
  return record?.status === "running" || record?.status === "waiting";
}

function notice(text: string, kind: "info" | "warning" | "error" = "info"): void {
  thePi?.sendMessage(
    { customType: "goal_notice", content: text, display: true, details: { kind } },
    {},
  );
}

function injectRound(goal: GoalState, kickoff: boolean, queuedInput?: string): void {
  const dir = goalDirFor(goal.id);
  const prompt = kickoff
    ? kickoffPrompt(goal, dir, queuedInput)
    : roundPrompt(goal, dir);
  // Ideas ride exactly one reminder; do not re-send stale text in later rounds.
  if (goal.ideasText) {
    goal.ideasText = undefined;
    save(goal);
  }
  expectingRoundSettle = true;
  roundInFlight = true;
  toolCallsThisRound = 0;
  goalUpdateThisRound = false;
  thePi?.sendMessage(
    {
      customType: "goal_round",
      content: prompt,
      display: true,
      details: { round: goal.round, objective: goal.objective, kickoff },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

function pauseGoal(goal: GoalState, reason: PauseReason, detail: string): void {
  flushQueuedInput(`goal paused: ${reason}`);
  goal.status = "paused";
  goal.pauseReason = reason;
  goal.pauseDetail = detail.slice(0, 300);
  goal.userSpokeSincePause = false;
  save(goal);
  if (reason === "tokens") {
    notice(`Goal paused: out of tokens/context (${detail}). When tokens are back, send any message or run /goal resume.`, "warning");
  } else {
    notice(`Goal paused: ${detail}. Run /goal resume to continue.`, "warning");
  }
}

function resetRunSignals(): void {
  providerError = false;
  lastErrorMessage = "";
  compactFailed = false;
  toolCallsThisRound = 0;
  goalUpdateThisRound = false;
  userTurn = false;
  expectingRoundSettle = false;
}

function settle(fromSettled = false): void {
  if (settling) return;
  settling = true;
  try {
    settleInner(fromSettled);
  } finally {
    settling = false;
  }
}

function settleInner(fromSettled: boolean): void {
  const goal = load();
  if (!goal || goal.status === "achieved") return;

  // A round turn is streaming: only the settle that follows its end may
  // advance the loop. Timer pokes while it runs must not double-inject.
  if (roundInFlight && !fromSettled) return;
  if (fromSettled) roundInFlight = false;

  // Paused: only the tokens pause auto-resumes (on the next user message).
  if (goal.status === "paused") {
    if (goal.pauseReason === "tokens" && goal.userSpokeSincePause) {
      goal.status = goal.pendingCompletion ? "verifying" : "executing";
      goal.pauseReason = undefined;
      goal.pauseDetail = undefined;
      goal.userSpokeSincePause = false;
      goal.idleRounds = 0;
      resetRunSignals();
      save(goal);
      notice("Goal resumed (tokens back).");
    } else {
      return;
    }
  }

  // Token / provider exhaustion at the worker level.
  if ((providerError || compactFailed) && (goal.status === "executing" || goal.status === "planning")) {
    const detail = compactFailed
      ? "context overflow; compaction failed"
      : lastErrorMessage || "model error";
    pauseGoal(goal, classifyError(detail), detail);
    resetRunSignals();
    return;
  }

  // Planning: wait for the planner, then kick off round 1.
  if (goal.status === "planning") {
    if (!goal.plannerId) return; // start() is still mid-spawn
    const planner = findRecord(goal.plannerId);
    if (isBusy(planner)) return;
    const plan = planPath(goalDirFor(goal.id));
    const planReady =
      planner?.status === "completed" &&
      fs.existsSync(plan) &&
      fs.statSync(plan).size > 0;
    if (!planReady) {
      pauseGoal(goal, "error", "planning failed — no plan file was produced");
      return;
    }
    try {
      const baselinePath = `${plan}.baseline`;
      if (!fs.existsSync(baselinePath)) fs.copyFileSync(plan, baselinePath);
    } catch { /* best effort */ }
    goal.status = "executing";
    goal.round = 1;
    goal.gaps = [];
    save(goal);
    activateGoalTool(thePi!);
    notice(`Plan ready. Worker starts (goal ${goal.id}).`);
    const queued = queuedUserInput.join("\n\n---\n\n");
    queuedUserInput.length = 0;
    injectRound(goal, true, queued || undefined);
    return;
  }

  // Verifying: aggregate the panel; on pass, summarize then finish.
  if (goal.status === "verifying") {
    const outcome = aggregatePanel(goal, theRegistry!);
    if (outcome.kind === "pending") return;
    if (outcome.kind === "dead") {
      pauseGoal(goal, classifyError(outcome.reason), `skeptic panel failed: ${outcome.reason}`);
      return;
    }
    if (outcome.kind === "pass") {
      if (!goal.summaryId) {
        goal.summaryId = spawnRole(
          "goal-summary",
          "write the goal summary",
          summaryPrompt(goal, goalDirFor(goal.id)),
        );
        save(goal);
        notice("Verification passed. Writing the closing summary...");
        return;
      }
      const summary = findRecord(goal.summaryId);
      if (isBusy(summary)) return;
      const text =
        summary?.output && summary.output !== "(no output)"
          ? summary.output
          : goal.completedMessage ?? "(no summary)";
      goal.status = "achieved";
      goal.endedAt = Date.now();
      save(goal);
      deactivateGoalTool(thePi!);
      thePi?.sendMessage(
        {
          customType: "goal_achieved",
          content: text,
          display: true,
          details: { objective: goal.objective, failedVerifications: goal.failedVerifications },
        },
        {},
      );
      return;
    }
    // Refuted: record gaps; every Nth failure fetches untried ideas first.
    goal.failedVerifications++;
    goal.gaps = outcome.gaps;
    goal.pendingCompletion = false;
    goal.status = "executing";
    if (goal.failedVerifications % GOAL_IDEA_AFTER === 0 && !goal.ideasPending) {
      goal.ideasPending = true;
      goal.ideasText = undefined;
      goal.ideaId = spawnRole(
        "goal-idea",
        "suggest untried ideas",
        ideaPrompt(goal, goalDirFor(goal.id)),
      );
      save(goal);
      notice(`Refuted (attempt ${goal.failedVerifications}). Fetching untried ideas...`, "warning");
      return;
    }
    if (goal.ideasPending && goal.ideaId) {
      const idea = findRecord(goal.ideaId);
      if (isBusy(idea)) return;
      goal.ideasPending = false;
      goal.ideasText =
        idea?.output && idea.output !== "(no output)"
          ? idea.output.slice(0, IDEA_TEXT_CAP)
          : undefined;
      save(goal);
    }
    goal.round++;
    save(goal);
    injectRound(goal, false);
    notice(`Refuted (attempt ${goal.failedVerifications}). Gaps sent to the worker.`, "warning");
    return;
  }

  // Executing.
  if (goal.pendingCompletion) {
    goal.status = "verifying";
    spawnPanel({ registry: theRegistry!, cwd, model, thinkingLevel }, goal);
    save(goal);
    notice(`Completion claim — skeptic panel running (attempt ${goal.panelAttempt}).`);
    return;
  }

  // A blocked-streak idea guy may still be running; his ideas ride the
  // next round reminder, so wait for him before injecting.
  if (goal.ideasPending && goal.ideaId) {
    const idea = findRecord(goal.ideaId);
    if (isBusy(idea)) return;
    goal.ideasPending = false;
    goal.ideasText =
      idea?.output && idea.output !== "(no output)"
        ? idea.output.slice(0, IDEA_TEXT_CAP)
        : undefined;
    save(goal);
  }

  // Everyone idle? (This session's whole tree, any type.)
  const busy = theRegistry!.readTree().some((r) => r.status === "running" || r.status === "waiting");
  if (busy) return;

  // No-progress guard: only judges turns the loop itself injected.
  if (expectingRoundSettle) {
    if (userTurn) goal.idleRounds = 0;
    else if (toolCallsThisRound === 0 && !goalUpdateThisRound) goal.idleRounds++;
    else goal.idleRounds = 0;
    expectingRoundSettle = false;
    userTurn = false;
    if (goal.idleRounds >= IDLE_ROUNDS_LIMIT) {
      pauseGoal(goal, "error", `${IDLE_ROUNDS_LIMIT} rounds with no tool calls and no goal_update. Steer the worker or check the plan.`);
      return;
    }
  }

  goal.round++;
  save(goal);
  injectRound(goal, false);
}

// ─── Public control surface (used by /goal command) ────────────────────────

export interface GoalControl {
  statusText(): string;
  startError(): string | null;
  start(objective: string, baselineCommit: string | undefined): void;
  pause(): string;
  resume(): string;
  clear(): string;
}

export function createGoalControl(): GoalControl {
  return {
    statusText(): string {
      const goal = load();
      if (!goal) return "No goal in this session. Start one: /goal <objective>";
      const lines = [
        `Objective: ${goal.objective}`,
        `Status: ${goal.status}${goal.pauseReason ? ` (${goal.pauseReason}: ${goal.pauseDetail ?? ""})` : ""}`,
        `Round: ${goal.round} · failed verifications: ${goal.failedVerifications}`,
      ];
      if (goal.gaps.length) lines.push(`Open gaps: ${goal.gaps.length}`);
      lines.push(`Plan: ${planPath(goalDirFor(goal.id))}`);
      return lines.join("\n");
    },

    startError(): string | null {
      const id = goalIdForSession(sessionFile);
      if (!id) return "This session has no file; goals need a saved session.";
      if (isActive(load())) return "A goal is already active here. /goal clear first.";
      return null;
    },

    start(objective: string, baselineCommit: string | undefined): void {
      const id = goalIdForSession(sessionFile)!;
      const dir = goalDirFor(id);
      // A previous goal in this session may have left artifacts; the plan,
      // its baseline, and old ideas must not leak into the new goal.
      for (const stale of [planPath(dir), `${planPath(dir)}.baseline`, path.join(dir, "ideas.md")]) {
        try { fs.unlinkSync(stale); } catch { /* not there */ }
      }
      const goal: GoalState = {
        id,
        objective,
        status: "planning",
        createdAt: Date.now(),
        round: 0,
        pendingCompletion: false,
        failedVerifications: 0,
        consecutiveBlocked: 0,
        idleRounds: 0,
        userSpokeSincePause: false,
        baselineCommit,
        panelIds: [],
        panelAttempt: 0,
        ideasPending: false,
        gaps: [],
        notes: [],
      };
      save(goal);
      resetRunSignals();
      goal.plannerId = spawnRole("goal-planner", "draft the goal plan", plannerPrompt(objective, goalDirFor(id)));
      save(goal);
      notice(`Goal started: ${objective}`);
    },

    pause(): string {
      const goal = load();
      if (!goal || !isActive(goal)) return "No active goal.";
      if (goal.status === "paused") return "Goal is already paused.";
      goal.status = "paused";
      goal.pauseReason = "user";
      goal.pauseDetail = "paused by the user";
      goal.userSpokeSincePause = false;
      save(goal);
      return "Goal paused. /goal resume continues it.";
    },

    resume(): string {
      const goal = load();
      if (!goal || goal.status !== "paused") return "No paused goal.";
      goal.status = goal.pendingCompletion
        ? "verifying"
        : isBusy(findRecord(goal.plannerId)) || (goal.round === 0 && goal.plannerId)
          ? "planning"
          : "executing";
      goal.pauseReason = undefined;
      goal.pauseDetail = undefined;
      goal.userSpokeSincePause = false;
      save(goal);
      resetRunSignals();
      setTimeout(() => settle(), 50);
      return "Goal resumed.";
    },

    clear(): string {
      const goal = load();
      if (!goal) return "No goal to clear.";
      for (const id of [goal.plannerId, goal.ideaId, goal.summaryId, ...goal.panelIds]) {
        const rec = findRecord(id);
        if (rec && isBusy(rec)) theRegistry?.kill(rec.id);
      }
      deleteGoal(goal.id);
      deactivateGoalTool(thePi!);
      resetRunSignals();
      flushQueuedInput("goal cleared");
      return "Goal cleared (subagent logs stay in /tasks; goal folder deleted).";
    },
  };
}

export function pokeSettle(): void {
  settle();
}

// ─── Registration ───────────────────────────────────────────────────────────

export function registerGoalFeature(pi: ExtensionAPI, deps: GoalFeatureDeps): void {
  if (!GOAL_ENABLED || SUBAGENT_DEPTH !== 0) return;
  thePi = pi;
  theRegistry = deps.registry;

  registerGoalTool(pi, {
    getGoal: () => load(),
    save,
    onPaused: (goal) => {
      flushQueuedInput("goal paused: blocked");
      notice(`Goal paused: ${goal.pauseDetail ?? "blocked"}. Run /goal resume to continue.`, "warning");
    },
    onIdeaNeeded: (goal) => {
      goal.ideasPending = true;
      goal.ideasText = undefined;
      goal.ideaId = spawnRole(
        "goal-idea",
        "suggest ways to unblock",
        ideaPrompt(goal, goalDirFor(goal.id), "blocked"),
      );
      save(goal);
      notice(`Blocked ${goal.consecutiveBlocked}x — the idea guy is looking for ways to unblock...`, "warning");
    },
  });
  // The tool stays OUT of the active set until a goal's plan is ready.

  pi.on("session_start", (event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile() ?? undefined;
    cwd = ctx.cwd;
    model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    thinkingLevel = ctx.thinkingLevel;
    resetRunSignals();
    const goal = load();
    if (goal && isActive(goal)) {
      // The active tool set resets on reload; restore goal_update when the
      // worker is already past the planner.
      if (goal.status === "executing" || goal.status === "verifying") {
        activateGoalTool(pi);
      }
      setTimeout(() => settle(false), 1500);
    }
  });

  pi.on("model_select", (event) => {
    model = `${event.model.provider}/${event.model.id}`;
  });

  pi.on("message_end", (event) => {
    const msg = (event as any).message;
    if (msg?.role !== "assistant") return;
    if (msg.stopReason === "error") {
      providerError = true;
      lastErrorMessage = msg.errorMessage ?? "";
    } else {
      providerError = false;
    }
  });

  pi.on("session_compact_failed", (event) => {
    const e = event as any;
    if (e?.willRetry === false) compactFailed = true;
  });

  pi.on("tool_call", (event) => {
    toolCallsThisRound++;
    if ((event as any).toolName === GOAL_TOOL) goalUpdateThisRound = true;
  });

  pi.on("input", (event, ctx) => {
    const e = event as any;
    if (e?.source && e.source !== "extension") {
      const goal = load();
      // While the planner runs, hold user messages back; they steer into
      // the kickoff round so the worker sees them in context.
      if (goal && goal.status === "planning" && !(e.images && e.images.length)) {
        queuedUserInput.push(String(e.text ?? ""));
        ctx.ui.notify("Queued for the goal worker — it steers in at kickoff.", "info");
        return { action: "handled" };
      }
      userTurn = true;
      if (goal?.status === "paused") {
        goal.userSpokeSincePause = true;
        save(goal);
      }
    }
  });

  pi.on("agent_settled", () => settle(true));

  notifyChange = (record, info) => {
    if (info.fromRunning && isGoalRoleType(record.type)) {
      // The registry polls at 1s; give it room, then re-drive the loop.
      setTimeout(() => settle(false), 2500);
    }
  };

  // ─── Renderers ────────────────────────────────────────────────────────────

  pi.registerMessageRenderer("goal_round", (message, { expanded }, theme) => {
    const d = (message.details ?? {}) as { round?: number; objective?: string };
    const box = new Box(1, 0);
    box.addChild(
      new Text(
        `${theme.fg("accent", "◈")} ${theme.fg("toolTitle", theme.bold(`goal round ${d.round ?? "?"}`))}  ${theme.fg("muted", (d.objective ?? "").slice(0, 60))}`,
        0,
        0,
      ),
    );
    if (expanded) {
      const raw = typeof message.content === "string" ? message.content : "";
      box.addChild(new Text(raw.replace(/<\/?system-reminder>/g, "").trim(), 0, 0));
    }
    return box;
  });

  pi.registerMessageRenderer("goal_notice", (message, _options, theme) => {
    const d = (message.details ?? {}) as { kind?: string };
    const color = d.kind === "warning" ? "warning" : d.kind === "error" ? "error" : "accent";
    return new Text(
      `${theme.fg(color as any, "◈ goal")}  ${typeof message.content === "string" ? message.content : ""}`,
      0,
      0,
    );
  });

  pi.registerMessageRenderer("goal_achieved", (message, _options, theme) => {
    const box = new Box(1, 0);
    box.addChild(
      new Text(
        `${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold("goal achieved"))}  ${theme.fg("dim", "verified by the skeptic panel")}`,
        0,
        0,
      ),
    );
    const raw = typeof message.content === "string" ? message.content : "";
    box.addChild(new Markdown(raw, 0, 0, getMarkdownTheme(), {
      color: (c) => theme.fg("text", c),
    }));
    return box;
  });
}
