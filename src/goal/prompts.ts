/**
 * Prompt templates for the goal roles. Every role is a plain subagent with
 * the full tool set; the read-only rules (plan, ideas.md) are prompt rules,
 * not enforced.
 */

import * as path from "node:path";
import { GOAL_BLOCKED_PAUSE } from "../config";
import type { GoalState } from "./state";
import { planPath } from "./state";

export function plannerPrompt(objective: string, dir: string): string {
  return [
    "You are the goal planner for this workspace.",
    "",
    `OBJECTIVE (verbatim, from the user): ${objective}`,
    "",
    `Write a plan file at ${planPath(dir)} with EXACTLY these sections:`,
    "",
    "  # Goal plan",
    "  ## Goal kind",
    "  Either `code` (the deliverable is changed files) or `prose` (the deliverable is written research or analysis).",
    "  ## Acceptance criteria",
    "  3 to 5 gating criteria. One outcome each. Anchor them to the LITERAL objective: do not invent scope.",
    "  A reasonable-but-unrequested feature belongs under Non-goals, never here.",
    "  ## Verification plan",
    "  Numbered runnable steps. For each step, state the command and the output observation that must hold.",
    "  These steps are what the worker must run and capture before claiming completion.",
    "  ## Non-goals",
    "  Scope that is explicitly deferred. Say why in one line each.",
    "  ## Assumed scope",
    "  Guesses made where facts were missing. One line each.",
    "",
    "Rules:",
    "- Inspect the repo first (list files, read key sources) so the plan fits reality.",
    "- Keep criteria small and satisficing. Every criterion must be checkable from the repo.",
    "- Do not implement anything. Do not modify any file except the plan file.",
    "- Your final message is one line: the plan file path.",
  ].join("\n");
}

function contractBlock(): string {
  return [
    "goal_update contract (the only way to finish):",
    "- goal_update(completed: true, message: \"short summary\") when the acceptance criteria hold.",
    "  The harness runs a skeptic panel at the end of the turn; it tells you what is missing.",
    "- goal_update(message: \"status note\") to log progress.",
    "- goal_update(blocked_reason: \"reason\") only after real attempts. After every 3 blocked",
    `  reports the idea guy suggests ways to unblock; ${GOAL_BLOCKED_PAUSE} in a row pause the goal.`,
  ].join("\n");
}

export function kickoffPrompt(goal: GoalState, dir: string, queuedInput?: string): string {
  const lines = [
    "<system-reminder>",
    `GOAL ACTIVE (round 1 of ${goal.id}). You are the worker for this goal.`,
    "",
    `OBJECTIVE (verbatim): ${goal.objective}`,
    "",
    `Read the plan first: ${planPath(dir)} — then work toward it. The plan is READ-ONLY for you;`,
    "if reality disagrees with it, note the mismatch with goal_update(message) and keep going.",
    "",
    "How the loop works:",
    "- You work in rounds. You may end your turn any time; when you and all your subagents are",
    "  idle, the harness injects the next round automatically. Waiting on your own subagents is fine.",
    `- Save durable evidence under ${path.join(dir, "scratch", "implementer")}: captured command`,
    "  output, test runs, artifacts. The skeptic panel audits this evidence; it does not rebuild it.",
    "- Never use shared /tmp for goal artifacts.",
    "",
    "Before calling goal_update(completed: true): run every step of the plan's Verification plan",
    "yourself and confirm the expected observations hold. Honest proof or the panel will refute you.",
    "",
    contractBlock(),
  ];
  if (queuedInput) {
    lines.push(
      "",
      "## User message (queued while the planner ran — treat it as part of this round)",
      "",
      queuedInput,
    );
  }
  lines.push("</system-reminder>");
  return lines.join("\n");
}

export function roundPrompt(goal: GoalState, dir: string): string {
  const lines: string[] = ["<system-reminder>", `Goal round ${goal.round}.`];
  lines.push(`OBJECTIVE (verbatim): ${goal.objective}`);
  lines.push(`Plan: ${planPath(dir)} (read-only).`);
  if (goal.gaps.length > 0) {
    lines.push("", "## Gaps to fix (from the skeptic panel)");
    for (const gap of goal.gaps) lines.push(`- ${gap}`);
  }
  if (goal.ideasText) {
    lines.push("", "## Untried ideas (from the idea guy — use or ignore)");
    lines.push(goal.ideasText);
  }
  if (goal.notes.length > 0) {
    const last = goal.notes[goal.notes.length - 1];
    lines.push("", `Last status note: ${last.text}`);
  }
  lines.push(
    "",
    "Run the verification plan steps and capture evidence before claiming completion.",
    contractBlock(),
    "</system-reminder>",
  );
  return lines.join("\n");
}

