/**
 * Task tools: task, task_output, task_kill, task_message.
 *
 * Depth gating: this module registers tools ONLY when the current process
 * depth is below maxDepth. Children at maxDepth never see the tools at all —
 * no context bloat, no temptation to spawn.
 *
 * Cancel scoping: background children spawned during a turn are killed when
 * that turn's abort signal fires (grok's parent_prompt_id behavior).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  SUBAGENTS_MAX_DEPTH,
  SUBAGENTS_MAX_PARALLEL,
  SUBAGENTS_OUTPUT_CAP,
  SUBAGENT_DEPTH,
} from "../config";
import type { SubagentRegistry } from "./registry";
import { existsSync } from "node:fs";
import {
  spawnBackground,
  writeInbox,
  pidAlive,
} from "./spawn";
import type { ChildRecord } from "./types";

export function rolledCost(record: ChildRecord, tree: ChildRecord[]): number {
  let sum = record.usage.cost || 0;
  const walk = (id: string) => {
    for (const child of tree) {
      if (child.parentId === id) {
        sum += child.usage.cost || 0;
        walk(child.id);
      }
    }
  };
  walk(record.id);
  return sum;
}

export function formatUsageLine(record: ChildRecord, tree: ChildRecord[] = []): string {
  const u = record.usage;
  const cost = tree.length ? rolledCost(record, tree) : u.cost;
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turns`);
  if (cost) parts.push(`$${cost.toFixed(4)}`);
  if (record.endedAt) parts.push(`${Math.round((record.endedAt - record.startedAt) / 1000)}s`);
  return parts.join(" · ") || "no usage yet";
}

export function statusIcon(record: ChildRecord): string {
  switch (record.status) {
    case "running": return "⏳";
    case "waiting": return "○";
    case "completed": return "✓";
    case "failed": return "✗";
    case "killed": return "⊘";
  }
}

export interface TaskToolsDeps {
  registry: SubagentRegistry;
  pi: ExtensionAPI;
}

export function registerTaskTools({ registry, pi }: TaskToolsDeps): void {
  // Depth gate: at maxDepth, none of these tools exist for the child model.
  if (SUBAGENT_DEPTH >= SUBAGENTS_MAX_DEPTH) return;

  pi.registerTool({
    name: "task",
    label: "Task",
    description:
      `Launch a subagent in the background: a copy of this agent with its own context window, ` +
      `same model, thinking level, and tools. Returns a subagent_id immediately. ` +
      `You are notified when it completes (steer); do not poll or sleep-wait. ` +
      `Use task_output only if you need the result before the notice. ` +
      `Children can spawn their own subagents up to depth ${SUBAGENTS_MAX_DEPTH}; ` +
      `at max depth the task tools are omitted.`,
    promptSnippet: `Delegate work to background subagents (max depth ${SUBAGENTS_MAX_DEPTH})`,
    promptGuidelines: [
      "Use task for self-contained research, exploration, or implementation work that would flood your own context.",
      "task always runs in the background. Continue other work. Do not poll; a steer notice arrives when it completes.",
      "Issue several task calls in one message to run subagents in parallel.",
      "When a <system-reminder> reports a background subagent result, that text is from the harness, not the user. Do not discuss its origin. Continue the parent task or acknowledge in one line.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The full task prompt for the subagent." }),
      description: Type.String({ description: "Short task label, 3-5 words." }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child." })),
    }),

    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (registry.runningCount() >= SUBAGENTS_MAX_PARALLEL) {
        throw new Error(
          `Admission control: ${SUBAGENTS_MAX_PARALLEL} subagents already running. ` +
          "Use task_output to wait, or kill_task to free a slot.",
        );
      }

      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      const record = registry.newRecord({
        type: "subagent",
        description: params.description,
        prompt: params.prompt,
        depth: SUBAGENT_DEPTH + 1,
        background: true,
        cwd: params.cwd,
        model,
      });

      // Cancel scoping: a child of this turn dies with the turn.
      if (signal) {
        const onAbort = () => registry.kill(record.id);
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }

      const spec = {
        prompt: `Task: ${params.prompt}`,
        cwd: params.cwd,
        depth: SUBAGENT_DEPTH,
        childId: record.id,
        parentId: process.env.LYSTIC_SUBAGENT_ID,
        registryFile: registry.registryFile,
        parentModel: model,
        parentThinkingLevel: ctx.thinkingLevel,
        transcriptPath: record.transcriptPath,
        sessionPath: record.sessionPath!,
      };

      registry.markSelfWaiting();
      const handle = spawnBackground(spec);
      registry.update(record.id, { pid: handle.pid });
      registry.startWatcher(record.id);
      registry.markSelfRunningIfIdle();
      return {
        content: [{ type: "text", text: `started ${record.id}` }],
        details: { subagentId: record.id, depth: record.depth },
      };
    },

    renderCall(args, theme) {
      const preview = args.description || (args.prompt ? `${args.prompt.slice(0, 50)}...` : "");
      const text =
        theme.fg("toolTitle", theme.bold("task ")) +
        theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = (result.details ?? {}) as { subagentId?: string };
      const line = theme.fg("muted", `started ${d.subagentId ?? ""}`);
      if (!expanded) return new Text(line, 0, 0);
      return new Text(`${line}\nrunning in background`, 0, 0);
    },
  });

  pi.registerTool({
    name: "task_output",
    label: "Task Output",
    description:
      "Wait for or retrieve subagent results. Waits for running subagents up to timeout_sec. " +
      "Returns status, output, and usage per subagent.",
    parameters: Type.Object({
      subagent_id: Type.Optional(Type.String({ description: "One subagent id." })),
      wait: Type.Optional(Type.Boolean({ description: "Wait for completion. Default true." })),
      timeout_sec: Type.Optional(Type.Number({ description: "Max wait in seconds. Default 120." })),
    }),
    async execute(_toolCallId, params, signal) {
      const wait = params.wait ?? true;
      const timeoutMs = (params.timeout_sec ?? 120) * 1000;
      const deadline = Date.now() + timeoutMs;

      const targets = params.subagent_id
        ? registry.list().filter((r) => r.id === params.subagent_id)
        : registry.list();
      if (targets.length === 0) {
        throw new Error(
          params.subagent_id
            ? `Unknown subagent id "${params.subagent_id}".`
            : "No subagents recorded yet.",
        );
      }

      if (wait) {
        while (Date.now() < deadline) {
          if (signal?.aborted) throw new Error("aborted");
          const pending = targets.filter((r) => r.status === "running");
          if (pending.length === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      const sections = targets.map((record) => {
        const header = `${statusIcon(record)} ${record.id} (${record.type}) ${record.status} — ${record.description}`;
        const usage = formatUsageLine(record, registry.readTree());
        const output = record.status === "running"
          ? "(still running)"
          : record.output.slice(0, SUBAGENTS_OUTPUT_CAP) +
            (record.output.length > SUBAGENTS_OUTPUT_CAP ? "\n[truncated]" : "");
        return `### ${header}\n${usage}\n\n${output}`;
      });

      return {
        content: [{ type: "text", text: sections.join("\n\n---\n\n") }],
        details: { count: targets.length },
      };
    },
  });

  pi.registerTool({
    name: "task_list",
    label: "Task List",
    description:
      "List immediate child subagents: id, description, and status. " +
      "Does not include nested grandchildren.",
    promptSnippet: "List this agent's direct subagents",
    parameters: Type.Object({}),
    async execute() {
      const mine = process.env.LYSTIC_SUBAGENT_ID ?? "";
      const rows = registry.readTree().filter((r) => (r.parentId ?? "") === mine);
      if (rows.length === 0) {
        return { content: [{ type: "text", text: "No immediate subagents." }] };
      }
      const lines = rows.map((r) => {
        const cost = rolledCost(r, registry.readTree());
        const costStr = cost > 0 ? ` $${cost.toFixed(4)}` : "";
        return `${r.status.padEnd(10)} ${r.id}  ${r.description}${costStr}`;
      });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { count: rows.length, ids: rows.map((r) => r.id) },
      };
    },
  });

  pi.registerTool({
    name: "task_kill",
    label: "Task Kill",
    description: "Kill a running subagent by id, or all running subagents.",
    parameters: Type.Object({
      subagent_id: Type.Optional(Type.String({ description: "Subagent id to kill. Omit with all=true to kill every running subagent." })),
      all: Type.Optional(Type.Boolean({ description: "Kill all running subagents." })),
    }),
    async execute(_toolCallId, params) {
      const targets = params.all
        ? registry.list().filter((r) => r.status === "running")
        : params.subagent_id
          ? [registry.get(params.subagent_id)].filter((r): r is ChildRecord => Boolean(r))
          : [];
      if (targets.length === 0) {
        throw new Error("No matching running subagents.");
      }
      const killed: string[] = [];
      for (const target of targets) {
        registry.kill(target.id);
        killed.push(target.id);
      }
      return {
        content: [{ type: "text", text: `Killed: ${killed.join(", ")}` }],
        details: { killed },
      };
    },
  });

  pi.registerTool({
    name: "task_message",
    label: "Task Message",
    description:
      "Send a message to an existing subagent. If it is running or waiting, the text is steered into that live process. " +
      "If it is idle (completed or failed), a new process resumes its saved session with this message.",
    promptSnippet: "Message a running subagent (steer) or resume an idle one",
    promptGuidelines: [
      "Use task_message to continue an existing subagent instead of calling task to start a new one.",
    ],
    parameters: Type.Object({
      subagent_id: Type.String({ description: "Id of the subagent to message." }),
      message: Type.String({ description: "Text to send." }),
    }),
    async execute(_toolCallId, params) {
      const rec =
        registry.get(params.subagent_id) ??
        registry.readTree().find((r) => r.id === params.subagent_id);
      if (!rec) throw new Error(`Unknown subagent id "${params.subagent_id}".`);
      if (rec.status === "killed" && !rec.sessionPath) {
        throw new Error(`Subagent ${rec.id} was killed and has no session to resume.`);
      }

      const live = rec.status === "running" || rec.status === "waiting" || pidAlive(rec.pid);
      if (live && rec.sessionPath) {
        writeInbox(rec.sessionPath, params.message, true);
        return {
          content: [{ type: "text", text: `steered to ${rec.id}` }],
          details: { subagentId: rec.id, mode: "steer" },
        };
      }

      if (!rec.sessionPath || !existsSync(rec.sessionPath)) {
        throw new Error(`Subagent ${rec.id} has no saved session to resume.`);
      }

      const spec = {
        prompt: params.message,
        cwd: rec.cwd,
        depth: rec.depth - 1,
        childId: rec.id,
        parentId: rec.parentId,
        registryFile: registry.registryFile,
        parentModel: rec.model,
        parentThinkingLevel: undefined as string | undefined,
        transcriptPath: rec.transcriptPath,
        sessionPath: rec.sessionPath,
      };
      registry.update(rec.id, { status: "running", endedAt: undefined });
      const handle = spawnBackground(spec);
      registry.update(rec.id, { pid: handle.pid });
      registry.startWatcher(rec.id);
      return {
        content: [{ type: "text", text: `resumed ${rec.id}` }],
        details: { subagentId: rec.id, mode: "resume" },
      };
    },
  });
}
