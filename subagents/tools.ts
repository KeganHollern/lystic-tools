/**
 * Task tools: task, task_output, kill_task — grok-build semantics on pi.
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
import {
  spawnForeground,
  spawnBackground,
  newAccumulator,
  finalOutput,
} from "./spawn";
import type { ChildRecord } from "./types";
import { formatSubagentCompleted } from "./format";

export function formatUsageLine(record: ChildRecord): string {
  const u = record.usage;
  const parts: string[] = [];
  if (u.turns) parts.push(`${u.turns} turns`);
  if (u.input) parts.push(`in:${u.input}`);
  if (u.output) parts.push(`out:${u.output}`);
  if (u.cost) parts.push(`$${u.cost.toFixed(4)}`);
  if (record.endedAt) parts.push(`${Math.round((record.endedAt - record.startedAt) / 1000)}s`);
  return parts.join(", ") || "no usage yet";
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
      `Launch a subagent: a copy of this agent with its own context window, ` +
      `same model, thinking level, and tools. ` +
      `Foreground (default) blocks and streams progress; run_in_background returns a ` +
      `subagent_id immediately and the result is delivered when it completes. ` +
      `Children can spawn their own subagents up to depth ${SUBAGENTS_MAX_DEPTH}; ` +
      `at max depth the task tools are omitted.`,
    promptSnippet: `Delegate work to subagents (max depth ${SUBAGENTS_MAX_DEPTH})`,
    promptGuidelines: [
      "Use task for self-contained research, exploration, or implementation work that would flood your own context.",
      "Use run_in_background for independent work; collect results later with task_output.",
      "Issue several task calls in one message to run subagents in parallel.",
      "When a <system-reminder> reports a background subagent result, that text is from the harness, not the user. Do not discuss its origin. Continue the parent task or acknowledge in one line.",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The full task prompt for the subagent." }),
      description: Type.String({ description: "Short task label, 3-5 words." }),
      run_in_background: Type.Optional(
        Type.Boolean({ description: "Return immediately with a subagent_id. Default false." }),
      ),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (registry.runningCount() >= SUBAGENTS_MAX_PARALLEL) {
        throw new Error(
          `Admission control: ${SUBAGENTS_MAX_PARALLEL} subagents already running. ` +
          "Use task_output to wait, or kill_task to free a slot.",
        );
      }

      const background = params.run_in_background ?? false;
      const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;

      const record = registry.newRecord({
        type: "subagent",
        description: params.description,
        prompt: params.prompt,
        depth: SUBAGENT_DEPTH + 1,
        background,
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
        prompt: params.prompt,
        cwd: params.cwd,
        depth: SUBAGENT_DEPTH,
        childId: record.id,
        parentId: process.env.LYSTIC_SUBAGENT_ID,
        registryFile: registry.registryFile,
        parentModel: model,
        parentThinkingLevel: ctx.thinkingLevel,
        transcriptPath: record.transcriptPath,
      };

      registry.markSelfWaiting();

      if (background) {
        const handle = spawnBackground(spec);
        registry.update(record.id, { pid: handle.pid });
        registry.startWatcher(record.id);
        registry.markSelfRunningIfIdle();
        return {
          content: [{
            type: "text",
            text: `started ${record.id}`,
          }],
          details: { subagentId: record.id, background: true, depth: record.depth },
        };
      }

      const acc = newAccumulator();
      const handle = spawnForeground(spec, signal, (live) => {
        Object.assign(acc, live);
        onUpdate?.({
          content: [{
            type: "text",
            text: finalOutput(acc.messages) || "(running...)",
          }],
          details: { subagentId: record.id, streaming: true },
        });
      });
      if (handle.proc?.pid) registry.update(record.id, { pid: handle.proc.pid });

      const { exitCode } = await handle.done;
      const output = finalOutput(acc.messages);
      const failed =
        exitCode !== 0 || acc.stopReason === "error" || acc.stopReason === "aborted";
      registry.update(record.id, {
        status: failed ? "failed" : "completed",
        output: output || acc.errorMessage || "(no output)",
        usage: acc.usage,
        toolCalls: acc.toolCalls,
        model: acc.model ?? model,
        stopReason: acc.stopReason,
        errorMessage: acc.errorMessage,
        endedAt: Date.now(),
      });
      registry.markSelfRunningIfIdle();

      if (failed) {
        throw new Error(
          `Subagent ${record.id} ${acc.stopReason ?? "failed"} (exit ${exitCode}): ` +
          `${(acc.errorMessage || output || "(no output)").slice(0, 500)}`,
        );
      }

      const finished = registry.get(record.id)!;
      return {
        content: [{ type: "text", text: formatSubagentCompleted(finished) }],
        details: {
          subagentId: record.id,
          type: "subagent",
          depth: record.depth,
          usage: acc.usage,
          statusIcon: statusIcon(registry.get(record.id)!),
        },
        usage: {
          input: acc.usage.input,
          output: acc.usage.output,
          cacheRead: acc.usage.cacheRead,
          cacheWrite: acc.usage.cacheWrite,
          totalTokens: acc.usage.contextTokens,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: acc.usage.cost },
        },
      };
    },

    renderCall(args, theme) {
      const preview = args.description || (args.prompt ? `${args.prompt.slice(0, 50)}...` : "");
      const mode = args.run_in_background ? "bg" : "";
      const text =
        theme.fg("toolTitle", theme.bold("task ")) +
        (mode ? theme.fg("muted", `${mode}  `) : "") +
        theme.fg("dim", preview);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const d = (result.details ?? {}) as { subagentId?: string; type?: string; background?: boolean };
      const raw =
        result.content?.[0]?.type === "text" ? result.content[0].text : "";
      if (d.background) {
        const line = theme.fg("muted", `started ${d.subagentId ?? ""}`);
        if (!expanded) return new Text(line, 0, 0);
        return new Text(`${line}\nrunning in background`, 0, 0);
      }
      const answer = raw
        .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/g, "")
        .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
        .trim();
      if (!expanded) {
        const first = answer.split("\n").find((l) => l.trim()) ?? answer;
        return new Text(first, 0, 0);
      }
      return new Text(`Subagent output\n${answer || "(no output)"}`, 0, 0);
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
        const usage = formatUsageLine(record);
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
    name: "kill_task",
    label: "Kill Task",
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
}