export function skepticPrompt(goal: GoalState, dir: string, index: number, total: number): string {
  return [
    "You are an ADVERSARIAL VERIFIER (skeptic) for the goal harness.",
    "You are NOT the agent that produced the work. Your job is to REFUTE the completion claim.",
    "Default to refuted: true when uncertain. A false pass is far worse than one more round.",
    "",
    `OBJECTIVE (verbatim): ${goal.objective}`,
    "",
    "Inputs:",
    `- Plan: ${planPath(dir)} — read it. The acceptance criteria are the gating set.`,
    goal.baselineCommit
      ? `- Baseline commit: ${goal.baselineCommit}. Run \`git diff ${goal.baselineCommit}\` and \`git status\` yourself to see all changes.`
      : "- No baseline commit (not a git repo). Inspect the changed files listed in the claim and the repo state directly.",
    `- Worker evidence: ${path.join(dir, "scratch", "implementer")} — captured command output and artifacts. AUDIT this evidence first.`,
    `- Worker's completion claim: ${goal.completedMessage ?? "(none)"}`,
    "",
    "Procedure:",
    "1. Read the plan's acceptance criteria. Each one must hold from the evidence.",
    "2. Audit the worker's captured evidence. You may re-run a verification step yourself when",
    `   the evidence looks wrong or missing. Save anything you run under ${path.join(dir, "scratch", `skeptic-${index + 1}`)}.`,
    "3. For prose goals, an empty diff is acceptable; judge the written deliverable itself.",
    "",
    "Your FINAL message must be EXACTLY one JSON object (a bare block or one fenced block),",
    'no other text:',
    '{"refuted": <true|false>, "gaps": ["concrete gap", ...], "details": "one paragraph"}',
    "",
    "- refuted false ONLY when every acceptance criterion is met by honest evidence.",
    "- gaps: what is missing or unproven, concretely. Empty when you cannot refute.",
    `You are skeptic ${index + 1} of ${total}. Judge independently.`,
  ].join("\n");
}

export function ideaPrompt(goal: GoalState, dir: string, mode: "verification" | "blocked"): string {
  const blockedNotes = goal.notes
    .filter((n) => n.text.startsWith("blocked:"))
    .slice(-3)
    .map((n) => `- ${n.text.replace(/^blocked:\s*/, "")}`);
  if (mode === "blocked") {
    return [
      "You are the IDEA GUY for the goal harness.",
      `The worker has reported BLOCKED ${goal.consecutiveBlocked} times in a row. Do NOT edit any file.`,
      "",
      `OBJECTIVE (verbatim): ${goal.objective}`,
      `Plan: ${planPath(dir)} — read it.`,
      goal.baselineCommit
        ? `Run \`git log --oneline ${goal.baselineCommit}..HEAD\` and \`git diff --stat ${goal.baselineCommit}\` to see what was tried.`
        : "Inspect the repo state to see what was tried.",
      "",
      "The worker's blocked reasons:",
      ...(blockedNotes.length ? blockedNotes : ["- (none recorded)"]),
      "",
      "Reply with EXACTLY 3 concrete ways to unblock. Two lines each: what to do, and why it",
      "might get past the blocker. Different angles, not variations of the same move. If the goal",
      "truly cannot be done, say plainly which acceptance criterion is impossible and what the",
      "smallest honest alternative would be. One optional context line first; no other preamble.",
    ].join("\n");
  }
  return [
    "You are the IDEA GUY for the goal harness.",
    "The worker has failed verification several times in a row. Do NOT edit any file.",
    "",
    `OBJECTIVE (verbatim): ${goal.objective}`,
    `Plan: ${planPath(dir)} — read it.`,
    goal.baselineCommit
      ? `Run \`git log --oneline ${goal.baselineCommit}..HEAD\` and \`git diff --stat ${goal.baselineCommit}\` to see what was tried.`
      : "Inspect the repo state to see what was tried.",
    "",
    "Gaps the skeptics reported:",
    ...(goal.gaps.length ? goal.gaps.map((g) => `- ${g}`) : ["- (none recorded)"]),
    "",
    "Reply with EXACTLY 3 concrete, untried ideas. Two lines each: what to do, and why it",
    "might break the deadlock. Different angles, not variations of the same move. One optional",
    "context line first; no other preamble.",
  ].join("\n");
}

export function summaryPrompt(goal: GoalState, dir: string): string {
  return [
    "You are the goal summarizer. The goal just PASSED verification.",
    "Do not modify any file. Read, then write the closing message.",
    "",
    `OBJECTIVE (verbatim): ${goal.objective}`,
    `Plan: ${planPath(dir)}`,
    goal.baselineCommit
      ? `Run \`git diff --stat ${goal.baselineCommit}\` and \`git log --oneline ${goal.baselineCommit}..HEAD\` for what changed.`
      : "Inspect the repo for what changed.",
    `Worker's completion claim: ${goal.completedMessage ?? "(none)"}`,
    "",
    "Write the single closing message the user reads: a concise recap of WHAT was delivered",
    "and HOW to use or verify it. Maximum ~15 lines. No preamble.",
  ].join("\n");
}
