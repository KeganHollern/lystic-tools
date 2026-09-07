/**
 * goal_update: the worker's only signal channel. Registered once at load
 * (depth 0 only), but it sits OUTSIDE the active tool set until a goal
 * starts — no 24/7 context bloat. Only the user starts goals (/goal).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { GOAL_BLOCKED_IDEA_EVERY, GOAL_BLOCKED_PAUSE } from "../config";
import type { GoalState } from "./state";

export const GOAL_TOOL = "goal_update";

export interface GoalToolDeps {
  getGoal: () => GoalState | undefined;
  save: (goal: GoalState) => void;
  /** Called when the blocked streak pauses the goal. */
  onPaused: (goal: GoalState) => void;
  /** Called when the blocked streak hits the idea-guy cadence (3, 6, 9). */
  onIdeaNeeded: (goal: GoalState) => void;
}

export function registerGoalTool(pi: ExtensionAPI, deps: GoalToolDeps): void {
  pi.registerTool({
    name: GOAL_TOOL,
    label: "Goal Update",
    description:
      "Report progress on the active goal. Only the user starts goals (the /goal command); " +
      "this tool never starts one. completed: true claims the objective is met — a skeptic panel " +
      "verifies at turn end and sends back gaps. blocked_reason reports a hard blocker. " +
      "message logs a short status note.",
    parameters: Type.Object({
      completed: Type.Optional(Type.Boolean({ description: "Claim the goal is complete. Triggers verification." })),
      message: Type.Optional(Type.String({ description: "Short summary (with completed) or status note." })),
      blocked_reason: Type.Optional(Type.String({ description: "You are hard-blocked; say why." })),
    }),
    async execute(_toolCallId, params) {
      const goal = deps.getGoal();
      if (!goal) {
        return { content: [{ type: "text", text: "No active goal. Only the user starts goals with /goal." }] };
      }
      if (goal.status === "verifying") {
        return { content: [{ type: "text", text: "The skeptic panel is running. Wait for its verdict; it arrives as the next round reminder." }] };
      }
      if (goal.status === "paused") {
        return { content: [{ type: "text", text: `The goal is paused (${goal.pauseReason ?? "user"}). The user must run /goal resume.` }] };
      }
      if (goal.status !== "executing") {
        return { content: [{ type: "text", text: "The plan is still being drafted. Keep working or wait for the kickoff round." }] };
      }

      if (params.completed) {
        if (goal.pendingCompletion || goal.status === "verifying") {
          return { content: [{ type: "text", text: "Verification is already pending or running. Keep working or wait." }] };
        }
        goal.pendingCompletion = true;
        goal.completedMessage = params.message ?? "(no message)";
        goal.consecutiveBlocked = 0;
        deps.save(goal);
        return {
          content: [{ type: "text", text: "Completion claim recorded. The skeptic panel runs when this turn settles." }],
        };
      }

      if (params.blocked_reason) {
        goal.consecutiveBlocked++;
        goal.notes.push({ t: Date.now(), text: `blocked: ${params.blocked_reason}` });
        if (goal.consecutiveBlocked >= GOAL_BLOCKED_PAUSE) {
          goal.status = "paused";
          goal.pauseReason = "blocked";
          goal.pauseDetail = `Blocked ${goal.consecutiveBlocked}x: ${params.blocked_reason}`;
          deps.save(goal);
          deps.onPaused(goal);
          return {
            content: [{ type: "text", text: `Goal paused after ${goal.consecutiveBlocked} blocked reports. The user can run /goal resume.` }],
          };
        }
        if (goal.consecutiveBlocked % GOAL_BLOCKED_IDEA_EVERY === 0) {
          deps.onIdeaNeeded(goal);
          return {
            content: [{
              type: "text",
              text: `Blocked report ${goal.consecutiveBlocked}/${GOAL_BLOCKED_PAUSE}. The idea guy is fetching ways to unblock; they arrive with the next round.`,
            }],
          };
        }
        deps.save(goal);
        return {
          content: [{ type: "text", text: `Blocked report ${goal.consecutiveBlocked}/${GOAL_BLOCKED_PAUSE}. Try a different approach.` }],
        };
      }

      if (params.message) {
        goal.notes.push({ t: Date.now(), text: params.message.slice(0, 200) });
        if (goal.notes.length > 20) goal.notes.splice(0, goal.notes.length - 20);
        goal.consecutiveBlocked = 0;
        deps.save(goal);
        return { content: [{ type: "text", text: "Noted." }] };
      }

      return { content: [{ type: "text", text: "Nothing to do. Use completed, message, or blocked_reason." }] };
    },
  });
}

export function activateGoalTool(pi: ExtensionAPI): void {
  pi.setActiveTools([...new Set([...pi.getActiveTools(), GOAL_TOOL])]);
}

export function deactivateGoalTool(pi: ExtensionAPI): void {
  pi.setActiveTools(pi.getActiveTools().filter((n) => n !== GOAL_TOOL));
}
