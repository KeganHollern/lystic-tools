/**
 * Subagent system for lystic-tools.
 *
 * Registers task / task_output / task_kill / task_message (when depth < maxDepth) and the
 * /tasks overlay. Wires persistence, status line, and auto-wake.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  SUBAGENTS_AUTO_WAKE,
  SUBAGENTS_ENABLED,
  SUBAGENT_DEPTH,
} from "../config";
import { SubagentRegistry, transcriptsDirFor } from "./registry";
import { registerTaskTools, rolledCost } from "./tools";
import { registerTasksCommand } from "./ui";
import { formatSubagentWake } from "./format";
import { inboxPath } from "./spawn";
import type { ChildRecord } from "./types";
import * as fs from "node:fs";

export function registerSubagents(pi: ExtensionAPI): void {
  if (!SUBAGENTS_ENABLED) return;

  let registry: SubagentRegistry | null = null;
  let ui: ExtensionContext["ui"] | undefined;
  let footerTimer: ReturnType<typeof setInterval> | undefined;
  let inboxTimer: ReturnType<typeof setInterval> | undefined;
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
        maybeWake(pi, record, woken, registry!);
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
    const selfId = process.env.LYSTIC_SUBAGENT_ID;
    const sessionFile = ctx.sessionManager.getSessionFile();
    if (selfId && sessionFile) {
      if (inboxTimer) clearInterval(inboxTimer);
      let offset = 0;
      const file = inboxPath(sessionFile);
      inboxTimer = setInterval(() => {
        try {
          const size = fs.statSync(file).size;
          if (size <= offset) return;
          const fd = fs.openSync(file, "r");
          const buf = Buffer.alloc(size - offset);
          fs.readSync(fd, buf, 0, buf.length, offset);
          fs.closeSync(fd);
          offset = size;
          for (const line of buf.toString("utf8").split("\n")) {
            if (!line.trim()) continue;
            try {
              const msg = JSON.parse(line) as { message?: string; steer?: boolean };
              if (msg.message) {
                pi.sendUserMessage(msg.message, {
                  deliverAs: msg.steer ? "steer" : "followUp",
                });
              }
            } catch { /* skip */ }
          }
        } catch {
          /* inbox not written yet */
        }
      }, 300);
    }
  });

  pi.on("session_shutdown", () => {
    if (footerTimer) {
      clearInterval(footerTimer);
      footerTimer = undefined;
    }
    if (inboxTimer) {
      clearInterval(inboxTimer);
      inboxTimer = undefined;
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

function maybeWake(pi: ExtensionAPI, record: ChildRecord, woken: Set<string>, registry: SubagentRegistry): void {
  if (!record.background) return;
  if (record.status === "running") return;
  if (woken.has(record.id)) return;
  woken.add(record.id);

  if (!SUBAGENTS_AUTO_WAKE) return;

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
        cost: rolledCost(record, registry.readTree()),
      },
    },
    { triggerTurn: true, deliverAs: "steer" },
  );
}

