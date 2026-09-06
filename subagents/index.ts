/**
 * Subagent system for lystic-tools.
 *
 * Registers task / task_output / kill_task (when depth < maxDepth) and the
 * /tasks overlay. Wires persistence, status line, and auto-wake.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENTS_AUTO_WAKE,
  SUBAGENTS_ENABLED,
  SUBAGENT_DEPTH,
} from "../config";
import { SubagentRegistry, transcriptsDirFor } from "./registry";
import { registerTaskTools } from "./tools";
import { registerTasksCommand } from "./ui";
import { formatSubagentWake } from "./format";
import type { ChildRecord } from "./types";

export function registerSubagents(pi: ExtensionAPI): void {
  if (!SUBAGENTS_ENABLED) return;

  let registry: SubagentRegistry | null = null;
  let ui: ExtensionContext["ui"] | undefined;
  let footerTimer: ReturnType<typeof setInterval> | undefined;
  const woken = new Set<string>();

  const ensureRegistry = (sessionFile: string | undefined): SubagentRegistry => {
    if (registry) return registry;
    registry = new SubagentRegistry(transcriptsDirFor(sessionFile));
    registry.setPersistence((children) => {
      pi.appendEntry("lystic-subagents", { children });
    });
    registry.setOnChange((record, info) => {
      updateStatus(ui, registry!);
      if (info.fromRunning) {
        maybeWake(pi, record, woken);
        registry!.markSelfRunningIfIdle();
      }
    });
    return registry;
  };

  pi.on("session_start", (_event, ctx) => {
    ui = ctx.ui;
    const next = ensureRegistry(ctx.sessionManager.getSessionFile() ?? undefined);
    next.setTranscriptsDir(transcriptsDirFor(ctx.sessionManager.getSessionFile() ?? undefined));
    next.restoreFromEntries(ctx.sessionManager.getEntries());
    next.pruneDangling();
    updateStatus(ui, next);
    if (footerTimer) clearInterval(footerTimer);
    if (SUBAGENT_DEPTH === 0) {
      footerTimer = setInterval(() => {
        if (registry) updateStatus(ui, registry);
      }, 400);
    }
  });

  pi.on("session_shutdown", () => {
    if (footerTimer) {
      clearInterval(footerTimer);
      footerTimer = undefined;
    }
    if (!registry) return;
    for (const child of registry.list()) {
      if (child.status === "running" && child.background) {
        // Leave background children running; they write to the transcript file.
        registry.stopWatcher(child.id);
      }
    }
  });

  // Tools and /tasks. Tools skip themselves at maxDepth; /tasks stays useful
  // at depth 0 only (children have no parent-facing overlay).
  const boot = ensureRegistry(undefined);
  registerTaskTools({ registry: boot, pi });
  if (SUBAGENT_DEPTH === 0) registerTasksCommand(pi, boot);
}

let lastFooter = "";

function updateStatus(ui: ExtensionContext["ui"] | undefined, registry: SubagentRegistry): void {
  if (!ui) return;
  const rows = registry.readTree();
  const running = rows.filter((r) => r.status === "running").length;
  const waiting = rows.filter((r) => r.status === "waiting").length;
  const idle = rows.length - running - waiting;
  let text = "";
  if (rows.length > 0) {
    const parts = [`${running} running`];
    if (waiting) parts.push(`${waiting} waiting`);
    parts.push(`${idle} idle`);
    text = `agents: ${parts.join(", ")}`;
  }
  if (text === lastFooter) return;
  lastFooter = text;
  ui.setStatus("subagents", text || undefined);
}

function maybeWake(pi: ExtensionAPI, record: ChildRecord, woken: Set<string>): void {
  if (!record.background) return;
  if (record.status === "running") return;
  if (woken.has(record.id)) return;
  woken.add(record.id);

  if (!SUBAGENTS_AUTO_WAKE) return;

  // Grok-build: wake the parent and put the child's answer in context.
  // followUp waits if a turn is in progress, then starts the next turn.
  pi.sendMessage(
    {
      customType: "subagent_completed",
      content: formatSubagentWake(record),
      display: true,
      details: {
        subagentId: record.id,
        type: record.type,
        status: record.status,
        description: record.description,
        durationMs: record.endedAt ? record.endedAt - record.startedAt : undefined,
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

