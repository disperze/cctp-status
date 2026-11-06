/**
 * Pure status composition, shared by the GitHub Action (Node) and the browser.
 * No I/O here.
 */
import { aggregateRoute, isStale, ROUTES, type TrendBaseline } from "./aggregate";
import { RETIREMENT_DATES, type AppConfig } from "./config";
import { maxValue } from "./history";
import type { SnapshotRecord } from "./storage";
import type { CheckId, CheckResult, Direction, StatusSnapshot } from "./types";
import { formatUsdc } from "./units";

export const CHECK_ORDER: CheckId[] = ["A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8", "A9", "A10", "A11", "B1", "B2"];

export function sortChecks(checks: CheckResult[]): CheckResult[] {
  return [...checks].sort((a, b) => CHECK_ORDER.indexOf(a.id) - CHECK_ORDER.indexOf(b.id));
}

export const staleAfterMs = (cfg: Pick<AppConfig, "statusCacheSec">) => 2 * cfg.statusCacheSec * 1000;

/** Highest per-message limit per route within the trend window, from stored snapshots. */
export function trendFromRecords(
  records: readonly SnapshotRecord[],
  cfg: Pick<AppConfig, "trendWindowHours">,
  now: Date,
): Record<Direction, TrendBaseline | null> {
  const since = now.getTime() - cfg.trendWindowHours * 3600_000;
  const recent = records.filter((r) => Date.parse(r.ts) >= since);
  const out = {} as Record<Direction, TrendBaseline | null>;
  for (const dir of Object.keys(ROUTES) as Direction[]) {
    const max = maxValue(recent, ROUTES[dir].limit);
    out[dir] = max === null ? null : { maxRaw: max, windowHours: cfg.trendWindowHours };
  }
  return out;
}

/** Build the public snapshot. Staleness is evaluated against `now`. */
export function composeStatus(
  checks: CheckResult[],
  trend: Record<Direction, TrendBaseline | null>,
  cfg: AppConfig,
  generatedAt: Date,
  now: Date,
): StatusSnapshot {
  const stale = staleAfterMs(cfg);
  const annotated = sortChecks(checks).map((c) => ({ ...c, stale: isStale(c, now, stale) }));
  const byId = new Map(annotated.map((c) => [c.id, c] as const));
  const opts = { now, staleAfterMs: stale };
  return {
    generated_at: generatedAt.toISOString(),
    checks: annotated,
    routes: {
      "noble-eth": aggregateRoute("noble-eth", byId, { ...opts, trend: trend["noble-eth"] }),
      "eth-noble": aggregateRoute("eth-noble", byId, { ...opts, trend: trend["eth-noble"] }),
    },
    config: {
      safety_margin: cfg.safetyMargin.text,
      status_cache_sec: cfg.statusCacheSec,
      stale_after_sec: stale / 1000,
      snapshot_interval_min: cfg.snapshotIntervalMin,
      allowance_warn_usdc: formatUsdc(cfg.allowanceWarnRaw, { grouping: false }),
      trend_window_hours: cfg.trendWindowHours,
    },
    dates: RETIREMENT_DATES,
  };
}
