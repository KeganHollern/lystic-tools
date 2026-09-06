/**
 * web_fetch — faithful port of grok-build's web_fetch, plus:
 *  - Multi-URL support (urls[], max 5, concurrency 3).
 *  - Overflow artifacts: full content saved to the session downloads folder
 *    when inline markdown is truncated.
 *  - Readability + Turndown extraction with regex fallback.
 *  - Allowlist from lystic-tools.yaml / env, on top of grok-build's defaults.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  FETCH_CACHE_MAX_ENTRIES,
  FETCH_CACHE_TTL_MS,
  FETCH_EXTRA_DOMAINS,
  FETCH_MAX_MARKDOWN_CHARS,
  config,
} from "./config";
import { fetchWithChecks } from "./http";
import { htmlToMarkdown } from "./markdown";

// ─── Domain allowlist (copied from grok-build web_fetch/config.rs) ──────────

const DEFAULT_ALLOWED_DOMAINS: string[] = [
  // xAI
  "x.ai", "console.x.ai", "docs.x.ai", "api.x.ai",
  // Programming languages
  "docs.python.org", "en.cppreference.com", "docs.oracle.com", "learn.microsoft.com",
  "developer.mozilla.org", "go.dev", "pkg.go.dev", "www.php.net", "docs.swift.org",
  "kotlinlang.org", "ruby-doc.org", "doc.rust-lang.org", "docs.rs", "www.typescriptlang.org",
  // Web and JS frameworks
  "react.dev", "angular.io", "vuejs.org", "nextjs.org", "expressjs.com", "nodejs.org",
  "bun.sh", "jquery.com", "getbootstrap.com", "tailwindcss.com", "d3js.org", "threejs.org",
  "redux.js.org", "webpack.js.org", "jestjs.io", "reactrouter.com",
  // Python frameworks
  "docs.djangoproject.com", "flask.palletsprojects.com", "fastapi.tiangolo.com",
  "pandas.pydata.org", "numpy.org", "www.tensorflow.org", "pytorch.org",
  "scikit-learn.org", "matplotlib.org", "requests.readthedocs.io", "jupyter.org",
  // PHP frameworks
  "laravel.com", "symfony.com", "wordpress.org",
  // Java frameworks
  "docs.spring.io", "hibernate.org", "tomcat.apache.org", "gradle.org", "maven.apache.org",
  // .NET
  "asp.net", "dotnet.microsoft.com", "nuget.org", "blazor.net",
  // Mobile
  "reactnative.dev", "docs.flutter.dev", "developer.apple.com", "developer.android.com",
  // Data science / ML
  "keras.io", "spark.apache.org", "huggingface.co", "www.kaggle.com",
  // Databases
  "redis.io", "www.postgresql.org", "dev.mysql.com", "www.sqlite.org", "graphql.org", "prisma.io",
  // Cloud and DevOps
  "docs.aws.amazon.com", "cloud.google.com", "kubernetes.io", "www.docker.com",
  "www.terraform.io", "www.ansible.com", "vercel.com/docs", "docs.netlify.com",
  "devcenter.heroku.com",
  // Testing and monitoring
  "cypress.io", "selenium.dev",
  // Game development
  "docs.unity.com", "docs.unrealengine.com",
  // Other tools
  "git-scm.com", "nginx.org", "httpd.apache.org",
  // ── Community additions beyond grok-build's default list ──
  // Code hosting and raw content
  "github.com", "raw.githubusercontent.com", "gist.github.com", "docs.github.com", "docs.gitlab.com",
  // Q&A
  "stackoverflow.com", "serverfault.com", "superuser.com",
  // Package registries
  "npmjs.com", "registry.npmjs.org", "pypi.org", "crates.io", "rubygems.org", "packagist.org", "lib.rs",
  // Web platform and browsers
  "developer.chrome.com", "web.dev", "developers.google.com", "deno.land",
  // JS tooling
  "svelte.dev", "vite.dev", "eslint.org", "prettier.io", "pnpm.io", "yarnpkg.com", "astro.build", "preactjs.com", "solidjs.com",
  // More languages
  "docs.scala-lang.org", "elixir-lang.org", "hexdocs.pm", "www.erlang.org", "clojure.org", "clojuredocs.org",
  "perldoc.perl.org", "dart.dev", "ziglang.org", "nim-lang.org", "www.lua.org", "ocaml.org",
  "www.haskell.org", "hackage.haskell.org",
  // Cloud, infra, observability
  "docs.docker.com", "developer.hashicorp.com", "prometheus.io/docs", "grafana.com/docs", "jenkins.io/doc",
  // More databases
  "www.mongodb.com/docs", "clickhouse.com/docs", "neo4j.com/docs", "www.elastic.co/guide", "duckdb.org",
  // Standards and specs
  "www.w3.org", "whatwg.org", "rfc-editor.org", "datatracker.ietf.org", "www.ietf.org",
  // Security reference
  "owasp.org", "cve.org", "nvd.nist.gov",
  // AI provider docs
  "docs.anthropic.com", "platform.openai.com", "ai.google.dev",
  // Unix, Linux, and shells
  "man7.org", "man.archlinux.org", "wiki.archlinux.org", "tldp.org", "www.debian.org",
  "docs.brew.sh", "curl.se", "neovim.io/doc", "vimhelp.org", "nixos.org", "www.gnu.org",
  // General reference
  "en.wikipedia.org",
];

function normalizeDomain(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "").replace(/\.+$/, "");
  s = s.replace(/^www\./i, "").toLowerCase();
  return s;
}

/** Entries: host-only ("docs.rs") or host+path prefix ("vercel.com/docs"). */
function buildAllowlist(): Map<string, string[]> {
  const entries = config.webFetch?.allowedDomains?.length
    ? [...config.webFetch.allowedDomains, ...FETCH_EXTRA_DOMAINS]
    : [...DEFAULT_ALLOWED_DOMAINS, ...FETCH_EXTRA_DOMAINS];

  const map = new Map<string, string[]>();
  for (const entry of entries) {
    const normalized = normalizeDomain(entry);
    if (!normalized) continue;
    const slash = normalized.indexOf("/");
    const host = slash === -1 ? normalized : normalized.slice(0, slash);
    const prefix = slash === -1 ? "" : normalized.slice(slash).replace(/\/+$/, "");
    const prefixes = map.get(host) ?? [];
    // A bare host entry subsumes all path prefixes for that host.
    if (prefix === "" || prefixes.includes("")) prefixes.length = 0;
    if (prefix === "" || !prefixes.includes("")) prefixes.push(prefix || "");
    map.set(host, prefixes);
  }
  return map;
}

