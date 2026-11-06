import { describe, expect, it } from "vitest";
import { aggregateRoute, PAUSE_CHECKS } from "../src/aggregate";
import type { CheckId, CheckResult, Direction } from "../src/types";
import { healthyChecks, NOW } from "./helpers";

function route(dir: Direction, checks: CheckResult[], extra: Partial<Parameters<typeof aggregateRoute>[2]> = {}) {
  const m = new Map<CheckId, CheckResult>(checks.map((c) => [c.id, c]));
  return aggregateRoute(dir, m, { now: NOW, staleAfterMs: 90_000, ...extra });
}

describe("route status aggregation", () => {
  it("OPEN when everything is ok and fresh, with derived values", () => {
    const r = route("noble-eth", healthyChecks());
    expect(r.state).toBe("OPEN");
    expect(r.reasons).toEqual([]);
    expect(r.max_per_tx_usdc).toBe("500000");
    expect(r.destination_cap_usdc).toBe("75000000");
    const b = route("eth-noble", healthyChecks());
    expect(b.state).toBe("OPEN");
    expect(b.max_per_tx_raw).toBe("500000000000");
    expect(b.destination_cap_usdc).toBe("88388165.260063");
  });

  it("acceptance 3: any pause flag => PAUSED", () => {
    for (const id of PAUSE_CHECKS) {
      const checks = healthyChecks({ [id]: { status: "blocked", raw: "true", detail: "paused" } });
      const usedByNobleEth = route("noble-eth", checks);
      expect(usedByNobleEth.state, id).toBe("PAUSED");
      expect(route("eth-noble", checks).state, id).toBe("PAUSED");
    }
  });

  it("PAUSED wins over errors and other blocks", () => {
    const checks = healthyChecks({
      A2: { status: "blocked", raw: "true" },
      A5: { status: "blocked", raw: "0" },
      A7: { status: "error", raw: null },
    });
    const r = route("noble-eth", checks);
    expect(r.state).toBe("PAUSED");
    expect(r.reasons.length).toBe(2);
  });

  it("BLOCKED on zero limit / zero allowance / not minter", () => {
    expect(route("noble-eth", healthyChecks({ A1: { status: "blocked", raw: "0" } })).state).toBe("BLOCKED");
    expect(route("noble-eth", healthyChecks({ A5: { status: "blocked", raw: "0" } })).state).toBe("BLOCKED");
    expect(route("noble-eth", healthyChecks({ A6: { status: "blocked", raw: "false" } })).state).toBe("BLOCKED");
    expect(route("eth-noble", healthyChecks({ B2: { status: "blocked", raw: "0" } })).state).toBe("BLOCKED");
  });

  it("checks only affect the routes they belong to", () => {
    const checks = healthyChecks({ A1: { status: "blocked", raw: "0" }, A5: { status: "blocked", raw: "0" } });
    expect(route("noble-eth", checks).state).toBe("BLOCKED");
    expect(route("eth-noble", checks).state).toBe("OPEN");
    const checks2 = healthyChecks({ B1: { status: "blocked", raw: "0" } });
    expect(route("noble-eth", checks2).state).toBe("OPEN");
    expect(route("eth-noble", checks2).state).toBe("BLOCKED");
  });

  it("never OPEN when any check errored", () => {
    const r = route("noble-eth", healthyChecks({ A9: { status: "error", raw: null, detail: "All 2 endpoint(s) failed" } }));
    expect(r.state).toBe("UNKNOWN");
    expect(r.reasons[0]).toMatch(/read failed/);
  });

  it("never OPEN when a check is missing", () => {
    const r = route("noble-eth", healthyChecks().filter((c) => c.id !== "A3"));
    expect(r.state).toBe("UNKNOWN");
  });

  it("never OPEN when data is older than 2x the poll interval", () => {
    const old = new Date(NOW.getTime() - 91_000).toISOString();
    const r = route("noble-eth", healthyChecks({ A7: { fetched_at: old } }));
    expect(r.state).toBe("UNKNOWN");
    expect(r.reasons[0]).toMatch(/stale/);
    const fresh = new Date(NOW.getTime() - 89_000).toISOString();
    expect(route("noble-eth", healthyChecks({ A7: { fetched_at: fresh } })).state).toBe("OPEN");
  });

  it("DEGRADED when allowance is below the warning threshold", () => {
    const r = route("noble-eth", healthyChecks({ A5: { status: "warn", raw: "1000000", detail: "below threshold" } }));
    expect(r.state).toBe("DEGRADED");
  });

  it("DEGRADED when the per-message limit is trending down", () => {
    const r = route("noble-eth", healthyChecks(), { trend: { maxRaw: 1000000000000n, windowHours: 24 } });
    expect(r.state).toBe("DEGRADED");
    expect(r.reasons[0]).toMatch(/fell from 1,000,000 to 500,000/);
    expect(route("noble-eth", healthyChecks(), { trend: { maxRaw: 500000000000n, windowHours: 24 } }).state).toBe("OPEN");
  });

  it("UNKNOWN wins over DEGRADED", () => {
    const r = route("noble-eth", healthyChecks({ A5: { status: "warn" }, A3: { status: "error", raw: null } }));
    expect(r.state).toBe("UNKNOWN");
  });
});
