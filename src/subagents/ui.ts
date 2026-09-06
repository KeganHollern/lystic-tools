/**
 * /tasks overlay — tree on top, log below. Fixed height.
 *
 * Tree: ↑/↓ select · Enter log · → expand · ← collapse · Esc close · q close
 * Log:  ↑/↓ scroll · Esc tree · q close
 * Selection is by record id so live resorted rows keep the same agent.
 */

import {
  type ExtensionAPI,
  type ExtensionContext,
  getMarkdownTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Key,
  Markdown,
  matchesKey,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { SubagentRegistry } from "./registry";
import { formatUsageLine, rolledCost, statusIcon } from "./tools";
import type { ChildRecord } from "./types";

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

function toolResultText(msg: any): { text: string; isError: boolean } {
  const isError = Boolean(msg.isError);
  const chunks = Array.isArray(msg.content) ? msg.content : [];
  const text = chunks
    .map((c: any) => (typeof c?.text === "string" ? c.text : ""))
    .join("\n")
    .trim();
  return { text, isError };
}

function userBubble(theme: Theme, text: string): Markdown {
  return new Markdown(text, 1, 0, getMarkdownTheme(), {
    color: (c) => theme.fg("userMessageText", c),
  });
}

function toolCard(
  theme: Theme,
  name: string,
  args: Record<string, unknown>,
  result: string | undefined,
  isError: boolean,
  pending: boolean,
): Box {
  const bg = pending ? "toolPendingBg" : isError ? "toolErrorBg" : "toolSuccessBg";
  const box = new Box(1, 1, (c) => theme.bg(bg, c));
  box.addChild(new Text(theme.fg("toolTitle", theme.bold(formatToolCall(name, args))), 0, 0));
  if (result) {
    const lines = result.split("\n");
    const shown = lines.slice(0, 5);
    const rest = lines.length - shown.length;
    let body = shown.map((l) => theme.fg("toolOutput", l)).join("\n");
    if (rest > 0) body += `\n${theme.fg("muted", `… (${rest} more lines)`)}`;
    box.addChild(new Text(`\n${body}`, 0, 0));
  }
  return box;
}

function buildChat(theme: Theme, registry: SubagentRegistry, record: ChildRecord): Container {
  const root = new Container();
  const prompt = record.prompt.trim();
  if (prompt) root.addChild(userBubble(theme, prompt));

  const messages = registry.readTranscript(record.id);
  const live = record.status === "running" || record.status === "waiting";

  if (messages.length === 0) {
    if (live) {
      root.addChild(new Spacer(1));
      root.addChild(new Text(theme.italic(theme.fg("muted", "Waiting…")), 1, 0));
    } else {
      const fallback = (record.output || record.errorMessage || "").trim();
      if (fallback) {
        root.addChild(new Spacer(1));
        root.addChild(new Markdown(fallback, 1, 0, getMarkdownTheme()));
      }
    }
    return root;
  }

  let pending: { name: string; args: Record<string, unknown> } | undefined;
  const flushTool = (result?: string, isError = false, done = false) => {
    if (!pending) return;
    root.addChild(new Spacer(1));
    root.addChild(toolCard(theme, pending.name, pending.args, result, isError, !done && live));
    pending = undefined;
  };

  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text" && String(part.text ?? "").trim()) {
          flushTool();
          root.addChild(new Spacer(1));
          root.addChild(new Markdown(String(part.text).trim(), 1, 0, getMarkdownTheme()));
        } else if (part.type === "toolCall") {
          flushTool();
          pending = { name: String(part.name ?? "tool"), args: (part.arguments ?? {}) as Record<string, unknown> };
        }
      }
    } else if (msg.role === "toolResult") {
      const { text, isError } = toolResultText(msg);
      if (pending) flushTool(text, isError, true);
    }
  }
  flushTool();
  return root;
}

interface TreeRow {
  record: ChildRecord;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  isLast: boolean;
  ancestorsLast: boolean[];
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
  const walk = (parentKey: string, depth: number, ancestorsLast: boolean[]) => {
    const nodes = sortRecords(byParent.get(parentKey) ?? []);
    nodes.forEach((n, i) => {
      const kids = byParent.get(n.id) ?? [];
      const isLast = i === nodes.length - 1;
      out.push({
        record: n,
        depth,
        hasChildren: kids.length > 0,
        expanded: expanded.has(n.id),
        isLast,
        ancestorsLast,
      });
      if (expanded.has(n.id) && kids.length > 0) walk(n.id, depth + 1, [...ancestorsLast, isLast]);
    });
  };
  walk("", 0, []);
  return out;
}

