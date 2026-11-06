import { describe, expect, it } from "vitest";
import { aggregateRoute } from "../src/aggregate";
import { OSMOSIS } from "../src/config";
import { AllEndpointsFailedError } from "../src/failover";
import { fetchAlloyedPool, smartQueryPath, type AlloyedPoolState } from "../src/osmosis";
import { planRoutes, skipGoUrl } from "../src/routes";
import type { CheckId, CheckResult, StatusSnapshot } from "../src/types";
import { parseUsdc } from "../src/units";
import { healthyChecks, jsonResponse, mockFetch, NOW } from "./helpers";

const M998 = { num: 998n, den: 1000n, text: "0.998" };
const URLS = ["https://osmo-a.test", "https://osmo-b.test"];
const AXL = "ibc/D189335C6E4A68B513C10AB227BF1C1D38C746766278BA3EEB4FB14124F1D858";

interface PoolMock {
  noble?: string;
  inj?: string;
  active?: boolean;
  corrupted?: string[];
}

function osmoHandler(m: PoolMock = {}) {
  const st = { noble: "375132180660", inj: "2107608104020", active: true, corrupted: [] as string[], ...m };
  return (path: string): Response => {
    switch (path) {
      case smartQueryPath({ get_total_pool_liquidity: {} }):
        return jsonResponse(
          { data: { total_pool_liquidity: [{ denom: OSMOSIS.usdcNoble, amount: st.noble }, { denom: AXL, amount: "24157" }, { denom: OSMOSIS.usdcInjective, amount: st.inj }] } },
          200,
          { "grpc-metadata-x-cosmos-block-height": "74335041" },
        );
      case smartQueryPath({ is_active: {} }):
        return jsonResponse({ data: { is_active: st.active } });
      case smartQueryPath({ get_corrupted_denoms: {} }):
        return jsonResponse({ data: { corrupted_denoms: st.corrupted } });
      default:
        return jsonResponse({ code: 12, message: "Not Implemented" }, 501);
    }
  };
}

function pool(over: Partial<AlloyedPoolState> = {}, liq: { noble?: string; inj?: string } = {}): AlloyedPoolState {
  return {
    pool_id: 3497,
    contract: OSMOSIS.contract,
    active: true,
    corrupted_denoms: [],
    liquidity_raw: { [OSMOSIS.usdcNoble]: liq.noble ?? "375132180660", [OSMOSIS.usdcInjective]: liq.inj ?? "2107608104020" },
    endpoint: "https://osmo-a.test",
    fetched_at: NOW.toISOString(),
    source_url: "https://osmo-a.test/x",
    ...over,
  };
}

