/**
 * Credential resolution for xAI calls, with a circuit breaker.
 *
 * Auth order: pi's OAuth subscription login first, then XAI_API_KEY credits.
 * A credential that returns 401/403 trips its breaker for 10 minutes and is
 * skipped until then, so a dead login does not fail every call twice.
 */

export interface Credential {
  key: string;
  label: string;
}

const BREAKER_MS = 10 * 60_000;
const breakerUntil = new Map<string, number>();

export function breakerOpen(label: string): boolean {
  const until = breakerUntil.get(label);
  if (until === undefined) return false;
  if (Date.now() >= until) {
    breakerUntil.delete(label);
    return false;
  }
  return true;
}

export function tripBreaker(label: string): void {
  breakerUntil.set(label, Date.now() + BREAKER_MS);
}

export function resetBreaker(label: string): void {
  breakerUntil.delete(label);
}

/** OAuth first, env key second; breaker-open credentials are skipped. */
export async function resolveCredentials(ctx: any): Promise<Credential[]> {
  const attempts: Credential[] = [];

  const oauthKey = ctx
    ? await ctx.modelRegistry.getApiKeyForProvider("xai").catch(() => undefined)
    : undefined;
  if (oauthKey) attempts.push({ key: oauthKey, label: "oauth (subscription login)" });

  const envKey = process.env.XAI_API_KEY;
  if (envKey && envKey !== oauthKey) attempts.push({ key: envKey, label: "api key (paid credits)" });

  return attempts.filter((c) => !breakerOpen(c.label));
}

/** True when credentials exist but all breakers are open. */
export function allBreakersOpen(ctx: any): Promise<boolean> {
  return resolveCredentials(ctx).then((creds) => {
    if (creds.length > 0) return false;
    const oauth = ctx ? true : false;
    const hasEnv = Boolean(process.env.XAI_API_KEY);
    return oauth || hasEnv;
  });
}