function treePrefix(row: TreeRow): string {
  if (row.depth === 0) return "";
  let s = "";
  for (let i = 0; i < row.depth - 1; i++) {
    s += row.ancestorsLast[i] ? "  " : "│ ";
  }
  s += row.isLast ? "└ " : "├ ";
  return s;
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

function statusPhrase(theme: Theme, record: ChildRecord): string {
  const g = statusGlyph(theme, record);
  const word =
    record.status === "completed"
      ? theme.fg("success", "completed")
      : record.status === "running"
        ? theme.fg("warning", "running")
        : record.status === "waiting"
          ? theme.fg("muted", "waiting")
          : theme.fg("error", record.status);
  return `${g} ${word}`;
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
  return body;
}

function row(theme: Theme, width: number, content: string, selected = false): string {
  const innerW = Math.max(0, width - 2);
  const body = fillBody(theme, fit(content, innerW), selected);
  return fit(vbar(theme) + body + vbar(theme), width);
}

function chatRow(theme: Theme, width: number, content: string): string {
  const innerW = Math.max(0, width - 2);
  const pad = Math.max(0, innerW - visibleWidth(content));
  return fit(vbar(theme) + content + " ".repeat(pad) + vbar(theme), width);
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
  return fit(theme.fg("borderAccent", chars[0]) + mid + theme.fg("borderAccent", chars[1]), width);
}

class TasksOverlay {
  private selected = 0;
  private selectedId?: string;
  private expanded = new Set<string>();
  private logOffset = 0;
  private logFollowEnd = true;
  private focus: "tree" | "log" = "tree";
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

  private syncSelection(rows: TreeRow[]): void {
    if (rows.length === 0) {
      this.selected = 0;
      return;
    }
    const idx = this.selectedId ? rows.findIndex((r) => r.record.id === this.selectedId) : -1;
    this.selected = idx >= 0 ? idx : Math.min(this.selected, rows.length - 1);
    this.selectedId = rows[this.selected]?.record.id;
  }

  private selectIndex(rows: TreeRow[], index: number): void {
    if (rows.length === 0) return;
    this.selected = Math.max(0, Math.min(index, rows.length - 1));
    this.selectedId = rows[this.selected]?.record.id;
    this.logOffset = 0;
    this.logFollowEnd = true;
    this.invalidate();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
      this.dispose();
      this.onClose();
      return;
    }
    if (this.focus === "log" && (matchesKey(data, Key.escape) || matchesKey(data, Key.esc))) {
      this.focus = "tree";
      this.invalidate();
      return;
    }
    if (this.focus === "tree" && (matchesKey(data, Key.escape) || matchesKey(data, Key.esc))) {
      this.dispose();
      this.onClose();
      return;
    }

    const rows = flattenVisible(this.registry, this.expanded);
    if (rows.length === 0) return;
    this.syncSelection(rows);

    if (this.focus === "log") {
      if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
        this.logOffset = Math.max(0, this.logOffset - 1);
        this.logFollowEnd = false;
        this.invalidate();
        return;
      }
      if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
        this.logOffset += 1;
        this.logFollowEnd = false;
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
      return;
    }

    if (matchesKey(data, Key.enter)) {
      this.focus = "log";
      this.invalidate();
      return;
    }

    if (matchesKey(data, Key.up) || matchesKey(data, "k")) {
      this.selectIndex(rows, Math.max(0, this.selected - 1));
      return;
    }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) {
      this.selectIndex(rows, Math.min(rows.length - 1, this.selected + 1));
      return;
    }

    if (matchesKey(data, Key.right) || matchesKey(data, "l")) {
      const row = rows[this.selected];
      if (row?.hasChildren) {
        this.expanded.add(row.record.id);
        this.logOffset = 0;
        this.logFollowEnd = true;
        this.invalidate();
      }
      return;
    }
    if (matchesKey(data, Key.left) || matchesKey(data, "h")) {
      const row = rows[this.selected];
      if (!row) return;
      if (row.expanded) {
        this.expanded.delete(row.record.id);
        this.invalidate();
        return;
      }
      if (row.record.parentId) {
        this.expanded.delete(row.record.parentId);
        const next = flattenVisible(this.registry, this.expanded);
        this.selectIndex(next, next.findIndex((r) => r.record.id === row.record.parentId));
      }
      return;
    }

    if (matchesKey(data, "x")) {
      const target = rows[this.selected]?.record;
      if (target) {
        this.registry.remove(target.id);
        this.expanded.delete(target.id);
        const next = flattenVisible(this.registry, this.expanded);
        this.selectIndex(next, Math.min(this.selected, Math.max(0, next.length - 1)));
      }
      return;
    }

  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;

    const th = this.theme;
    const w = Math.max(40, width);
    const tree = this.registry.readTree();
    const rows = flattenVisible(this.registry, this.expanded);
    this.syncSelection(rows);
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

    const listHeight = 6;
    if (rows.length === 0) {
      out.push(row(th, w, th.fg("dim", "  No subagents in this session.")));
      for (let i = 1; i < listHeight; i++) out.push(row(th, w, ""));
      out.push(row(th, w, " "));
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
        const innerW = Math.max(1, w - 2);
        const twist = item.hasChildren
          ? (item.expanded ? th.fg("muted", "▾ ") : th.fg("muted", "▸ "))
          : "  ";
        const lead = `${th.fg("borderAccent", treePrefix(item))}${twist}${statusGlyph(th, r)}  `;
        const cost = rolledCost(r, tree);
        const costStr = cost > 0 ? th.fg("warning", `$${cost.toFixed(4)}`) : "";
        const durRaw =
          r.status === "running" || r.status === "waiting"
            ? `${Math.round((Date.now() - r.startedAt) / 1000)}s`
            : r.endedAt
              ? `${Math.round((r.endedAt - r.startedAt) / 1000)}s`
              : "";
        const dur = durRaw ? th.fg("dim", durRaw) : "";
        const id = th.fg("muted", r.id);
        const right = [id, costStr, dur].filter(Boolean).join("  ");
        const rightW = visibleWidth(right);
        const descBudget = Math.max(6, innerW - visibleWidth(lead) - rightW - 2);
        const desc = truncateToWidth(r.description, descBudget);
        const left = lead + desc;
        const gap = Math.max(1, innerW - visibleWidth(left) - rightW);
        const line = left + " ".repeat(gap) + right;
        out.push(row(th, w, line, abs === this.selected));
      }
      const listHint =
        above > 0 || below > 0
          ? `${above > 0 ? `↑ ${above} more  ` : ""}${below > 0 ? `↓ ${below} more` : ""}`
          : "";
      out.push(row(th, w, th.fg("dim", listHint ? `  ${listHint.trim()}` : " ")));
    }

    const record = rows[this.selected]?.record;
    const innerW = Math.max(1, w - 2);
    const logHeight = 12;
    const wrapped = record ? buildChat(th, this.registry, record).render(innerW) : [];
    const maxOff = Math.max(0, wrapped.length - logHeight);
    if (this.logFollowEnd) this.logOffset = maxOff;
    this.logOffset = Math.min(this.logOffset, maxOff);
    if (this.logOffset >= maxOff) this.logFollowEnd = true;
    const shownEnd = Math.min(wrapped.length, this.logOffset + logHeight);
    const pos =
      wrapped.length === 0
        ? "0/0"
        : `${this.logOffset + 1}–${shownEnd}/${wrapped.length}`;
    const statusBit = record ? ` ${statusPhrase(th, record)} ` : "";
    const logLeft = record
      ? th.fg("accent", ` ${record.id} `) + statusBit
      : th.fg("dim", " log ");
    const logRight = th.fg("dim", ` ${pos}${this.focus === "log" ? "  ●" : ""} `);
    out.push(rule(th, w, "mid", logLeft, logRight));
    for (let i = 0; i < logHeight; i++) {
      out.push(chatRow(th, w, wrapped[this.logOffset + i] ?? ""));
    }

    const help =
      this.focus === "log"
        ? " ↑/↓ scroll log · Esc tree · q close "
        : " ↑/↓ tree · Enter log · → expand · ← collapse · Esc close · q close ";
    out.push(rule(th, w, "bot", th.fg("dim", help), ""));

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
          .map((r) => `${statusIcon(r)} ${r.id}  ${r.status}  ${r.description}  ${formatUsageLine(r, registry.readTree())}`)
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
      cost?: number;
    };
    const icon = d.status === "failed" || d.status === "killed" ? "✗" : "✓";
    const color = d.status === "completed" ? "success" : "error";
    const secs = d.durationMs ? `${Math.round(d.durationMs / 1000)}s` : "";
    const box = new Box(1, 0);
    const cost = typeof d.cost === "number" && d.cost > 0 ? theme.fg("warning", `$${d.cost.toFixed(4)}`) : "";
    box.addChild(
      new Text(
        `${theme.fg(color as any, icon)} ${theme.fg("muted", d.subagentId ?? "?")}  ${d.description ?? ""}  ${cost}  ${theme.fg("dim", secs)}`.replace(/  +/g, "  "),
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
