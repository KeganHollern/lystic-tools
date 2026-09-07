/**
 * Goal state: one JSON file per session under ~/.pi/agent/goals/<goal-id>/.
 *
 * The goal id is the basename of the session file (extension stripped), so
 * /reload, /resume, and /fork each find their own goal. Sessions without a
 * file (ephemeral) cannot hold goals.
 *
 * All writes go through this module with synchronous fs calls, so parallel
 * tool calls in one batch cannot lose updates.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { homedir } from "node:os";

export type GoalStatus = "planning" | "executing" | "verifying" | "achieved" | "paused";
export type PauseReason = "user" | "blocked" | "tokens" | "error";

export interface GoalNote {
  t: number;
  text: string;
}

export interface GoalState {
  id: string;
  objective: string;
  status: GoalStatus;
  pauseReason?: PauseReason;
  pauseDetail?: string;
  createdAt: number;
  endedAt?: number;
  /** Last round number injected into the worker. */
  round: number;
  pendingCompletion: boolean;
  completedMessage?: string;
  failedVerifications: number;
  consecutiveBlocked: number;
  /** Consecutive injected rounds with zero tool calls and no goal_update. */
  idleRounds: number;
  userSpokeSincePause: boolean;
  baselineCommit?: string;
  plannerId?: string;
  panelIds: string[];
  panelAttempt: number;
  ideaId?: string;
  ideasPending: boolean;
  ideasText?: string;
  summaryId?: string;
  gaps: string[];
  notes: GoalNote[];
}

export function goalsRoot(): string {
  return process.env.PI_CODING_AGENT_DIR ?? path.join(homedir(), ".pi", "agent");
}

export function goalDirFor(goalId: string): string {
  return path.join(goalsRoot(), "goals", goalId);
}

export function goalIdForSession(sessionFile: string | undefined): string | undefined {
  if (!sessionFile) return undefined;
  return path.basename(sessionFile).replace(/\.(jsonl?|session\.jsonl)$/i, "");
}

export function planPath(dir: string): string {
  return path.join(dir, "plan.md");
}

export function statePath(dir: string): string {
  return path.join(dir, "state.json");
}

export function loadGoal(goalId: string): GoalState | undefined {
  try {
    const raw = fs.readFileSync(statePath(goalDirFor(goalId)), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as GoalState) : undefined;
  } catch {
    return undefined;
  }
}

export function saveGoal(goal: GoalState): void {
  const dir = goalDirFor(goal.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, "scratch", "implementer"), { recursive: true });
  const tmp = statePath(dir) + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(goal, null, 2));
  fs.renameSync(tmp, statePath(dir));
}

export function deleteGoal(goalId: string): void {
  try {
    fs.rmSync(goalDirFor(goalId), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

export function isActive(goal: GoalState | undefined): boolean {
  return Boolean(goal && goal.status !== "achieved");
}

export function isGoalRoleType(type: string | undefined): boolean {
  return typeof type === "string" && type.startsWith("goal-");
}

/** Classify an error message into a pause reason. */
export function classifyError(message: string | undefined): PauseReason {
  const m = (message ?? "").toLowerCase();
  if (/(429|402|403|rate.?limit|quota|credit|usage.?limit|insufficient)/.test(m)) return "tokens";
  return "error";
}
