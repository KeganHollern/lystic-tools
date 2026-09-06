/**
 * Shared HTTP layer for lystic-tools: SSRF fail-closed validation,
 * per-hop redirect re-validation, size and time caps.
 */

import { lookup } from "node:dns/promises";
import { FETCH_MAX_BYTES, FETCH_TIMEOUT_MS } from "./config";

export const USER_AGENT = "Mozilla/5.0 (compatible; pi-agent/1.0)";
export const FETCH_ACCEPT =
  "text/markdown,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
export const MAX_REDIRECTS = 10;

// ─── Private address checks ──────────────────────────────────────────────────

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((n, part) => (n << 8) + Number(part), 0) >>> 0;
}

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const inRange = (base: number, bits: number) => (n >>> (32 - bits)) === (base >>> (32 - bits));
  return (
    inRange(0x00000000, 8) || // 0.0.0.0/8
    inRange(0x7f000000, 8) || // 127.0.0.0/8 loopback
    inRange(0x0a000000, 8) || // 10.0.0.0/8
    inRange(0xac100000, 12) || // 172.16.0.0/12
    inRange(0xc0a80000, 16) || // 192.168.0.0/16
    inRange(0xa9fe0000, 16) || // 169.254.0.0/16 link-local / cloud metadata
    inRange(0xe0000000, 4) // 224.0.0.0/4 multicast
  );
}

function isPrivateV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe80:")) return true; // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique local
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); // v4-mapped
  if (mapped) return isPrivateV4(mapped[1]);
  return false;
}

export async function assertPublicHttpUrl(urlStr: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw new Error(`Invalid URL: ${urlStr}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed, got: ${url.protocol}`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("localhost is not allowed");
  }
  const addresses = await lookup(hostname, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new Error(`DNS lookup failed for ${hostname}`);
  for (const { address, family } of addresses) {
    if (family === 6 ? isPrivateV6(address) : isPrivateV4(address)) {
      throw new Error(`Refusing to fetch private address ${address}`);
    }
  }
  return url;
}

// ─── Fetch with per-hop re-validation ───────────────────────────────────────

async function readCapped(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > FETCH_MAX_BYTES) {
    throw new Error(`Response too large: ${declared} bytes (max ${FETCH_MAX_BYTES})`);
  }
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > FETCH_MAX_BYTES) {
    throw new Error(`Response too large: ${buffer.byteLength} bytes`);
  }
  return buffer;
}

export interface FetchedPage {
  bytes: Uint8Array;
  contentType: string;
  status: number;
  finalUrl: string;
}

export async function fetchWithChecks(
  urlStr: string,
  signal: AbortSignal | undefined,
): Promise<FetchedPage> {
  let current = urlStr;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicHttpUrl(current);
    const timeout = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(url, {
      redirect: "manual",
      signal: combined,
      headers: { "User-Agent": USER_AGENT, Accept: FETCH_ACCEPT },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return finish(response, current);
      current = new URL(location, current).toString();
      continue;
    }
    return finish(response, current);
  }
  throw new Error(`Too many redirects (>${MAX_REDIRECTS})`);

  async function finish(response: Response, finalUrl: string): Promise<FetchedPage> {
    return {
      bytes: await readCapped(response),
      contentType: (response.headers.get("content-type") ?? "application/octet-stream")
        .split(";")[0]
        .trim(),
      status: response.status,
      finalUrl,
    };
  }
}

/** Sleep that aborts with the signal instead of running out the clock. */
export function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
