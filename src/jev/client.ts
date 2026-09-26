import { createHash } from "node:crypto";

export const JEV_FEATURES = ["completionCheck", "stuckDetection", "evidenceSelection", "wakeTriage"] as const;
export type JevFeature = typeof JEV_FEATURES[number];
export type JevMode = "off" | "shadow" | "active";
export interface JevClientConfig {
  enabled: boolean | "auto";
  mode: JevMode;
  apiKeyEnv: string;
  model: string;
  timeoutMs: number;
  maxCallsPerGoal: number;
  maxCallsPerSession: number;
  maxInputChars: number;
  features: Record<JevFeature, boolean>;
}
export interface JevDependencies {
  fetch?: typeof fetch;
  env?: Record<string, string | undefined> | (() => Record<string, string | undefined>);
  now?: () => number;
  depth?: number;
}
export interface JevOptions { signal?: AbortSignal; key?: string }
export type JevAnswers = Record<string, number>;
interface FeatureStats { calls: number; actions: Record<string, number> }
interface Decision {
  feature: JevFeature;
  at: number;
  latencyMs: number;
  outcome: string;
  probabilities?: JevAnswers;
}
export interface JevSnapshot {
  version: 1;
  goalId?: string;
  calls: number;
  goalCalls: number;
  successes: number;
  errors: number;
  aborted: number;
  cacheHits: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  consecutiveErrors: number;
  circuitUntil: number;
  features: Record<JevFeature, FeatureStats>;
  recent: Decision[];
}

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const CACHE_LIMIT = 128;
const RESPONSE_LIMIT = 65_536;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER) : 0;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const identifier = (value: string) => /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/.test(value);
const fresh = (): JevSnapshot => ({
  version: 1, calls: 0, goalCalls: 0, successes: 0, errors: 0, aborted: 0,
  cacheHits: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0, consecutiveErrors: 0, circuitUntil: 0,
  features: Object.fromEntries(JEV_FEATURES.map(feature => [feature, { calls: 0, actions: {} }])) as Record<JevFeature, FeatureStats>,
  recent: [],
});

