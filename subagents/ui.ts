/**
 * /tasks overlay — one screen: list on top, log of the selected row below.
 *
 * Up/Down always move the selection. The log follows. PgUp/PgDn scroll the log.
 * Left/Right do nothing (they used to switch a hidden “pane” and drop the highlight).
 *
 * Every line is padded to the same visible width so the │ borders line up.
 * ANSI colors are ignored when measuring width.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Key,
  matchesKey,
  Text,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { SubagentRegistry } from "./registry";
import { formatUsageLine, statusIcon } from "./tools";
import type { ChildRecord } from "./types";

interface LogLine {
  kind: "meta" | "tool" | "text" | "blank";
  text: string;
}

function shortenPath(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function formatToolCall(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "bash": {
      const command = String(args.command ?? "...");
      const preview = command.length > 72 ? `${command.slice(0, 72)}…` : command;
      return `$ ${preview}`;
    }
    case "read": {
      const filePath = shortenPath(String(args.path ?? args.file_path ?? "..."));
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      const range =
        offset !== undefined || limit !== undefined
          ? `:${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : ""}`
          : "";
      return `read ${filePath}${range}`;
    }
    case "edit":
      return `edit ${shortenPath(String(args.path ?? args.file_path ?? "..."))}`;
    case "write":
      return `write ${shortenPath(String(args.path ?? args.file_path ?? "..."))}`;
    case "grep":
      return `grep /${args.pattern ?? ""}/ in ${shortenPath(String(args.path ?? "."))}`;
    case "find":
      return `find ${args.pattern ?? "*"} in ${shortenPath(String(args.path ?? "."))}`;
    case "ls":
      return `ls ${shortenPath(String(args.path ?? "."))}`;
    case "web_search":
      return `search ${String(args.query ?? "").slice(0, 60)}`;
    case "web_fetch":
      return `fetch ${String(args.url ?? (args.urls as string[] | undefined)?.[0] ?? "")}`;
    case "task":
      return `task ${args.description ?? ""}`;
    default: {
      const raw = JSON.stringify(args);
      return `${name} ${raw.length > 50 ? `${raw.slice(0, 50)}…` : raw}`;
    }
  }
}

function buildLog(registry: SubagentRegistry, record: ChildRecord): LogLine[] {
  const lines: LogLine[] = [
    { kind: "meta", text: `${record.type} · ${record.status} · depth ${record.depth} · ${formatUsageLine(record)}` },
    { kind: "meta", text: record.prompt.replace(/\s+/g, " ").trim() },
    { kind: "blank", text: "" },
  ];

  const messages = registry.readTranscript(record.id);
  if (messages.length === 0) {
    lines.push({
      kind: "meta",
      text: record.status === "running" ? "Waiting for the first event…" : "(empty transcript)",
    });
    return lines;
  }

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text" && part.text) {
          for (const line of String(part.text).split("\n")) {
            lines.push({ kind: "text", text: line });
          }
        } else if (part.type === "toolCall") {
          lines.push({ kind: "tool", text: `→ ${formatToolCall(part.name, part.arguments ?? {})}` });
        }
      }
    } else if (msg.role === "toolResult") {
      const isError = Boolean(msg.isError);
      const chunks = Array.isArray(msg.content) ? msg.content : [];
      const text = chunks
        .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text;
      if (preview) {
        lines.push({ kind: "tool", text: isError ? `  ✗ ${preview}` : `  ↳ ${preview}` });
      }
    }
  }
  return lines;
}

interface TreeRow {
  record: ChildRecord;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  isLast: boolean;
}

function flattenVisible(registry: SubagentRegistry, expanded: Set<string>): TreeRow[] {
  const tree = registry.readTree();
  const byParent = new Map<string, ChildRecord[]>();
  for (const r of tree) {
    const key = r.parentId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(r);
    byParent.set(key, list);
  }
  const out: TreeRow[] = [];
  const walk = (parentKey: string, depth: number) => {
    const nodes = sortRecords(byParent.get(parentKey) ?? []);
    nodes.forEach((n, i) => {
      const kids = byParent.get(n.id) ?? [];
      out.push({
        record: n,
        depth,
        hasChildren: kids.length > 0,
        expanded: expanded.has(n.id),
        isLast: i === nodes.length - 1,
      });
      if (expanded.has(n.id) && kids.length > 0) walk(n.id, depth + 1);
    });
  };
  walk("", 0);
  return out;
}

function treePrefix(row: TreeRow): string {
  if (row.depth === 0) return "";
  const pad = "  ".repeat(row.depth - 1);
  return pad + (row.isLast ? "└ " : "├ ");
}

function sortRecords(rows: ChildRecord[]): ChildRecord[] {
  const rank = (s: ChildRecord["status"]) => (s === "running" ? 0 : s === "waiting" ? 1 : 2);
  return [...rows].sort((a, b) => {
    const d = rank(a.status) - rank(b.status);
    if (d !== 0) return d;
    if (a.status === "running" || a.status === "waiting") return b.startedAt - a.startedAt;
    return (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt);
  });
}

function statusGlyph(theme: Theme, record: ChildRecord): string {
  switch (record.status) {
    case "running":
      return theme.fg("warning", "●");
    case "waiting":
      return theme.fg("muted", "○");
    case "completed":
      return theme.fg("success", "✓");
    case "failed":
      return theme.fg("error", "✗");
    case "killed":
      return theme.fg("muted", "⊘");
  }
}

function paintLogLine(theme: Theme, line: LogLine): string {
  switch (line.kind) {
    case "meta":
      return theme.fg("dim", line.text);
    case "tool":
      return theme.fg("muted", line.text);
    case "blank":
      return "";
    default:
      return line.text;
  }
}

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  const clipped = truncateToWidth(text, width);
  const pad = width - visibleWidth(clipped);
  return pad > 0 ? clipped + " ".repeat(pad) : clipped;
}

function vbar(theme: Theme): string {
  return theme.fg("borderAccent", "│");
}

function hfill(theme: Theme, n: number): string {
  return n > 0 ? theme.fg("borderAccent", "─".repeat(n)) : "";
}

function fillBody(theme: Theme, body: string, selected: boolean): string {
  if (selected) return theme.bg("selectedBg", body);
  return theme.bg("customMessageBg", body);
}

function row(theme: Theme, width: number, content: string, selected = false): string {
  const innerW = Math.max(0, width - 2);
  const body = fillBody(theme, fit(content, innerW), selected);
  return fit(vbar(theme) + body + vbar(theme), width);
}

function rule(
  theme: Theme,
  width: number,
  kind: "top" | "mid" | "bot",
  leftLabel = "",
  rightLabel = "",
): string {
  const chars = { top: ["╔", "╗"], mid: ["╠", "╣"], bot: ["╚", "╝"] }[kind];
  const innerW = Math.max(0, width - 2);
  const dash = Math.max(0, innerW - visibleWidth(leftLabel) - visibleWidth(rightLabel));
  const mid = fit(leftLabel + hfill(theme, dash) + rightLabel, innerW);
  const painted = theme.bg("customMessageBg", mid);
  return fit(theme.fg("borderAccent", chars[0]) + painted + theme.fg("borderAccent", chars[1]), width);
}

class TasksOverlay {
  private selected = 0;
  private expanded = new Set<string>();
  private logOffset = 0;
  private logFollowEnd = true;
  private cachedWidth?: number;
  private cachedLines?: string[];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private registry: SubagentRegistry,
    private theme: Theme,
    private requestRender: () => void,
    private onClose: () => void,
  ) {
    this.timer = setInterval(() => {
      this.invalidate();
      this.requestRender();
    }, 400);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  handleInput(data: string): void {
    const close =
      matchesKey(data, Key.escape) ||
      matchesKey(data, Key.esc) ||
      matchesKey(data, "q") ||
      matchesKey(data, Key.ctrl("c"));
    if (close) {
      this.dispose();
      this.onClose();
      return;
    }

    const rows = flattenVisible(this.registry, this.expanded);
    if (rows.length === 0) return;
    this.selected = Math.min(this.selected, rows.length - 1);

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selected = Math.max(0, this.selected - 1);
      this.logOffset = 0;
      this.logFollowEnd = true;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selected = Math.min(rows.length - 1, this.selected + 1);
      this.logOffset = 0;
      this.logFollowEnd = true;
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.right) || matchesKey(data, "l")) {
      const row = rows[this.selected];
      if (row?.hasChildren) {
        this.expanded.add(row.record.id);
        this.selected = Math.min(rows.length, this.selected + 1);
        this.logOffset = 0;
        this.logFollowEnd = true;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
      const row = rows[this.selected];
      if (!row) return;
      if (row.depth > 0 && row.record.parentId) {
        this.expanded.delete(row.record.parentId);
        const next = flattenVisible(this.registry, this.expanded);
        const idx = next.findIndex((r) => r.record.id === row.record.parentId);
        this.selected = idx >= 0 ? idx : 0;
        this.logOffset = 0;
        this.logFollowEnd = true;
        this.invalidate();
      } else if (row.expanded) {
        this.expanded.delete(row.record.id);
        this.invalidate();
      }
      return;
    }

    if (matchesKey(data, "x")) {
      const target = rows[this.selected]?.record;
      if (target) {
        this.registry.remove(target.id);
        this.expanded.delete(target.id);
        const next = flattenVisible(this.registry, this.expanded);
        this.selected = Math.min(this.selected, Math.max(0, next.length - 1));
        this.logFollowEnd = true;
        this.invalidate();
      }
      return;
    }

    const page = 8;
    if (matchesKey(data, Key.pageUp)) {
      this.logOffset = Math.max(0, this.logOffset - page);
      this.logFollowEnd = false;
      this.invalidate();
      return;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.logOffset += page;
      this.invalidate();
      return;
    }
    if (matchesKey(data, "g") || matchesKey(data, Key.home)) {
      this.logOffset = 0;
      this.logFollowEnd = false;
      this.invalidate();
      return;
    }
    if (matchesKey(data, "G") || matchesKey(data, Key.end)) {
      this.logOffset = 99999;
      this.logFollowEnd = true;
      this.invalidate();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const w = Math.max(40, width);
    const tree = this.registry.readTree();
    const rows = flattenVisible(this.registry, this.expanded);
    const running = tree.filter((r) => r.status === "running").length;
    const waiting = tree.filter((r) => r.status === "waiting").length;
    const idle = tree.length - running - waiting;
    const out: string[] = [];
    const counts = ` ${running} run · ${waiting} wait · ${idle} idle `;

    out.push(
      rule(
        th,
        w,
        "top",
        th.fg("accent", th.bold(" Subagents ")),
        th.fg("muted", counts),
      ),
    );

    const listHeight = Math.min(6, Math.max(1, rows.length || 1));
    if (rows.length === 0) {
      out.push(row(th, w, th.fg("dim", "  No subagents in this session.")));
    } else {
      this.selected = Math.min(this.selected, rows.length - 1);
      const start = Math.max(0, Math.min(this.selected - listHeight + 1, rows.length - listHeight));
      const above = start;
      const below = Math.max(0, rows.length - (start + listHeight));
      const slice = rows.slice(start, start + listHeight);
      for (let i = 0; i < listHeight; i++) {
        const item = slice[i];
        if (!item) {
          out.push(row(th, w, ""));
          continue;
        }
        const r = item.record;
        const abs = start + i;
        const twist = item.hasChildren
          ? (item.expanded ? th.fg("muted", "▾ ") : th.fg("muted", "▸ "))
          : "  ";
        const live =
          r.status === "running" || r.status === "waiting"
            ? `${Math.round((Date.now() - r.startedAt) / 1000)}s`
            : formatUsageLine(r);
        const line =
          `${treePrefix(item)}${twist}${statusGlyph(th, r)}  ${r.description}    ` +
          `${th.fg("dim", r.id)}  ${th.fg("dim", live)}`;
        out.push(row(th, w, line, abs === this.selected));
      }
      if (above > 0 || below > 0) {
        const hint =
          (above > 0 ? `↑ ${above} more  ` : "") +
          (below > 0 ? `↓ ${below} more` : "");
        out.push(row(th, w, th.fg("dim", `  ${hint.trim()}`)));
      }
    }

    const record = rows[this.selected]?.record;
    const liveTag = record?.status === "running" ? th.fg("warning", " live ") : "";
    const logLeft = record
      ? th.fg("accent", ` ${record.id} `) + th.fg("dim", `${record.status} `) + liveTag
      : th.fg("dim", " log ");
    out.push(rule(th, w, "mid", logLeft, ""));

    const innerW = Math.max(1, w - 2);
    const wrapW = Math.max(1, innerW - 2);
    const logHeight = 12;
    const source = record ? buildLog(this.registry, record) : [];
    const wrapped: string[] = [];
    for (const line of source) {
      const painted = paintLogLine(th, line);
      const parts = wrapTextWithAnsi(painted.length === 0 ? " " : painted, wrapW);
      for (const part of parts) wrapped.push(part);
    }
    const maxOff = Math.max(0, wrapped.length - logHeight);
    if (this.logFollowEnd || (record && record.status === "running" && this.logFollowEnd)) {
      this.logOffset = maxOff;
    }
    this.logOffset = Math.min(this.logOffset, maxOff);
    if (this.logOffset >= maxOff) this.logFollowEnd = true;
    for (let i = 0; i < logHeight; i++) {
      const text = wrapped[this.logOffset + i] ?? "";
      out.push(row(th, w, ` ${text}`));
    }
    if (wrapped.length > logHeight) {
      const up = this.logOffset > 0 ? `↑ ${this.logOffset} ` : "";
      const down =
        this.logOffset < maxOff ? `↓ ${wrapped.length - this.logOffset - logHeight} more` : "end";
      out.push(row(th, w, th.fg("dim", `  ${up}${down}`)));
    }

    out.push(rule(th, w, "bot", th.fg("dim", " ↑/↓ select · → expand · ← collapse · PgUp/PgDn log · x delete · q close "), ""));

    this.cachedLines = out;
    this.cachedWidth = width;
    return out;
  }
}

export function registerTasksCommand(pi: ExtensionAPI, registry: SubagentRegistry): void {
  pi.registerCommand("tasks", {
    description: "List subagents and view their chat logs",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        const rows = registry.list();
        if (rows.length === 0) {
          ctx.ui.notify("No subagents in this session.", "info");
          return;
        }
        const text = rows
          .map((r) => `${statusIcon(r)} ${r.id}  ${r.type}  ${r.status}  ${r.description}  ${formatUsageLine(r)}`)
          .join("\n");
        ctx.ui.notify(text, "info");
        return;
      }
      await showOverlay(ctx, registry);
    },
  });

  pi.registerMessageRenderer("subagent_completed", (message, { expanded }, theme) => {
    const d = (message.details ?? {}) as {
      subagentId?: string;
      type?: string;
      status?: string;
      description?: string;
      durationMs?: number;
    };
    const icon = d.status === "failed" || d.status === "killed" ? "✗" : "✓";
    const color = d.status === "completed" ? "success" : "error";
    const secs = d.durationMs ? `${Math.round(d.durationMs / 1000)}s` : "";
    const box = new Box(1, 0);
    box.addChild(
      new Text(
        `${theme.fg(color as any, icon)} ${theme.fg("accent", d.subagentId ?? "?")}  ${d.type ?? ""}  ${d.description ?? ""}  ${theme.fg("dim", secs)}`,
        0,
        0,
      ),
    );
    if (expanded) {
      const raw =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content.map((c: any) => c.text ?? "").join("")
            : "";
      const answer = raw
        .replace(/<\/?system-reminder>/g, "")
        .replace(/Background subagent result[\s\S]*?short line\.\s*/g, "")
        .replace(/<subagent_meta>[\s\S]*?<\/subagent_meta>/g, "")
        .replace(/<subagent_result>[\s\S]*?<\/subagent_result>/g, "")
        .trim();
      box.addChild(new Text(answer || "(no output)", 0, 0));
      box.addChild(new Text(theme.fg("dim", "Full log: /tasks"), 0, 0));
    }
    return box;
  });

  pi.registerEntryRenderer("lystic-subagent-event", (entry, { expanded }, theme) => {
    const data = (entry.data ?? {}) as {
      id?: string;
      type?: string;
      status?: string;
      description?: string;
      durationMs?: number;
    };
    const icon = data.status === "completed" ? "✓" : data.status === "failed" ? "✗" : "⊘";
    const color = data.status === "completed" ? "success" : data.status === "failed" ? "error" : "muted";
    const box = new Box(1, 0);
    const secs = data.durationMs ? `${Math.round(data.durationMs / 1000)}s` : "";
    box.addChild(
      new Text(
        `${theme.fg(color as any, icon)} subagent ${theme.fg("accent", data.id ?? "?")}  ${data.type ?? ""}  ${data.description ?? ""}  ${theme.fg("dim", secs)}`,
        0,
        0,
      ),
    );
    if (expanded) {
      box.addChild(new Text(theme.fg("dim", "Full log: /tasks"), 0, 0));
    }
    return box;
  });
}

async function showOverlay(ctx: ExtensionContext, registry: SubagentRegistry): Promise<void> {
  await ctx.ui.custom(
    (tui, theme, _kb, done) => {
      const overlay = new TasksOverlay(registry, theme, () => tui.requestRender(), () => {
        overlay.dispose();
        done(undefined);
      });
      return {
        render: (width: number) => overlay.render(width),
        handleInput: (data: string) => {
          overlay.handleInput(data);
          tui.requestRender();
        },
        invalidate: () => overlay.invalidate(),
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "92%",
        minWidth: 56,
        maxHeight: "85%",
        anchor: "center",
      },
    },
  );
}
