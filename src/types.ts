export type CheckStatus = "ok" | "warn" | "blocked" | "error";

export type CheckId =
  | "A1" | "A2" | "A3" | "A4" | "A5" | "A6" | "A7" | "A8" | "A9" | "A10" | "A11"
  | "B1" | "B2";

/** Common result shape returned by every check. */
export interface CheckResult {
  id: CheckId;
  label: string;
  /** Raw on-chain value as a string (bigints serialised as decimal strings, bools as "true"/"false"). */
  raw: string | null;
  /** Machine-readable USDC decimal string, only for amount checks. */
  value_usdc?: string;
  status: CheckStatus;
  /** Human description of the exact call, e.g. "USDC.minterAllowance(TokenMinter)". */
  source: string;
  /** Link where a user can verify the value themselves. */
  source_url: string;
  /** Which RPC/LCD endpoint answered (or null on error). */
  endpoint: string | null;
  /** Block height the value was read at, when known. */
  block?: string;
  fetched_at: string;
  /** Explanation for non-ok statuses. */
  detail?: string;
  /** On error: the last successful reading, so the UI can show it as stale. */
  last_good?: { raw: string | null; value_usdc?: string; fetched_at: string };
  /** Set when served: fetched_at is older than 2x the poll interval. */
  stale?: boolean;
}

export type Direction = "noble-eth" | "eth-noble";

export type RouteState = "OPEN" | "DEGRADED" | "PAUSED" | "BLOCKED" | "UNKNOWN";

export interface RouteSummary {
  direction: Direction;
  label: string;
  state: RouteState;
  reasons: string[];
  check_ids: CheckId[];
  /** Max per transaction (A1 / B1). */
  max_per_tx_raw: string | null;
  max_per_tx_usdc: string | null;
  /** Destination minter allowance (A5 / B2): aggregate cap shared by everyone. */
  destination_cap_raw: string | null;
  destination_cap_usdc: string | null;
}

export interface StatusSnapshot {
  generated_at: string;
  checks: CheckResult[];
  routes: Record<Direction, RouteSummary>;
  config: {
    safety_margin: string;
    status_cache_sec: number;
    stale_after_sec: number;
    snapshot_interval_min: number;
    allowance_warn_usdc: string;
    trend_window_hours: number;
  };
  dates: readonly { id: string; date: string; label: string }[];
}