function snapshot(checks: CheckResult[] = healthyChecks()): StatusSnapshot {
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

const opts = { now: NOW, staleAfterMs: 120_000 };

describe("fetchAlloyedPool", () => {
  it("reads balances, is_active and corrupted denoms from one endpoint", async () => {
    const f = mockFetch({ "https://osmo-a.test": osmoHandler() });
    const p = await fetchAlloyedPool(URLS, { fetch: f, timeoutMs: 1000, now: () => NOW });
    expect(p.active).toBe(true);
    expect(p.liquidity_raw[OSMOSIS.usdcInjective]).toBe("2107608104020");
    expect(p.liquidity_raw[OSMOSIS.usdcNoble]).toBe("375132180660");
    expect(p.block).toBe("74335041");
    expect(p.endpoint).toBe("https://osmo-a.test");
    expect(p.source_url).toBe("https://osmo-a.test" + smartQueryPath({ get_total_pool_liquidity: {} }));
    expect(f.calls.every((u) => u.startsWith("https://osmo-a.test/cosmwasm/wasm/v1/contract/" + OSMOSIS.contract + "/smart/"))).toBe(true);
  });

  it("smart query paths are base64 JSON", () => {
    expect(smartQueryPath({ is_active: {} })).toBe(`/cosmwasm/wasm/v1/contract/${OSMOSIS.contract}/smart/eyJpc19hY3RpdmUiOnt9fQ==`);
  });

  it("fails over on a 403 or malformed body, and throws when every endpoint fails", async () => {
    const forbidden = () => jsonResponse({ code: 7, message: "forbidden" }, 403);
    let p = await fetchAlloyedPool(URLS, { fetch: mockFetch({ "https://osmo-a.test": forbidden, "https://osmo-b.test": osmoHandler() }), timeoutMs: 1000 });
    expect(p.endpoint).toBe("https://osmo-b.test");
    p = await fetchAlloyedPool(URLS, { fetch: mockFetch({ "https://osmo-a.test": () => jsonResponse({ data: {} }), "https://osmo-b.test": osmoHandler() }), timeoutMs: 1000 });
    expect(p.endpoint).toBe("https://osmo-b.test");
    await expect(fetchAlloyedPool(URLS, { fetch: mockFetch({ "https://osmo-a.test": "down", "https://osmo-b.test": "500" }), timeoutMs: 1000 })).rejects.toBeInstanceOf(
      AllEndpointsFailedError,
    );
  });
});

/** Noble exit plan; asserts the Osmosis option is present. */
function exitPlan(amount: string, p: AlloyedPoolState | null = pool(), o: { now: Date; staleAfterMs: number; poolError?: string } = opts) {
  const r = planRoutes(snapshot(), "noble-eth", parseUsdc(amount), M998, p, o);
  expect(r.osmosis).not.toBeNull();
  return { ...r, osmosis: r.osmosis! };
}

describe("planRoutes", () => {
  it("prefers exiting to USDC.inj via Osmosis when the pool has enough USDC.inj", () => {
    const r = exitPlan("2,000,000");
    expect(r.recommended).toBe("osmosis");
    expect(r.osmosis.status).toBe("ok");
    expect(r.osmosis.asset_in.symbol).toBe("USDC.n");
    expect(r.osmosis.asset_out.symbol).toBe("USDC.inj");
    expect(r.osmosis.available_usdc).toBe("2107608.10402");
    expect(r.osmosis.usable_raw).toBe(((2107608104020n * 998n) / 1000n).toString());
    // CCTP V1 to Ethereum is still computed and shown as the alternative
    expect(r.cctp.messages).toBe("5");
  });

  it("falls back to CCTP V1 when the pool can't take the whole amount, and suggests a split", () => {
    const r = exitPlan("3,000,000");
    expect(r.recommended).toBe("cctp");
    expect(r.osmosis.status).toBe("insufficient");
    expect(r.osmosis.fits).toBe(false);
    expect(r.osmosis.notes[0]).toMatch(/Up to 2,103,392\.887811 USDC could still exit through the pool, and the rest through CCTP V1/);
    expect(r.recommended_reason).toMatch(/doesn't have enough USDC\.inj/);
  });

  it("applies the safety margin to the pool balance", () => {
    // 1,000 USDC.inj in the pool: usable 998
    const p = pool({}, { inj: "1000000000" });
    expect(exitPlan("998", p).recommended).toBe("osmosis");
    expect(exitPlan("998.000001", p).recommended).toBe("cctp");
  });

  it("only USDC.inj liquidity matters: the USDC.n balance is ignored", () => {
    expect(exitPlan("1,000,000", pool({}, { noble: "0" })).recommended).toBe("osmosis");
  });

  it("Ethereum → Noble moves funds into Noble USDC, so there is no Osmosis option", () => {
    const r = planRoutes(snapshot(), "eth-noble", parseUsdc("100"), M998, pool(), opts);
    expect(r.osmosis).toBeNull();
    expect(r.recommended).toBe("cctp");
    expect(r.cctp.per_tx_limit_raw).toBe("500000000000");
  });

  it("an inactive pool or a corrupted input denom is unavailable", () => {
    let r = exitPlan("100", pool({ active: false }));
    expect([r.recommended, r.osmosis.status]).toEqual(["cctp", "unavailable"]);
    r = exitPlan("100", pool({ corrupted_denoms: [OSMOSIS.usdcNoble] }));
    expect([r.recommended, r.osmosis.status]).toEqual(["cctp", "unavailable"]);
    // a corrupted *output* denom can still be swapped out
    r = exitPlan("100", pool({ corrupted_denoms: [OSMOSIS.usdcInjective] }));
    expect(r.recommended).toBe("osmosis");
  });

  it("an unreadable or stale pool is unknown, never preferred", () => {
    let r = exitPlan("100", null, { ...opts, poolError: "All 3 endpoint(s) failed" });
    expect([r.recommended, r.osmosis.status, r.osmosis.fits]).toEqual(["cctp", "unknown", null]);
    expect(r.osmosis.status_detail).toMatch(/All 3 endpoint/);
    r = exitPlan("100", pool({ fetched_at: new Date(NOW.getTime() - 5 * 60_000).toISOString() }));
    expect([r.recommended, r.osmosis.status, r.osmosis.stale, r.osmosis.fits]).toEqual(["cctp", "unknown", true, null]);
  });

  it("a missing USDC.inj member counts as zero liquidity", () => {
    const p = pool();
    delete p.liquidity_raw[OSMOSIS.usdcInjective];
    const r = exitPlan("1", p);
    expect([r.recommended, r.osmosis.status, r.osmosis.available_raw]).toEqual(["cctp", "insufficient", "0"]);
  });
});

describe("skipGoUrl", () => {
  it("prefills the exit: Noble USDC to Injective USDC", () => {
    const a = new URL(skipGoUrl(parseUsdc("1500.5")));
    expect(a.origin).toBe("https://go.skip.build");
    expect(Object.fromEntries(a.searchParams)).toEqual({
      src_chain: "noble-1", src_asset: "uusdc", dest_chain: "injective-1", dest_asset: OSMOSIS.injectiveUsdc, amount_in: "1500.5",
    });
    expect(new URL(skipGoUrl(1n)).searchParams.get("amount_in")).toBe("0.000001");
  });
});
