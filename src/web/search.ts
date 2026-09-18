/**
 * web_search — xAI server-side search, grok-build style.
 *
 * Improvements over v1:
 *  - Retry with backoff on 429 / 5xx / network errors (honors Retry-After).
 *  - Timeout vs cancel classification; timeouts retry once per credential.
 *  - Final error carries failure kind, HTTP status, and attempt count.
 *  - Credential circuit breaker: 401/403 trips a 10-minute breaker.
 *  - Inline citations normalized from [[N]](url) to [N](url).
 *  - xAI usage mapped onto pi tool-result usage for /session totals.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { SEARCH_BASE_URL, SEARCH_MODEL, SEARCH_TIMEOUT_MS, SEARCH_X_SEARCH } from "../config";
import { resolveCredentials, tripBreaker, resetBreaker, allBreakersOpen } from "../auth";
import { abortableSleep } from "../http";

const MAX_ATTEMPTS_PER_CREDENTIAL = 3;

interface Citation {
  url: string;
  title?: string;
}

interface SearchOutcome {
  text: string;
  citations: Citation[];
  auth: string;
  usage?: { input: number; output: number; totalTokens: number };
}

function parseResponse(data: any): { text: string; citations: Citation[]; usage?: SearchOutcome["usage"] } {
  const citations: Citation[] = [];
  const seen = new Set<string>();
  let text = "";

  const output = Array.isArray(data?.output) ? data.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const block of content) {
      if (block?.type === "output_text" && typeof block.text === "string") {
        text += block.text;
      }
      for (const a of Array.isArray(block?.annotations) ? block.annotations : []) {
        if (a?.type === "url_citation" && typeof a.url === "string" && !seen.has(a.url)) {
          seen.add(a.url);
          citations.push({ url: a.url, title: typeof a.title === "string" ? a.title : undefined });
        }
      }
    }
  }

  // Normalize xAI inline citations: [[1]](url) -> [1](url).
  text = text.replace(/\[\[(\d+)\]\]/g, "[$1]").trim();

  const u = data?.usage;
  const usage = u
    ? {
        input: u.input_tokens ?? u.input ?? 0,
        output: u.output_tokens ?? u.output ?? 0,
        totalTokens: u.total_tokens ?? u.total ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0),
      }
    : undefined;

  return { text, citations, usage };
}

type SearchFailure = {
  ok: false;
  /** What went wrong: no response (timeout/network), HTTP error, or caller cancel. */
  kind: "network" | "timeout" | "http" | "cancelled";
  /** HTTP status, or 0 when no response was received. */
  status: number;
  retryable: boolean;
  retryAfterMs?: number;
  error: string;
};

type SearchResult = { ok: true; data: any } | SearchFailure;

