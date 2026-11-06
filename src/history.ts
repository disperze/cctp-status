/**
 * History helpers: chart series, "last changed at" + delta, trend baselines,
 * and change detection for alerts.
 */
import type { SnapshotRecord } from "./storage";
import type { CheckId, CheckResult, Direction, StatusSnapshot } from "./types";
import { toUsdcString } from "./units";

/** Amount checks that get a history line and change tracking. */
export const TRACKED_LIMITS: CheckId[] = ["A1", "A5", "B1", "B2"];

export function toRecord(status: StatusSnapshot): SnapshotRecord {
  const checks: SnapshotRecord["checks"] = {};
  for (const c of status.checks) checks[c.id] = { s: c.status, r: c.raw };
  return {
    ts: status.generated_at,
    checks,
    routes: { "noble-eth": status.routes["noble-eth"].state, "eth-noble": status.routes["eth-noble"].state },
  };
}

function rawOf(rec: SnapshotRecord, id: CheckId): bigint | null {
  const c = rec.checks[id];
  if (!c || c.s === "error" || c.r === null || !/^\d+$/.test(c.r)) return null;
  return BigInt(c.r);
}

export interface ChangeInfo {
  id: CheckId;
  current_raw: string | null;
  current_usdc: string | null;
  /** Timestamp of the first snapshot that showed the current value. */
  last_changed_at: string | null;
  previous_raw: string | null;
  previous_usdc: string | null;
  delta_raw: string | null;
  delta_usdc: string | null;
  /** Earliest snapshot considered: if last_changed_at is null the value has not changed since then. */
  observed_since: string | null;
}

/** Walk back from the newest reading to find when the value last changed. */
export function changeInfo(records: readonly SnapshotRecord[], id: CheckId): ChangeInfo {
  const points = records.flatMap((r) => {
    const v = rawOf(r, id);
    return v === null ? [] : [{ ts: r.ts, v }];
  });
  const empty: ChangeInfo = {
    id,
    current_raw: null,
    current_usdc: null,
    last_changed_at: null,
    previous_raw: null,
    previous_usdc: null,
    delta_raw: null,
    delta_usdc: null,
    observed_since: points[0]?.ts ?? null,
  };
  const last = points.at(-1);
  if (!last) return empty;
  let i = points.length - 1;
  while (i > 0 && points[i - 1]!.v === last.v) i--;
  const prev = i > 0 ? points[i - 1]! : null;
  const delta = prev ? last.v - prev.v : null;
  return {
    ...empty,
    current_raw: last.v.toString(),
    current_usdc: toUsdcString(last.v),
    last_changed_at: prev ? points[i]!.ts : null,
    previous_raw: prev?.v.toString() ?? null,
    previous_usdc: prev ? toUsdcString(prev.v) : null,
    delta_raw: delta?.toString() ?? null,
    delta_usdc: delta !== null ? toUsdcString(delta) : null,
  };
}

/** Highest value of a check in the given records (used as the trend baseline). */
export function maxValue(records: readonly SnapshotRecord[], id: CheckId): bigint | null {
  let max: bigint | null = null;
  for (const r of records) {
    const v = rawOf(r, id);
    if (v !== null && (max === null || v > max)) max = v;
  }
  return max;
}

export type SeriesPoint = { ts: string; routes: SnapshotRecord["routes"] } & Partial<Record<CheckId, string | null>>;

export function chartSeries(records: readonly SnapshotRecord[]): SeriesPoint[] {
  return records.map((r) => {
    const point: SeriesPoint = { ts: r.ts, routes: r.routes };
    for (const id of TRACKED_LIMITS) point[id] = rawOf(r, id)?.toString() ?? null;
    return point;
  });
}

export interface ChangeEvent {
  kind: "route" | "limit" | "check";
  message: string;
}

/**
 * Differences worth alerting on between two snapshots. Minter allowances move
 * with every transfer, so they only alert when their status changes (e.g.
 * crossing the warning threshold), not on every value change.
 */
export function detectChanges(prev: SnapshotRecord | null, next: StatusSnapshot): ChangeEvent[] {
  if (!prev) return [];
  const events: ChangeEvent[] = [];
  for (const dir of ["noble-eth", "eth-noble"] as Direction[]) {
    const before = prev.routes[dir];
    const after = next.routes[dir];
    if (before !== after.state) {
      events.push({ kind: "route", message: `${after.label}: ${before} → ${after.state}${after.reasons[0] ? ` (${after.reasons[0]})` : ""}` });
    }
  }
  const byId = new Map<CheckId, CheckResult>(next.checks.map((c) => [c.id, c]));
  for (const id of ["A1", "B1"] as CheckId[]) {
    const c = byId.get(id);
    const was = rawOf(prev, id);
    if (!c || c.status === "error" || c.raw === null || was === null) continue;
    const now = BigInt(c.raw);
    if (now !== was) {
      const d = now - was;
      events.push({
        kind: "limit",
        message: `${c.label}: ${toUsdcString(was)} → ${toUsdcString(now)} USDC (${d > 0n ? "+" : ""}${toUsdcString(d)})`,
      });
    }
  }
  for (const c of next.checks) {
    const was = prev.checks[c.id]?.s;
    // Read failures surface through the route flipping to UNKNOWN; don't alert per check.
    if (was === "error" || c.status === "error") continue;
    if (was && was !== c.status) events.push({ kind: "check", message: `${c.id} ${c.label}: ${was} → ${c.status}` });
  }
  return events;
}
