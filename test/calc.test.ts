import { describe, expect, it } from "vitest";
import { aggregateRoute } from "../src/aggregate";
import { calculate, planTransfer, safeChunk } from "../src/calc";
import type { CheckId, CheckResult, StatusSnapshot } from "../src/types";
import { parseUsdc } from "../src/units";
import { healthyChecks, NOW } from "./helpers";

const M998 = { num: 998n, den: 1000n, text: "0.998" };

describe("planTransfer (chunking)", () => {
  it("acceptance 1: 2,000,000 USDC at a 500,000 limit and 0.998 margin is 5 messages", () => {
    const plan = planTransfer(parseUsdc("2,000,000"), 500000000000n, M998);
    expect(plan.safeChunk).toBe(499000000000n); // 499,000 USDC
    expect(plan.messages).toBe(5n);
    expect(plan.chunks).toEqual([
      { count: 4n, amount: 499000000000n },
      { count: 1n, amount: 4000000000n },
    ]);
    const total = plan.chunks.reduce((s, c) => s + c.count * c.amount, 0n);
    expect(total).toBe(2000000000000n);
  });

  it("an exact multiple of the safe chunk has no remainder chunk", () => {
    const plan = planTransfer(998000000000n, 500000000000n, M998);
    expect(plan.messages).toBe(2n);
    expect(plan.chunks).toEqual([{ count: 2n, amount: 499000000000n }]);
  });

  it("amounts below one chunk need a single message", () => {
    const plan = planTransfer(1n, 500000000000n, M998);
    expect(plan.messages).toBe(1n);
    expect(plan.chunks).toEqual([{ count: 1n, amount: 1n }]);
  });

  it("margin 1 uses the full limit", () => {
    const plan = planTransfer(1000000000000n, 500000000000n, { num: 1n, den: 1n });
    expect(plan.messages).toBe(2n);
  });

  it("floors the safe chunk (never rounds up past the margin)", () => {
    // 1,000,001 * 998 / 1000 = 998,000.998 -> 998,000
    expect(safeChunk(1000001n, M998)).toBe(998000n);
  });

  it("no float rounding with huge amounts", () => {
    const amount = 123456789012345678901234567n;
    const plan = planTransfer(amount, 500000000000n, M998);
    const total = plan.chunks.reduce((s, c) => s + c.count * c.amount, 0n);
    expect(total).toBe(amount);
    expect(plan.messages).toBe((amount + 499000000000n - 1n) / 499000000000n);
  });

  it("rejects zero amount and zero limit", () => {
    expect(() => planTransfer(0n, 500000000000n, M998)).toThrow();
    expect(() => planTransfer(1n, 0n, M998)).toThrow(/limit is 0/);
  });
});

function snapshotFrom(checks: CheckResult[]): StatusSnapshot {
  const m = new Map<CheckId, CheckResult>(checks.map((c) => [c.id, c]));
  const opts = { now: NOW, staleAfterMs: 90_000 };
  return {
    generated_at: NOW.toISOString(),
    checks,
    routes: { "noble-eth": aggregateRoute("noble-eth", m, opts), "eth-noble": aggregateRoute("eth-noble", m, opts) },
    config: { safety_margin: "0.998", status_cache_sec: 45, stale_after_sec: 90, snapshot_interval_min: 15, allowance_warn_usdc: "5000000", trend_window_hours: 24 },
    dates: [],
  };
}

describe("calculate (API response)", () => {
  it("reports fit against the destination allowance", () => {
    const s = snapshotFrom(healthyChecks());
    const r = calculate(s, "noble-eth", parseUsdc("2000000"), M998);
    expect(r.messages).toBe("5");
    expect(r.safe_chunk_usdc).toBe("499000");
    expect(r.per_tx_limit_usdc).toBe("500000");
    expect(r.destination_cap_usdc).toBe("75000000");
    expect(r.fits_destination_cap).toBe(true);
    expect(r.warnings.some((w) => /re-check/i.test(w))).toBe(true);
  });

  it("flags amounts above the destination allowance", () => {
    const s = snapshotFrom(healthyChecks());
    const r = calculate(s, "noble-eth", parseUsdc("80000000"), M998);
    expect(r.fits_destination_cap).toBe(false);
    expect(r.warnings[0]).toMatch(/exceeds the current destination minter allowance/);
  });

  it("uses B1/B2 for eth-noble", () => {
    const s = snapshotFrom(healthyChecks());
    const r = calculate(s, "eth-noble", parseUsdc("100"), M998);
    expect(r.per_tx_limit_raw).toBe("500000000000");
    expect(r.destination_cap_raw).toBe("88388165260063");
  });

  it("returns no plan when the limit is unreadable", () => {
    const s = snapshotFrom(healthyChecks({ A1: { status: "error", raw: null, value_usdc: undefined } }));
    const r = calculate(s, "noble-eth", parseUsdc("100"), M998);
    expect(r.messages).toBeNull();
    expect(r.route_state).toBe("UNKNOWN");
    expect(r.warnings.join(" ")).toMatch(/unavailable/);
  });
});