async function searchOnce(
  query: string,
  allowedDomains: string[] | undefined,
  excludedDomains: string[] | undefined,
  credential: { key: string; label: string },
  signal: AbortSignal | undefined,
): Promise<SearchResult> {
  const filters: Record<string, string[]> = {};
  if (allowedDomains?.length) filters.allowed_domains = allowedDomains;
  if (excludedDomains?.length) filters.excluded_domains = excludedDomains;
  const webSearchTool: Record<string, unknown> = { type: "web_search" };
  if (Object.keys(filters).length > 0) webSearchTool.filters = filters;

  // Server-side tools: grok decides which to run. x_search lets it reach X
  // posts when the query calls for them, without a dedicated pi-side tool.
  const tools: Record<string, unknown>[] = [webSearchTool];
  if (SEARCH_X_SEARCH) tools.push({ type: "x_search" });

  const body = {
    model: SEARCH_MODEL,
    input: query,
    tools,
    store: false,
    temperature: 0.1,
    top_p: 0.95,
    max_output_tokens: 8192,
  };

  const timeout = AbortSignal.timeout(SEARCH_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response: Response;
  try {
    response = await fetch(`${SEARCH_BASE_URL}/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${credential.key}` },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (error) {
    if (signal?.aborted) {
      return { ok: false, kind: "cancelled", status: 0, retryable: false, error: "cancelled by caller" };
    }
    const err = error as Error;
    if (timeout.aborted || err?.name === "TimeoutError") {
      return {
        ok: false,
        kind: "timeout",
        status: 0,
        retryable: true,
        error: `no response: request timed out after ${SEARCH_TIMEOUT_MS / 1000}s`,
      };
    }
    return { ok: false, kind: "network", status: 0, retryable: true, error: `network error: ${err?.message ?? String(error)}` };
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 300);
    const retryable = response.status === 429 || response.status >= 500;
    const retryAfterHeader = Number(response.headers.get("retry-after") ?? "");
    const retryAfterMs = Number.isFinite(retryAfterHeader) && retryAfterHeader > 0 ? retryAfterHeader * 1000 : undefined;
    return { ok: false, kind: "http", status: response.status, retryable, retryAfterMs, error: `HTTP ${response.status}: ${detail}` };
  }

  return { ok: true, data: await response.json() };
}

async function runSearch(
  query: string,
  allowedDomains: string[] | undefined,
  excludedDomains: string[] | undefined,
  ctx: any,
  signal: AbortSignal | undefined,
): Promise<SearchOutcome> {
  if (await allBreakersOpen(ctx)) {
    throw new Error(
      "All xAI credentials are tripped (recent 401/403). Run /login or check XAI_API_KEY. Breakers reset in at most 10 minutes.",
    );
  }

  const credentials = await resolveCredentials(ctx);
  if (credentials.length === 0) {
    throw new Error("No xAI credentials. Log in with /login, or export XAI_API_KEY.");
  }

  let lastError = "search failed";
  for (const credential of credentials) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_CREDENTIAL; attempt++) {
      const result = await searchOnce(query, allowedDomains, excludedDomains, credential, signal);
      if (result.ok) {
        resetBreaker(credential.label);
        const parsed = parseResponse(result.data);
        if (!parsed.text && parsed.citations.length === 0) {
          lastError = `xAI search returned no content (${credential.label}, attempt ${attempt})`;
          break; // empty success is not retryable — next credential
        }
        return {
          text: parsed.text,
          citations: parsed.citations,
          auth: credential.label,
          usage: parsed.usage,
        };
      }

      const where =
        `xAI search (${credential.label}, attempt ${attempt}/${MAX_ATTEMPTS_PER_CREDENTIAL}) ` +
        `${result.kind}${result.status ? ` ${result.status}` : ""}: ${result.error}`;
      lastError = where;

      // Caller cancelled: stop everything, do not retry.
      if (result.kind === "cancelled" || signal?.aborted) {
        throw new Error("web_search cancelled");
      }
      if (result.status === 401 || result.status === 403) {
        tripBreaker(credential.label);
        break; // switch credential
      }
      // A timeout means the server is slow: retry once, then give up on this credential.
      if (result.kind === "timeout" && attempt >= 2) break;
      if (!result.retryable || attempt === MAX_ATTEMPTS_PER_CREDENTIAL) break;

      // Backoff: honor Retry-After header, else exponential (1s, 3s).
      const delayMs = result.retryAfterMs ?? (attempt === 1 ? 1000 : 3000);
      try {
        await abortableSleep(delayMs, signal);
      } catch {
        throw new Error("web_search cancelled during retry backoff");
      }
    }
  }
  throw new Error(`web_search failed: ${lastError}`);
}

export function registerWebSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web for up-to-date information using xAI server-side search. " +
      "Returns a synthesized answer with numbered source citations. Also finds X posts " +
      "when the query is about them. Best for current events, documentation, APIs, " +
      "and anything not in local files.",
    promptSnippet: "Search the web via xAI and return a cited answer",
    promptGuidelines: [
      "Use web_search when you need current information from the internet before answering.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "The search query to perform." }),
      allowed_domains: Type.Optional(
        Type.Array(Type.String(), { description: "Optional list of domains to restrict search to." }),
      ),
      excluded_domains: Type.Optional(
        Type.Array(Type.String(), { description: "Optional list of domains to exclude from search." }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const outcome = await runSearch(
        params.query,
        params.allowed_domains,
        params.excluded_domains,
        ctx,
        signal,
      );

      const sourceList = outcome.citations
        .map((c, i) => `[${i + 1}] ${c.title ? `${c.title} — ` : ""}${c.url}`)
        .join("\n");
      const resultText = sourceList ? `${outcome.text}\n\nSources:\n${sourceList}` : outcome.text;

      return {
        content: [{ type: "text", text: resultText }],
        details: {
          query: params.query,
          model: SEARCH_MODEL,
          auth: outcome.auth,
          citations: outcome.citations,
        },
        usage: outcome.usage
          ? {
              input: outcome.usage.input,
              output: outcome.usage.output,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: outcome.usage.totalTokens,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            }
          : undefined,
      };
    },
  });
}