const ALLOWLIST = buildAllowlist();

function domainAllowed(url: URL): boolean {
  const host = normalizeDomain(url.hostname);
  const prefixes = ALLOWLIST.get(host);
  if (!prefixes) return false;
  if (prefixes.includes("")) return true;
  const path = url.pathname.replace(/\/+$/, "");
  return prefixes.some((p) => path === p || path.startsWith(`${p}/`));
}

// ─── Downloads and artifacts ────────────────────────────────────────────────

const EXT_BY_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
};

function magicMatches(contentType: string, bytes: Uint8Array): boolean {
  const starts = (sig: number[]) => sig.every((b, i) => bytes[i] === b);
  switch (contentType) {
    case "application/pdf": return starts([0x25, 0x50, 0x44, 0x46]); // %PDF
    case "image/png": return starts([0x89, 0x50, 0x4e, 0x47]);
    case "image/jpeg": return starts([0xff, 0xd8, 0xff]);
    case "image/gif": return starts([0x47, 0x49, 0x46, 0x38]);
    case "video/mp4": return starts([0x00, 0x00, 0x00]);
    default: return true;
  }
}

async function downloadsDir(ctx: any): Promise<string> {
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  const base = sessionFile
    ? join(dirname(sessionFile), "web-fetch-downloads")
    : join(tmpdir(), "pi-web-fetch");
  await mkdir(base, { recursive: true });
  return base;
}

async function saveDownload(
  ctx: any,
  url: string,
  contentType: string,
  bytes: Uint8Array,
  extOverride?: string,
): Promise<string> {
  const base = await downloadsDir(ctx);
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const file = join(base, `${hash}${extOverride ?? EXT_BY_TYPE[contentType] ?? ".bin"}`);
  await writeFile(file, bytes);
  return file;
}

// ─── Cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, { expires: number; output: string }>();

function cacheGet(url: string): string | undefined {
  const hit = cache.get(url);
  if (!hit) return undefined;
  if (Date.now() > hit.expires) {
    cache.delete(url);
    return undefined;
  }
  // LRU touch.
  cache.delete(url);
  cache.set(url, hit);
  return hit.output;
}

