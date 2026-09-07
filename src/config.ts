/**
 * Unified lystic-tools configuration.
 *
 * Reads ~/.pi/agent/lystic-tools.yaml (or .yml / .json) once at load.
 * Precedence for every value: config file > environment variable > built-in default.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

export interface WebSearchConfig {
  model?: string;
  baseUrl?: string;
  /** Send the server-side x_search tool alongside web_search. Default true. */
  xSearch?: boolean;
}

export interface WebFetchConfig {
  /** If set, replaces the built-in allowlist entirely. */
  allowedDomains?: string[];
  /** Appended to the allowlist (config file). */
  extraAllowedDomains?: string[];
  timeoutSecs?: number;
  maxBytes?: number;
  maxMarkdownChars?: number;
  cacheTtlSecs?: number;
  cacheMaxEntries?: number;
}

export interface SubagentsConfig {
  enabled?: boolean;
  /** Maximum delegation depth. Children at maxDepth get no task tools. Default 2. */
  maxDepth?: number;
  /** Max concurrently running children (admission control). Default 4. */
  maxParallel?: number;
  /** Cap on child output returned inline. Default 20000 chars. */
  outputCap?: number;
  /** Which agent directories to load: user | project | both. Default user. */
  agentScope?: "user" | "project" | "both";
  /** Inject a one-line completion notice into the parent model. Default false. */
  autoWake?: boolean;
}

export interface GoalConfig {
  enabled?: boolean;
  /** Skeptics per verification panel. Default 2. */
  skeptics?: number;
  /** Failed verifications between idea-guy runs. Default 3. */
  ideaGuyAfter?: number;
  /** Consecutive blocked_reason calls before the goal pauses. Default 3. */
  blockedPauseAfter?: number;
}

export interface LysticToolsConfig {
  webSearch?: WebSearchConfig;
  webFetch?: WebFetchConfig;
  subagents?: SubagentsConfig;
  goal?: GoalConfig;
}

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function loadConfigFile(): LysticToolsConfig {
  const dir = agentDir();
  const candidates = ["lystic-tools.yaml", "lystic-tools.yml", "lystic-tools.json"];
  for (const name of candidates) {
    const path = join(dir, name);
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf8");
      const parsed = name.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
      if (parsed && typeof parsed === "object") return parsed as LysticToolsConfig;
      return {};
    } catch (error) {
      console.error(`[lystic-tools] failed to parse ${path}: ${error}. Using defaults.`);
      return {};
    }
  }
  return {};
}

export const config: LysticToolsConfig = loadConfigFile();

// ─── Resolved values (config > env > default) ───────────────────────────────

export const SEARCH_BASE_URL = (
  config.webSearch?.baseUrl ??
  process.env.XAI_SEARCH_BASE_URL ??
  "https://api.x.ai/v1"
).replace(/\/+$/, "");

export const SEARCH_MODEL = config.webSearch?.model ?? process.env.XAI_SEARCH_MODEL ?? "grok-4.6";
export const SEARCH_X_SEARCH = config.webSearch?.xSearch ?? true;

export const FETCH_TIMEOUT_MS = (config.webFetch?.timeoutSecs ?? 60) * 1000;
export const FETCH_MAX_BYTES = config.webFetch?.maxBytes ?? 10 * 1024 * 1024;
export const FETCH_MAX_MARKDOWN_CHARS = config.webFetch?.maxMarkdownChars ?? 100_000;
export const FETCH_CACHE_TTL_MS = (config.webFetch?.cacheTtlSecs ?? 900) * 1000;
export const FETCH_CACHE_MAX_ENTRIES = config.webFetch?.cacheMaxEntries ?? 128;

export const FETCH_EXTRA_DOMAINS: string[] = [
  ...(config.webFetch?.extraAllowedDomains ?? []),
  ...(process.env.XAI_FETCH_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
];

export const SUBAGENTS_ENABLED = config.subagents?.enabled ?? true;
export const SUBAGENTS_MAX_DEPTH = config.subagents?.maxDepth ?? 2;
export const SUBAGENTS_MAX_PARALLEL = config.subagents?.maxParallel ?? 4;
export const SUBAGENTS_OUTPUT_CAP = config.subagents?.outputCap ?? 20_000;
export const SUBAGENTS_AGENT_SCOPE = config.subagents?.agentScope ?? "user";
export const SUBAGENTS_AUTO_WAKE = config.subagents?.autoWake ?? true;
/** Depth of THIS pi process: 0 = root session, 1+ = subagent. */
export const SUBAGENT_DEPTH = Number.parseInt(process.env.LYSTIC_SUBAGENT_DEPTH ?? "0", 10) || 0;

export const GOAL_ENABLED = config.goal?.enabled ?? true;
export const GOAL_SKEPTICS = Math.max(1, config.goal?.skeptics ?? 2);
export const GOAL_IDEA_AFTER = Math.max(1, config.goal?.ideaGuyAfter ?? 3);
/** Blocked reports before the goal pauses; the idea guy fires after every 3. */
export const GOAL_BLOCKED_PAUSE = Math.max(3, config.goal?.blockedPauseAfter ?? 12);
/** Cadence of blocked reports that summons the idea guy. */
export const GOAL_BLOCKED_IDEA_EVERY = 3;
