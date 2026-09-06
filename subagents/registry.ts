/**
 * Child registry: one source of truth for every subagent this session owns.
 *
 *  - Persists snapshots via pi.appendEntry("lystic-subagents", ...) so the
 *    list survives /reload and session resume.
 *  - Background children are watched by tailing their transcript file and
 *    checking pid liveness; the watcher works after reload too, because the
 *    child writes straight to the file.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import type { ChildRecord, ParsedEvent } from "./types";
import { emptyUsage } from "./types";
import { parseLine, foldEvent, finalOutput, newAccumulator, pidAlive, killTree } from "./spawn";
import { allocWordId } from "./ids";

export type RegistryChange = (record: ChildRecord, info: { fromRunning: boolean }) => void;

export class SubagentRegistry {
  private children = new Map<string, ChildRecord>();
  private persist: ((snapshot: ChildRecord[]) => void) | null = null;
  private onChange: RegistryChange | null = null;
  private watchers = new Map<string, { timer: NodeJS.Timeout; offset: number }>();
  private transcriptsDir: string;

  constructor(transcriptsDir: string) {
    this.transcriptsDir = transcriptsDir;
    try {
      fs.mkdirSync(transcriptsDir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  get registryFile(): string {
    return process.env.LYSTIC_SUBAGENT_REGISTRY
      ?? path.join(this.transcriptsDir, "tree.jsonl");
  }

  /** Last-write-wins view of every agent in this session tree. */
  readTree(): ChildRecord[] {
    const map = new Map<string, ChildRecord>();
    // Local first, then the shared log. Nested processes patch status
    // (e.g. waiting) onto the file; that must win over the root's stale copy.
    for (const local of this.children.values()) map.set(local.id, local);
    try {
      const raw = fs.readFileSync(this.registryFile, "utf8");
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          const o = JSON.parse(line) as ChildRecord & { deleted?: boolean };
          if (o.deleted) map.delete(o.id);
          else if (o.id) map.set(o.id, o);
        } catch { /* skip bad line */ }
      }
    } catch { /* no file yet */ }
    return [...map.values()];
  }

  private publish(record: ChildRecord | { id: string; deleted: true }): void {
    try {
      fs.mkdirSync(path.dirname(this.registryFile), { recursive: true });
      fs.appendFileSync(this.registryFile, `${JSON.stringify(record)}\n`);
    } catch { /* ignore */ }
  }

  patchShared(id: string, patch: Partial<ChildRecord>): void {
    const all = this.readTree();
    const rec = all.find((r) => r.id === id);
    if (!rec) return;
    Object.assign(rec, patch);
    this.publish(rec);
  }

  markSelfWaiting(): void {
    const id = process.env.LYSTIC_SUBAGENT_ID;
    if (id) this.patchShared(id, { status: "waiting" });
  }

  markSelfRunningIfIdle(): void {
    const id = process.env.LYSTIC_SUBAGENT_ID;
    if (!id) return;
    const nested = this.readTree().filter((r) => r.parentId === id && (r.status === "running" || r.status === "waiting"));
    if (nested.length === 0) this.patchShared(id, { status: "running" });
  }

  setPersistence(persist: (snapshot: ChildRecord[]) => void): void {
    this.persist = persist;
  }

  setOnChange(onChange: RegistryChange): void {
    this.onChange = onChange;
  }

  setTranscriptsDir(dir: string): void {
    this.transcriptsDir = dir;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
  }

  /** Restore the newest snapshot from session entries (call on session_start). */
  restoreFromEntries(entries: any[]): void {
    let snapshot: ChildRecord[] | undefined;
    for (const entry of entries) {
      if (entry?.type === "custom" && entry?.customType === "lystic-subagents") {
        const data = entry?.data?.children;
        if (Array.isArray(data)) snapshot = data;
      }
    }
    if (!snapshot) return;
    this.children.clear();
    for (const record of snapshot) {
      this.children.set(record.id, record);
      // Reattach watchers for children still flagged running.
      if (record.status === "running" && record.background) {
        if (pidAlive(record.pid)) {
          this.startWatcher(record.id);
        } else {
          // Child died while we were away; finalize from the transcript.
          this.finalizeFromTranscript(record.id, "unknown-exit", { silent: true });
        }
      } else if (record.status === "running") {
        // Foreground child cannot outlive its tool call.
        record.status = "failed";
        record.errorMessage = record.errorMessage ?? "parent reloaded during foreground run";
        record.endedAt = record.endedAt ?? Date.now();
      }
    }
    this.snapshot();
    this.pruneDangling();
  }

  /** Drop dead processes and records whose parent is gone. No wake-up. */
  pruneDangling(): void {
    const tree = this.readTree();
    const ids = new Set(tree.map((r) => r.id));
    const drop = new Set<string>();
    for (const rec of tree) {
      const live = rec.status === "running" || rec.status === "waiting";
      if (live && !pidAlive(rec.pid)) drop.add(rec.id);
      if (rec.parentId && !ids.has(rec.parentId)) {
        drop.add(rec.id);
        if (live) killTree(rec.pid);
      }
    }
    if (drop.size === 0) return;
    for (const id of drop) {
      const rec = this.children.get(id) ?? tree.find((r) => r.id === id);
      if (rec && (rec.status === "running" || rec.status === "waiting")) killTree(rec.pid);
      this.stopWatcher(id);
      this.children.delete(id);
      this.publish({ id, deleted: true } as any);
      if (rec?.transcriptPath) {
        try { fs.unlinkSync(rec.transcriptPath); } catch { /* ignore */ }
        try { fs.unlinkSync(`${rec.transcriptPath}.err`); } catch { /* ignore */ }
      }
    }
    this.snapshot();
  }

  list(): ChildRecord[] {
    return [...this.children.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  get(id: string): ChildRecord | undefined {
    return this.children.get(id);
  }

  runningCount(): number {
    let count = 0;
    for (const child of this.children.values()) if (child.status === "running") count++;
    return count;
  }

  newRecord(init: {
    type: string;
    description: string;
    prompt: string;
    depth: number;
    background: boolean;
    pid?: number;
    cwd?: string;
    model?: string;
    parentId?: string;
  }): ChildRecord {
    const taken = new Set(this.readTree().map((r) => r.id));
    for (const id of this.children.keys()) taken.add(id);
    const id = allocWordId(taken);
    const record: ChildRecord = {
      id,
      type: init.type,
      description: init.description,
      prompt: init.prompt,
      depth: init.depth,
      parentId: init.parentId ?? process.env.LYSTIC_SUBAGENT_ID ?? undefined,
      status: "running",
      background: init.background,
      pid: init.pid,
      cwd: init.cwd,
      model: init.model,
      startedAt: Date.now(),
      usage: emptyUsage(),
      output: "",
      transcriptPath: this.transcriptPathFor(id, init.prompt),
      sessionPath: path.join(this.transcriptsDir, `${id}.session.jsonl`),
    };
    this.children.set(id, record);
    this.publish(record);
    this.snapshot();
    this.onChange?.(record, { fromRunning: false });
    return record;
  }

  private transcriptPathFor(id: string, prompt: string): string {
    const hash = createHash("sha256").update(`${Date.now()}:${prompt}`).digest("hex").slice(0, 8);
    return path.join(this.transcriptsDir, `${id}-${hash}.jsonl`);
  }

  update(id: string, patch: Partial<ChildRecord>, opts?: { silent?: boolean }): ChildRecord | undefined {
    const record = this.children.get(id);
    if (!record) return undefined;
    const fromRunning =
      record.status === "running" &&
      typeof patch.status === "string" &&
      patch.status !== "running";
    Object.assign(record, patch);
    this.publish(record);
    this.snapshot();
    if (!opts?.silent) this.onChange?.(record, { fromRunning });
    return record;
  }

  snapshot(): void {
    this.persist?.(this.list());
  }

  kill(id: string): ChildRecord | undefined {
    const tree = this.readTree();
    const found = this.children.get(id) ?? tree.find((r) => r.id === id);
    if (!found) return undefined;
    const ids: string[] = [];
    const walk = (pid: string) => {
      ids.push(pid);
      for (const r of tree) if (r.parentId === pid) walk(r.id);
    };
    walk(id);
    for (const childId of ids) {
      const rec = this.children.get(childId) ?? tree.find((r) => r.id === childId);
      if (rec && (rec.status === "running" || rec.status === "waiting")) killTree(rec.pid);
      this.stopWatcher(childId);
      if (this.children.has(childId)) {
        this.update(childId, { status: "killed", endedAt: Date.now() });
      } else if (rec) {
        this.publish({ ...rec, status: "killed", endedAt: Date.now() });
      }
    }
    return this.children.get(id) ?? found;
  }

  /** Kill the agent and every descendant, drop them from the tree. */
  remove(id: string): boolean {
    const tree = this.readTree();
    const found = this.children.get(id) ?? tree.find((r) => r.id === id);
    if (!found) return false;
    const ids: string[] = [];
    const walk = (pid: string) => {
      ids.push(pid);
      for (const r of tree) if (r.parentId === pid) walk(r.id);
    };
    walk(id);
    for (const childId of ids) {
      const rec = this.children.get(childId) ?? tree.find((r) => r.id === childId);
      if (rec && (rec.status === "running" || rec.status === "waiting")) {
        killTree(rec.pid);
      }
      this.stopWatcher(childId);
      this.children.delete(childId);
      this.publish({ id: childId, deleted: true } as any);
      if (rec?.transcriptPath) {
        try { fs.unlinkSync(rec.transcriptPath); } catch { /* ignore */ }
        try { fs.unlinkSync(`${rec.transcriptPath}.err`); } catch { /* ignore */ }
      }
    }
    this.snapshot();
    this.onChange?.(found, { fromRunning: false });
    return true;
  }

  // ─── Background watching ──────────────────────────────────────────────────

  startWatcher(id: string): void {
    const record = this.children.get(id);
    if (!record || this.watchers.has(id)) return;
    const state = { timer: null as unknown as NodeJS.Timeout, offset: 0 };
    // Resume from current file size.
    try {
      state.offset = fs.statSync(record.transcriptPath).size;
    } catch {
      state.offset = 0;
    }
    state.timer = setInterval(() => this.pollChild(id, state), 1000);
    this.watchers.set(id, state);
  }

  stopWatcher(id: string): void {
    const state = this.watchers.get(id);
    if (state) {
      clearInterval(state.timer);
      this.watchers.delete(id);
    }
  }

  private pollChild(
    id: string,
    state: { timer: NodeJS.Timeout; offset: number },
  ): void {
    const record = this.children.get(id);
    if (!record || record.status !== "running") {
      this.stopWatcher(id);
      return;
    }

    // Read newly appended transcript bytes.
    let grew = false;
    try {
      const size = fs.statSync(record.transcriptPath).size;
      if (size > state.offset) {
        const fd = fs.openSync(record.transcriptPath, "r");
        const length = size - state.offset;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, state.offset);
        fs.closeSync(fd);
        state.offset = size;
        for (const line of buffer.toString("utf8").split("\n")) {
          const event: ParsedEvent | null = parseLine(line);
          if (event) {
            grew = true;
            const acc = {
              messages: [],
              usage: { ...record.usage, turns: 0 },
              model: record.model,
              stopReason: record.stopReason,
              errorMessage: record.errorMessage,
            };
            // Rebuild cheap fields rather than keeping accumulators per child.
            foldEvent(acc as any, event);
            record.usage = { ...record.usage, ...acc.usage };
            record.model = acc.model ?? record.model;
            record.stopReason = acc.stopReason ?? record.stopReason;
            record.errorMessage = acc.errorMessage ?? record.errorMessage;
          }
        }
      }
    } catch {
      /* file not ready yet */
    }

    const alive = pidAlive(record.pid);
    if (!alive) {
      // Give the file a final drain, then finalize.
      this.drainAndFinalize(id, state);
      return;
    }
    if (grew) {
      record.output = record.output || "";
      // Do not persist or wake on every byte. Overlay re-reads the transcript.
    }
  }

  private drainAndFinalize(
    id: string,
    state: { timer: NodeJS.Timeout; offset: number },
  ): void {
    this.stopWatcher(id);
    this.finalizeFromTranscript(id);
    void state;
  }

  /** Parse a whole transcript and finalize the record from it. */
  finalizeFromTranscript(id: string, defaultStop?: string, opts?: { silent?: boolean }): void {
    const record = this.children.get(id);
    if (!record) return;
    this.stopWatcher(id);

    const acc = newAccumulator();
    try {
      const raw = fs.readFileSync(record.transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        const event = parseLine(line);
        if (event) foldEvent(acc, event);
      }
    } catch {
      /* transcript unreadable */
    }

    const output = finalOutput(acc.messages);
    const failed =
      acc.stopReason === "error" ||
      acc.stopReason === "aborted" ||
      (!output && !acc.usage.turns);
    this.update(id, {
      status: failed ? "failed" : "completed",
      output: output || "(no output)",
      usage: acc.usage.turns > 0 ? acc.usage : record.usage,
      toolCalls: acc.toolCalls,
      model: acc.model ?? record.model,
      stopReason: acc.stopReason ?? defaultStop ?? record.stopReason,
      errorMessage: acc.errorMessage ?? record.errorMessage,
      endedAt: Date.now(),
    }, opts);
  }

  /** Re-read a transcript fully; used by task_output and the /tasks viewer. */
  readTranscript(id: string): any[] {
    const record = this.children.get(id) ?? this.readTree().find((r) => r.id === id);
    if (!record) return [];
    const acc = newAccumulator();
    try {
      const raw = fs.readFileSync(record.transcriptPath, "utf8");
      for (const line of raw.split("\n")) {
        const event = parseLine(line);
        if (event) foldEvent(acc, event);
      }
    } catch {
      /* ignore */
    }
    return acc.messages;
  }
}

export function transcriptsDirFor(sessionFile: string | undefined): string {
  if (sessionFile) return path.join(path.dirname(sessionFile), "subagents");
  return path.join(tmpdir(), "lystic-subagents");
}