function cacheSet(url: string, output: string): void {
  while (cache.size >= FETCH_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(url, { expires: Date.now() + FETCH_CACHE_TTL_MS, output });
}

// ─── Per-URL pipeline ────────────────────────────────────────────────────────

interface UrlOutcome {
  text: string;
  details: Record<string, unknown>;
}

async function fetchOne(urlInput: string, ctx: any, signal: AbortSignal | undefined): Promise<UrlOutcome> {
  let raw = urlInput.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `https://${raw}`;

  const { assertPublicHttpUrl } = await import("./http");
  const url = await assertPublicHttpUrl(raw);
  if (!domainAllowed(url)) {
    throw new Error(
      `Domain "${url.hostname}" is not in the web_fetch allowlist. Use web_search for this site instead.`,
    );
  }

  const cached = cacheGet(raw);
  if (cached !== undefined) {
    return { text: cached, details: { url: raw, path: "cache" } };
  }

  const { bytes, contentType, status, finalUrl } = await fetchWithChecks(raw, signal);

  // Text-ish content returns inline.
  if (
    contentType.startsWith("text/") ||
    contentType === "application/json" ||
    contentType === "application/javascript" ||
    contentType === "application/xml" ||
    contentType === "application/yaml"
  ) {
    const source = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const looksHtml = /<html|<!doctype|<body|<div|<p\b/i.test(source.slice(0, 2000));
    const body = looksHtml ? htmlToMarkdown(source, finalUrl) : source.trim();

    let output = body;
    let artifact: string | undefined;
    if (body.length > FETCH_MAX_MARKDOWN_CHARS) {
      // Overflow: keep the full text on disk, truncate inline.
      artifact = await saveDownload(ctx, raw, "text/markdown", new TextEncoder().encode(body), ".md");
      output =
        `${body.slice(0, FETCH_MAX_MARKDOWN_CHARS)}\n\n` +
        `[truncated at ${FETCH_MAX_MARKDOWN_CHARS} characters — full content saved to: ${artifact}]`;
    }
    cacheSet(raw, output);
    return {
      text: output || "(empty response body)",
      details: { url: raw, path: "local", status, contentType, artifact },
    };
  }

  // Everything else is a download.
  if (!magicMatches(contentType, bytes)) {
    throw new Error(`Content-Type ${contentType} does not match the file's magic bytes`);
  }
  const file = await saveDownload(ctx, finalUrl, contentType, bytes);
  const output =
    `Saved ${contentType} (${bytes.byteLength} bytes) from ${finalUrl} to:\n${file}\n` +
    "The file is on disk; use read or bash to inspect it.";
  cacheSet(raw, output);
  return { text: output, details: { url: raw, path: "download", status, contentType, file } };
}

/** Run tasks with limited concurrency; every task settles. */
async function pooled<T, R>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]).then(
        (value): PromiseSettledResult<R> => ({ status: "fulfilled", value }),
        (reason): PromiseSettledResult<R> => ({ status: "rejected", reason }),
      );
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── Tool ────────────────────────────────────────────────────────────────────

export function registerWebFetch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch documentation pages from allowed domains and return them as clean markdown. " +
      "Accepts a single url or up to five urls at once. " +
      "PDF, image, and video responses are saved to disk and the file path is returned. " +
      "Domains outside the allowlist are refused; use web_search for those.",
    promptSnippet: "Fetch allowed documentation URLs as markdown; saves media files to disk",
    promptGuidelines: [
      "Use web_fetch to read documentation pages in full after web_search finds them.",
      "Pass multiple related URLs in one call with urls when reading several pages.",
      "If web_fetch refuses a domain, use web_search with that URL or query instead.",
    ],
    parameters: Type.Object({
      url: Type.Optional(Type.String({ description: "Single URL to fetch. A scheme is added if missing." })),
      urls: Type.Optional(
        Type.Array(Type.String(), {
          description: "Multiple URLs to fetch (max 5). Runs up to three at a time.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const list =
        params.urls && params.urls.length > 0 ? params.urls : params.url ? [params.url] : [];
      if (list.length === 0) {
        throw new Error("Provide either url or urls.");
      }
      if (list.length > 5) {
        throw new Error(`Too many URLs: ${list.length} (max 5).`);
      }

      const outcomes = await pooled(list, 3, (u) => fetchOne(u, ctx, signal));

      // Single URL: success returns text, failure throws (existing behavior).
      if (outcomes.length === 1) {
        const only = outcomes[0];
        if (only.status === "fulfilled") {
          return {
            content: [{ type: "text", text: only.value.text }],
            details: only.value.details,
          };
        }
        throw new Error((only.reason as Error)?.message ?? "fetch failed");
      }

      // Multiple URLs: per-URL sections; inline errors; throw only if all fail.
      const sections: string[] = [];
      const perUrl: Record<string, unknown>[] = [];
      let fulfilled = 0;
      for (let i = 0; i < list.length; i++) {
        const outcome = outcomes[i];
        if (outcome.status === "fulfilled") {
          fulfilled++;
          sections.push(`## ${list[i]}\n\n${outcome.value.text}`);
          perUrl.push(outcome.value.details);
        } else {
          sections.push(`## ${list[i]}\n\n> fetch failed: ${(outcome.reason as Error)?.message ?? "unknown error"}`);
          perUrl.push({ url: list[i], error: (outcome.reason as Error)?.message });
        }
      }
      if (fulfilled === 0) {
        throw new Error(`All fetches failed. First error: ${(outcomes[0] as PromiseRejectedResult).reason?.message ?? "unknown"}`);
      }

      const text = sections.join("\n\n---\n\n");
      return { content: [{ type: "text", text }], details: { multi: true, perUrl } };
    },
  });
}
