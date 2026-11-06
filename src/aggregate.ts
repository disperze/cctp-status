/**
 * Route status aggregation and derived values.
 *
 * Precedence: PAUSED > BLOCKED > UNKNOWN > DEGRADED > OPEN.
 *  - PAUSED   any pause flag in the route is true
 *  - BLOCKED  any other check is blocked (limit 0, allowance 0, not a minter, remote unregistered)
 *  - UNKNOWN  any check errored or is stale. We never claim OPEN without fresh data.
 *  - DEGRADED open, but a check warns (allowance below threshold) or the
 *             per-message limit is below the highest value seen in the trend window
 *  - OPEN     every check ok and fresh
 */
import type { CheckId, CheckResult, Direction, RouteState, RouteSummary } from "./types";
import { formatUsdc, toUsdcString } from "./units";

export const ROUTES: Record<Direction, { label: string; checks: CheckId[]; limit: CheckId; cap: CheckId }> = {
  "noble-eth": {
    label: "Noble → Ethereum",
    // Burn on Noble (A1–A4, A11), mint on Ethereum (A5–A10).
    checks: ["A1", "A2", "A3", "A4", "A11", "A5", "A6", "A7", "A8", "A9", "A10"],
    limit: "A1",
    cap: "A5",
  },
  "eth-noble": {
    label: "Ethereum → Noble",
    // Burn on Ethereum (B1, A7–A10: MessageTransmitter.sendMessage and
    // TokenMinter.burn are whenNotPaused, USDC.transferFrom needs USDC unpaused),
    // mint on Noble (B2, A2–A4, A11).
    checks: ["B1", "B2", "A2", "A3", "A4", "A7", "A8", "A9", "A10", "A11"],
    limit: "B1",
    cap: "B2",
  },
};

export const PAUSE_CHECKS: ReadonlySet<CheckId> = new Set(["A2", "A3", "A4", "A7", "A8", "A10"]);

export function isStale(check: CheckResult, now: Date, staleAfterMs: number): boolean {
  return now.getTime() - Date.parse(check.fetched_at) > staleAfterMs;
}

export interface TrendBaseline {
  /** Highest per-message limit seen in the trend window. */
  maxRaw: bigint;
  windowHours: number;
}

export function aggregateRoute(
  direction: Direction,
  checks: ReadonlyMap<CheckId, CheckResult>,
  opts: { now: Date; staleAfterMs: number; trend?: TrendBaseline | null },
): RouteSummary {
  const route = ROUTES[direction];
  const paused: string[] = [];
  const blocked: string[] = [];
  const unknown: string[] = [];
  const degraded: string[] = [];

  for (const id of route.checks) {
    const c = checks.get(id);
    if (!c) {
      unknown.push(`${id}: no data`);
      continue;
    }
    const why = `${id} ${c.label}${c.detail ? `: ${c.detail}` : ""}`;
    if (c.status === "blocked") (PAUSE_CHECKS.has(id) ? paused : blocked).push(why);
    else if (c.status === "error") unknown.push(`${id} ${c.label}: read failed${c.detail ? ` (${c.detail})` : ""}`);
    else if (isStale(c, opts.now, opts.staleAfterMs)) unknown.push(`${id} ${c.label}: data is stale (fetched ${c.fetched_at})`);
    else if (c.status === "warn") degraded.push(why);
  }

  const limit = checks.get(route.limit);
  const limitRaw = limit?.raw && limit.status !== "error" ? BigInt(limit.raw) : null;
  if (limitRaw !== null && opts.trend && limitRaw < opts.trend.maxRaw) {
    degraded.push(
      `Per-message limit fell from ${formatUsdc(opts.trend.maxRaw)} to ${formatUsdc(limitRaw)} USDC in the last ${opts.trend.windowHours}h`,
    );
  }

  let state: RouteState = "OPEN";
  let reasons: string[] = [];
  if (paused.length) [state, reasons] = ["PAUSED", [...paused, ...blocked]];
  else if (blocked.length) [state, reasons] = ["BLOCKED", blocked];
  else if (unknown.length) [state, reasons] = ["UNKNOWN", unknown];
  else if (degraded.length) [state, reasons] = ["DEGRADED", degraded];

  const cap = checks.get(route.cap);
  const capRaw = cap?.raw && cap.status !== "error" ? BigInt(cap.raw) : null;
  return {
    direction,
    label: route.label,
    state,
    reasons,
    check_ids: route.checks,
    max_per_tx_raw: limitRaw?.toString() ?? null,
    max_per_tx_usdc: limitRaw !== null ? toUsdcString(limitRaw) : null,
    destination_cap_raw: capRaw?.toString() ?? null,
    destination_cap_usdc: capRaw !== null ? toUsdcString(capRaw) : null,
  };
}
