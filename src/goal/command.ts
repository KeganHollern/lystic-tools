/**
 * /goal command. Humans start goals; the agent never does.
 *
 *   /goal <objective>   start a goal (planner runs first)
 *   /goal               show status
 *   /goal pause         pause (manual — needs /goal resume)
 *   /goal resume        continue a paused goal
 *   /goal clear         drop the goal, kill its roles, delete the folder
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { GoalControl } from "./loop";

const VERBS = new Set(["status", "pause", "resume", "clear"]);

export function registerGoalCommand(pi: ExtensionAPI, control: GoalControl): void {
  pi.registerCommand("goal", {
    description: "Start or manage an autonomous goal (status | pause | resume | clear)",
    handler: async (args, ctx) => {
      const trimmed = args.trim();

      if (!trimmed || trimmed === "status") {
        ctx.ui.notify(control.statusText(), "info");
        return;
      }

      if (trimmed === "pause") {
        ctx.ui.notify(control.pause(), "info");
        return;
      }

      if (trimmed === "resume") {
        ctx.ui.notify(control.resume(), "info");
        return;
      }

      if (trimmed === "clear") {
        ctx.ui.notify(control.clear(), "info");
        return;
      }

      if (VERBS.has(trimmed.split(/\s+/)[0])) {
        ctx.ui.notify(`Unknown /goal verb. Use status, pause, resume, or clear.`, "error");
        return;
      }

      // Start a new goal.
      const startError = control.startError();
      if (startError) {
        ctx.ui.notify(startError, "error");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("The agent is busy. Start the goal when it is idle.", "error");
        return;
      }

      let baselineCommit: string | undefined;
      try {
        const result = await pi.exec("git", ["rev-parse", "HEAD"], {
          cwd: ctx.cwd,
          timeout: 5000,
        });
        if (result.code === 0) baselineCommit = result.stdout.trim();
      } catch {
        /* not a git repo */
      }

      control.start(trimmed, baselineCommit);
    },
  });
}
