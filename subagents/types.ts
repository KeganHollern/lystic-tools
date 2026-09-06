/** Shared types for the lystic subagent system. */

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  /** Child thinking level. Never inherit the parent's "max". */
  thinking?: string;
  systemPrompt: string;
  source: "user" | "project";
}

export type SubagentStatus = "running" | "waiting" | "completed" | "failed" | "killed";

export interface ChildUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface ChildRecord {
  id: string;
  type: string;
  description: string;
  prompt: string;
  depth: number;
  parentId?: string;
  status: SubagentStatus;
  background: boolean;
  pid?: number;
  cwd?: string;
  model?: string;
  startedAt: number;
  endedAt?: number;
  usage: ChildUsage;
  toolCalls?: number;
  output: string;
  stopReason?: string;
  errorMessage?: string;
  transcriptPath: string;
}

export function emptyUsage(): ChildUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
}

export interface ParsedEvent {
  type: string;
  message?: any;
  [key: string]: unknown;
}
