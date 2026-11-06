/**
 * Try each endpoint in order until one succeeds. If every endpoint fails the
 * caller gets an `AllEndpointsFailedError` and must mark the check `error`
 * (never `ok`).
 */
export class AllEndpointsFailedError extends Error {
  constructor(public readonly failures: { endpoint: string; error: string }[]) {
    super(
      failures.length
        ? `All ${failures.length} endpoint(s) failed: ` + failures.map((f) => `${f.endpoint} → ${f.error}`).join("; ")
        : "No endpoints configured",
    );
    this.name = "AllEndpointsFailedError";
  }
}

export async function withFailover<T>(
  endpoints: readonly string[],
  fn: (endpoint: string) => Promise<T>,
): Promise<{ value: T; endpoint: string }> {
  const failures: { endpoint: string; error: string }[] = [];
  for (const endpoint of endpoints) {
    try {
      return { value: await fn(endpoint), endpoint };
    } catch (err) {
      failures.push({ endpoint: redactUrl(endpoint), error: errMsg(err) });
    }
  }
  throw new AllEndpointsFailedError(failures);
}

/**
 * Endpoint URLs often embed API keys (".../v2/<key>", "?apikey=..."). Anything
 * we expose publicly goes through this: credentials, query strings and
 * long/opaque path segments are masked.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    const looksSecret = (s: string) => s.length >= 16 || (s.length >= 8 && /\d/.test(s) && /[a-z]/i.test(s));
    const segments = u.pathname.split("/").map((s) => (looksSecret(s) ? "***" : s));
    return `${u.protocol}//${u.host}${segments.join("/").replace(/\/+$/, "")}`;
  } catch {
    return "<invalid url>";
  }
}

export function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.name;
  return String(err);
}