async function readResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > RESPONSE_LIMIT || !response.body) throw new Error("response size");
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0;
  let text = "";
  const decoder = new TextDecoder();
  try {
    if (signal.aborted) throw new Error("aborted");
    while (true) {
      const { value, done } = await reader.read();
      if (signal.aborted) throw new Error("aborted");
      if (done) break;
      size += value.byteLength;
      if (size > RESPONSE_LIMIT) throw new Error("response size");
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}

/** Remove credentials before state or question text reaches the remote endpoint. */
export function redactJevText(text: string, env: Record<string, string | undefined>, apiKey: string): string {
  const secrets = new Set([apiKey, ...Object.entries(env)
    .filter(([name, value]) => /(?:KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i.test(name) && value && value.length >= 8)
    .map(([, value]) => value!)]);
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|ts_[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/(["']?(?:[\w-]*(?:api[_-]?key|token|secret|password|passwd|credential)[\w-]*)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@");
}

/** Jev supplies probabilities. Callers retain control of every action. */
export class JevClient {
  private readonly fetcher: typeof fetch;
  private readonly environment: () => Record<string, string | undefined>;
  private readonly now: () => number;
  private readonly depth: number;
  private stats = fresh();
  private generation = 0;
  private rejectedKey?: string;
  private listener?: (snapshot: JevSnapshot) => void;
  private controllers = new Set<AbortController>();
  private cache = new Map<string, { promise: Promise<JevAnswers | undefined>; settled: boolean }>();

  constructor(readonly config: JevClientConfig, dependencies: JevDependencies = {}) {
    this.fetcher = dependencies.fetch ?? globalThis.fetch;
    const env = dependencies.env;
    this.environment = typeof env === "function" ? env : () => env ?? process.env;
    this.now = dependencies.now ?? Date.now;
    this.depth = dependencies.depth ?? 0;
  }

  get mode(): JevMode { return this.config.enabled === false ? "off" : this.config.mode; }

  availability(feature: JevFeature): { available: boolean; reason: string } {
    return this.availabilityState(feature, true);
  }

  private availabilityState(feature: JevFeature, includeBudgets: boolean): { available: boolean; reason: string } {
    let reason = "Jev is available.";
    const key = this.apiKey();
    if (this.depth !== 0) reason = "Jev is available only in the root session.";
    else if (this.mode === "off") reason = "Jev is off in the settings.";
    else if (!this.config.features[feature]) reason = "The feature is off in the settings.";
    else if (!this.validConfig()) reason = "The Jev settings are invalid.";
    else if (!key) reason = `The ${this.config.apiKeyEnv} key is absent or invalid.`;
    else if (this.rejectedKey === hash(key)) reason = "The API rejected the key.";
    else if (this.stats.circuitUntil > this.now()) reason = "Jev is paused after repeated API errors.";
    else if (includeBudgets && this.stats.calls >= this.config.maxCallsPerSession) reason = "The session request budget is spent.";
    else if (includeBudgets && this.stats.goalId && this.stats.goalCalls >= this.config.maxCallsPerGoal) reason = "The goal request budget is spent.";
    return { available: reason === "Jev is available.", reason };
  }

  canUse(feature: JevFeature): boolean { return this.availability(feature).available; }

  setGoal(key?: string): void {
    const goalId = key === undefined ? undefined : hash(key);
    if (goalId === this.stats.goalId) return;
    this.invalidate();
    this.stats.goalId = goalId;
    this.stats.goalCalls = 0;
    this.emit();
  }

  invalidate(): void {
    this.generation++;
    const cancelled = this.controllers.size;
    this.stats.aborted += cancelled;
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear();
    this.cache.clear();
    if (cancelled) this.emit();
  }

  setPersistence(listener?: (snapshot: JevSnapshot) => void): void { this.listener = listener; }
  snapshot(): JevSnapshot { return structuredClone(this.stats); }

  /** Session data contains counters and numeric decisions, never request state. */
  reset(snapshot?: unknown): void {
    this.invalidate();
    this.stats = fresh();
    this.rejectedKey = undefined;
    if (!isRecord(snapshot) || snapshot.version !== 1) return;
    for (const field of ["calls", "goalCalls", "successes", "errors", "aborted", "cacheHits", "inputTokens", "outputTokens", "latencyMs", "consecutiveErrors", "circuitUntil"] as const) {
      this.stats[field] = count(snapshot[field]);
    }
    // A saved clock value must not disable Jev indefinitely.
    this.stats.circuitUntil = Math.min(this.stats.circuitUntil, this.now() + 30_000);
    if (typeof snapshot.goalId === "string" && /^[a-f0-9]{64}$/.test(snapshot.goalId)) this.stats.goalId = snapshot.goalId;
    if (isRecord(snapshot.features)) {
      for (const feature of JEV_FEATURES) {
        const item = snapshot.features[feature];
        if (!isRecord(item)) continue;
        this.stats.features[feature].calls = count(item.calls);
        if (isRecord(item.actions)) {
          for (const [action, value] of Object.entries(item.actions).slice(0, 32)) {
            if (this.safeLabel(action)) this.stats.features[feature].actions[action] = count(value);
          }
        }
      }
    }
    if (Array.isArray(snapshot.recent)) {
      for (const item of snapshot.recent.slice(-12)) {
        if (!isRecord(item) || !JEV_FEATURES.includes(item.feature as JevFeature)) continue;
        if (typeof item.outcome !== "string" || !/^(?:ok|aborted|timeout|network|invalid_response|http_\d{3})$/.test(item.outcome)) continue;
        const probabilities: JevAnswers = {};
        if (isRecord(item.probabilities)) {
          for (const [id, value] of Object.entries(item.probabilities).slice(0, 32)) {
            if (this.safeLabel(id) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1) probabilities[id] = value;
          }
        }
        this.stats.recent.push({ feature: item.feature as JevFeature, at: count(item.at), latencyMs: count(item.latencyMs), outcome: item.outcome, ...(Object.keys(probabilities).length ? { probabilities } : {}) });
      }
    }
  }

  recordAction(feature: JevFeature, action: string): void {
    if (!this.safeLabel(action)) return;
    const actions = this.stats.features[feature].actions;
    if (!Object.hasOwn(actions, action) && Object.keys(actions).length >= 32) return;
    actions[action] = count(actions[action]) + 1;
    this.emit();
  }

  async evaluate(feature: JevFeature, state: unknown, questions: Record<string, string>, options: JevOptions = {}): Promise<JevAnswers | undefined> {
    if (options.signal?.aborted) return undefined;
    // Cached decisions cannot bypass a disabled feature or an absent key.
    if (!this.availabilityState(feature, false).available) return undefined;
    const apiKey = this.apiKey()!;
    let body: string;
    const names = Object.keys(questions);
    try {
      if (!names.length || names.length > 32 || names.some(name => !this.safeLabel(name) || typeof questions[name] !== "string" || !questions[name].trim())) return undefined;
      const env = this.environment();
      const typed = Object.fromEntries(names.map(name => [name, { type: "noul", instructions: redactJevText(questions[name], env, apiKey) }]));
      const input = redactJevText(typeof state === "string" ? state : JSON.stringify(state) ?? "", env, apiKey);
      // Never judge a partial snapshot. Callers must bound their own evidence.
      body = JSON.stringify({ model: this.config.model, state: input, questions: typed });
      if (body.length > this.config.maxInputChars) return undefined;
    } catch { return undefined; }

    const key = options.key === undefined ? undefined : hash(`${this.stats.goalId ?? "session"}\0${feature}\0${options.key}\0${body}`);
    const existing = key ? this.cache.get(key) : undefined;
    if (existing) {
      this.stats.cacheHits++;
      this.emit();
      return this.waitFor(existing.promise, options.signal);
    }
    if (!this.canUse(feature)) return undefined;

    // Reserve synchronously so simultaneous features cannot exceed either budget.
    this.stats.calls++;
    if (this.stats.goalId) this.stats.goalCalls++;
    this.stats.features[feature].calls++;
    this.emit();
    const generation = this.generation;
    const promise = this.request(feature, body, names, apiKey, generation, options.signal);
    if (key) {
      // Do not let a large group of pending requests create an unbounded cache.
      if (this.cache.size >= CACHE_LIMIT) {
        const oldestSettled = [...this.cache].find(([, entry]) => entry.settled);
        if (oldestSettled) this.cache.delete(oldestSettled[0]);
      }
      const entry = { promise, settled: false };
      if (this.cache.size < CACHE_LIMIT) this.cache.set(key, entry);
      void promise.then(result => {
        entry.settled = true;
        if (!result && this.cache.get(key) === entry) this.cache.delete(key);
        this.trimCache();
      });
      this.trimCache();
    }
    return this.waitFor(promise, options.signal);
  }

  private apiKey(): string | undefined {
    const value = this.environment()[this.config.apiKeyEnv];
    // Check header safety without assuming an undocumented provider key format.
    return value && value.length >= 8 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value) ? value : undefined;
  }
  private safeLabel(value: string): boolean {
    return identifier(value) && redactJevText(value, this.environment(), this.apiKey() ?? "") === value;
  }
  private validConfig(): boolean {
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(this.config.apiKeyEnv)
      && typeof this.config.model === "string" && /^jev-[A-Za-z0-9.-]+$/.test(this.config.model)
      && [this.config.timeoutMs, this.config.maxInputChars].every(value => Number.isSafeInteger(value) && value > 0)
      && [this.config.maxCallsPerGoal, this.config.maxCallsPerSession].every(value => Number.isSafeInteger(value) && value >= 0)
      && this.config.timeoutMs <= 60_000 && this.config.maxInputChars <= 1_000_000;
  }
  private trimCache(): void {
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= CACHE_LIMIT) break;
      if (entry.settled) this.cache.delete(key);
    }
  }
  private emit(): void { try { this.listener?.(this.snapshot()); } catch { /* Reporting cannot stop the harness. */ } }

  private async waitFor(promise: Promise<JevAnswers | undefined>, signal?: AbortSignal): Promise<JevAnswers | undefined> {
    if (signal?.aborted) return undefined;
    let onAbort: (() => void) | undefined;
    try {
      const result = signal ? await Promise.race([promise, new Promise<undefined>(resolve => {
        onAbort = () => resolve(undefined);
        signal.addEventListener("abort", onAbort, { once: true });
      })]) : await promise;
      return result ? { ...result } : undefined;
    } finally { if (signal && onAbort) signal.removeEventListener("abort", onAbort); }
  }

  private async request(feature: JevFeature, body: string, names: string[], apiKey: string, generation: number, signal?: AbortSignal): Promise<JevAnswers | undefined> {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) controller.abort();
    this.controllers.add(controller);
    let timedOut = false;
    let outcome = "network";
    let probabilities: JevAnswers | undefined;
    const started = this.now();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs);
    let abortListener: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error("aborted"));
        controller.signal.addEventListener("abort", abortListener, { once: true });
        if (controller.signal.aborted) abortListener();
      });
      const operation = async () => {
        const response = await this.fetcher(ENDPOINT, {
          method: "POST", redirect: "error", credentials: "omit",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body, signal: controller.signal,
        });
        if (!response.ok) {
          outcome = `http_${response.status}`;
          if ((response.status === 401 || response.status === 403) && generation === this.generation) this.rejectedKey = hash(apiKey);
          throw new Error("http");
        }
        outcome = "invalid_response";
        // The same deadline covers the response headers and response body.
        const data = await readResponse(response, controller.signal);
        if (!isRecord(data) || !isRecord(data.answers) || Object.keys(data.answers).length !== names.length) throw new Error("answers");
        const result: JevAnswers = {};
        for (const name of names) {
          const answer = data.answers[name];
          if (!isRecord(answer) || answer.type !== "noul" || typeof answer.noul !== "number" || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error("answer");
          result[name] = answer.noul;
        }
        if (generation !== this.generation || controller.signal.aborted) throw new Error("aborted");
        if (isRecord(data.usage)) {
          this.stats.inputTokens += count(data.usage.input_tokens);
          this.stats.outputTokens += count(data.usage.output_tokens);
        }
        return result;
      };
      probabilities = await Promise.race([operation(), aborted]);
      if (generation !== this.generation || controller.signal.aborted) return undefined;
      outcome = "ok";
      this.stats.successes++;
      this.stats.consecutiveErrors = 0;
      this.stats.circuitUntil = 0;
      return probabilities;
    } catch {
      if (generation !== this.generation) return undefined;
      if (controller.signal.aborted) outcome = timedOut ? "timeout" : "aborted";
      if (outcome === "aborted") this.stats.aborted++;
      else {
        this.stats.errors++;
        this.stats.consecutiveErrors++;
        if (this.stats.consecutiveErrors >= 3) this.stats.circuitUntil = this.now() + 30_000;
      }
      return undefined;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (abortListener) controller.signal.removeEventListener("abort", abortListener);
      this.controllers.delete(controller);
      if (generation === this.generation) {
        const latencyMs = Math.max(0, this.now() - started);
        this.stats.latencyMs += latencyMs;
        this.stats.recent.push({ feature, at: this.now(), latencyMs, outcome, ...(probabilities ? { probabilities } : {}) });
        this.stats.recent = this.stats.recent.slice(-12);
        this.emit();
      }
    }
  }
}
