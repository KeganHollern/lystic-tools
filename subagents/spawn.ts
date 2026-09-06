/**
 * Child process spawning. Two modes:
 *
 *  - foreground: piped stdout, live streaming via callbacks (like pi's
 *    official subagent example).
 *  - background: stdout goes directly to the transcript file, process group
 *    detached — the child survives /reload and parent exit; a watcher tails
 *    the file to update the registry.
 *
 * Every child (either mode) appends `LYSTIC_SUBAGENT_DEPTH=n+1` to its env so
 * nested extensions know their depth and drop task tools at maxDepth.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ChildUsage, ParsedEvent } from "./types";
import { emptyUsage } from "./types";

export interface SpawnSpec {
  prompt: string;
  cwd?: string;
  depth: number;
  childId: string;
  parentId?: string;
  registryFile: string;
  parentModel?: string;
  parentThinkingLevel?: string;
  transcriptPath: string;
}

export interface ForegroundHandle {
  proc: ReturnType<typeof spawn>;
  done: Promise<{ exitCode: number; aborted: boolean }>;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) return { command: process.execPath, args };
  return { command: "pi", args };
}

export function buildArgs(spec: SpawnSpec): string[] {
  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (spec.parentModel) args.push("--model", spec.parentModel);
  if (spec.parentThinkingLevel) args.push("--thinking", spec.parentThinkingLevel);
  // No --tools: child uses the same default tool set as the root.
  // Depth gating drops task tools inside the child process itself.
  args.push(`Task: ${spec.prompt}`);
  return args;
}

export function childEnv(spec: SpawnSpec): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LYSTIC_SUBAGENT_DEPTH: String(spec.depth + 1),
    LYSTIC_SUBAGENT_ID: spec.childId,
    LYSTIC_SUBAGENT_PARENT_ID: spec.parentId ?? "",
    LYSTIC_SUBAGENT_REGISTRY: spec.registryFile,
  };
}

export interface EventAccumulator {
  messages: any[];
  usage: ChildUsage;
  toolCalls: number;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export function newAccumulator(): EventAccumulator {
  return { messages: [], usage: emptyUsage(), toolCalls: 0 };
}

/** Fold one parsed JSON-mode event into the accumulator. */
export function foldEvent(acc: EventAccumulator, event: ParsedEvent): void {
  if (event.type === "message_end" && event.message) {
    const msg = event.message;
    acc.messages.push(msg);
    if (msg.role === "assistant") {
      acc.usage.turns++;
      for (const part of msg.content ?? []) {
        if (part?.type === "toolCall") acc.toolCalls++;
      }
      const usage = msg.usage;
      if (usage) {
        acc.usage.input += usage.input || 0;
        acc.usage.output += usage.output || 0;
        acc.usage.cacheRead += usage.cacheRead || 0;
        acc.usage.cacheWrite += usage.cacheWrite || 0;
        acc.usage.cost += usage.cost?.total || 0;
        acc.usage.contextTokens = usage.totalTokens || 0;
      }
      if (!acc.model && msg.model) acc.model = msg.model;
      if (msg.stopReason) acc.stopReason = msg.stopReason;
      if (msg.errorMessage) acc.errorMessage = msg.errorMessage;
    }
  } else if (event.type === "tool_result_end" && event.message) {
    acc.messages.push(event.message);
  }
}

export function parseLine(line: string): ParsedEvent | null {
  if (!line.trim()) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed && typeof parsed === "object" ? (parsed as ParsedEvent) : null;
  } catch {
    return null;
  }
}

/** Last assistant text — the child's final report. */
export function finalOutput(messages: any[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      for (const part of msg.content ?? []) {
        if (part.type === "text" && part.text) return part.text;
      }
    }
  }
  return "";
}

// ─── Foreground spawn (piped, streaming) ────────────────────────────────────

export function spawnForeground(
  spec: SpawnSpec,
  signal: AbortSignal | undefined,
  onEvent: (acc: EventAccumulator) => void,
): ForegroundHandle {
  const args = buildArgs(spec);
  const invocation = getPiInvocation(args);
  const acc = newAccumulator();

  // Tee events into the transcript file so /tasks can show history.
  const tee = fs.createWriteStream(spec.transcriptPath, { flags: "a" });

  let aborted = false;
  let procRef: ReturnType<typeof spawn> = null as any;
  const done = new Promise<{ exitCode: number; aborted: boolean }>((resolve) => {
    const proc = spawn(invocation.command, invocation.args, {
      cwd: spec.cwd ?? process.cwd(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: childEnv(spec),
      detached: true, // own process group so kill(-pid) axes bash children
    });

    let buffer = "";
    proc.stdout!.on("data", (data: Buffer) => {
      tee.write(data);
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const event = parseLine(line);
        if (event) {
          foldEvent(acc, event);
          onEvent(acc);
        }
      }
    });

    let stderrTail = "";
    proc.stderr!.on("data", (data: Buffer) => {
      const text = data.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      tee.write(JSON.stringify({ type: "lystic_stderr", text }) + "\n");
    });

    proc.on("close", (code) => {
      if (buffer.trim()) {
        const event = parseLine(buffer);
        if (event) foldEvent(acc, event);
      }
      tee.write(
        JSON.stringify({ type: "lystic_end", exit: code ?? 0, stderr: stderrTail }) + "\n",
      );
      tee.end();
      resolve({ exitCode: code ?? 0, aborted });
    });

    proc.on("error", () => {
      tee.end();
      resolve({ exitCode: 1, aborted });
    });

    if (signal) {
      const killChild = () => {
        aborted = true;
        try { proc.kill("SIGTERM"); } catch { /* ignore */ }
        setTimeout(() => {
          try { proc.kill("SIGKILL"); } catch { /* ignore */ }
        }, 5000);
      };
      if (signal.aborted) killChild();
      else signal.addEventListener("abort", killChild, { once: true });
    }

    procRef = proc;
  });

  return { proc: procRef, done };
}

// ─── Background spawn (file stdout, detached) ───────────────────────────────

export interface BackgroundHandle {
  proc: ReturnType<typeof spawn>;
  pid: number;
}

export function spawnBackground(spec: SpawnSpec): BackgroundHandle {
  const args = buildArgs(spec);
  const invocation = getPiInvocation(args);

  const outFd = fs.openSync(spec.transcriptPath, "a");
  const errFd = fs.openSync(spec.transcriptPath + ".err", "a");

  const proc = spawn(invocation.command, invocation.args, {
    cwd: spec.cwd ?? process.cwd(),
    shell: false,
    stdio: ["ignore", outFd, errFd],
    env: childEnv(spec),
    detached: true, // own process group — kill(-pid), survives parent reload
  });
  try { fs.closeSync(outFd); } catch { /* ignore */ }
  try { fs.closeSync(errFd); } catch { /* ignore */ }
  proc.unref();
  return { proc, pid: proc.pid! };
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  const term = () => {
    try { process.kill(-pid, "SIGTERM"); } catch { /* ignore */ }
    try { process.kill(pid, "SIGTERM"); } catch { /* ignore */ }
    try {
      spawn("pkill", ["-TERM", "-P", String(pid)], { stdio: "ignore" });
    } catch { /* ignore */ }
  };
  const kill = () => {
    try { process.kill(-pid, "SIGKILL"); } catch { /* ignore */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
    try {
      spawn("pkill", ["-KILL", "-P", String(pid)], { stdio: "ignore" });
    } catch { /* ignore */ }
  };
  term();
  setTimeout(kill, 400);
}
