import { describe, expect, it } from "vitest";
import { fetchEthereumChecks } from "../src/ethereum";
import { formatUsdc } from "../src/units";
import { ethHandler, mockRpc } from "./helpers";

const URLS = ["https://rpc-a.test", "https://rpc-b.test"];
const deps = (fetchFn: typeof fetch) => ({ fetchFn, timeoutMs: 2000, allowanceWarnRaw: 5_000_000_000_000n });

describe("Ethereum checks (viem multicall against a mocked JSON-RPC node)", () => {
  it("acceptance 2: minter allowance 75000000000000 => 75,000,000 USDC", async () => {
    const results = await fetchEthereumChecks(URLS, deps(mockRpc({ "https://rpc-a.test": ethHandler() })));
    const a5 = results.find((r) => r.id === "A5")!;
    expect(a5).toMatchObject({ raw: "75000000000000", value_usdc: "75000000", status: "ok", endpoint: "https://rpc-a.test" });
    expect(formatUsdc(BigInt(a5.raw!))).toBe("75,000,000");
    expect(a5.block).toBe(String(0x1922f4a));
  });

  it("all checks healthy, read at one block", async () => {
    const results = await fetchEthereumChecks(URLS, deps(mockRpc({ "https://rpc-a.test": ethHandler() })));
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["A5", "ok"],
      ["A6", "ok"],
      ["A7", "ok"],
      ["A8", "ok"],
      ["A9", "ok"],
      ["A10", "ok"],
      ["B1", "ok"],
    ]);
    expect(new Set(results.map((r) => r.block)).size).toBe(1);
    expect(results.find((r) => r.id === "B1")!.value_usdc).toBe("500000");
  });

  it("paused flags, non-minter, zero remote, zero limit => blocked", async () => {
    const f = mockRpc({
      "https://rpc-a.test": ethHandler({
        mtPaused: true,
        tmPaused: true,
        usdcPaused: true,
        isMinter: false,
        remoteNoble: `0x${"0".repeat(64)}`,
        burnLimit: 0n,
        minterAllowance: 0n,
      }),
    });
    const results = await fetchEthereumChecks(URLS, deps(f));
    for (const r of results) expect(r.status, r.id).toBe("blocked");
  });

  it("allowance below threshold => warn", async () => {
    const results = await fetchEthereumChecks(URLS, deps(mockRpc({ "https://rpc-a.test": ethHandler({ minterAllowance: 1_000_000n }) })));
    expect(results.find((r) => r.id === "A5")!.status).toBe("warn");
  });

  it("a single reverting call marks only that check as error", async () => {
    const f = mockRpc({ "https://rpc-a.test": ethHandler({ revert: { burnLimitsPerMessage: true } }) });
    const results = await fetchEthereumChecks(URLS, deps(f));
    expect(results.find((r) => r.id === "B1")!.status).toBe("error");
    expect(results.filter((r) => r.status === "ok")).toHaveLength(6);
  });
});

describe("RPC failover", () => {
  it("falls over from a down RPC to the next", async () => {
    const f = mockRpc({ "https://rpc-a.test": "down", "https://rpc-b.test": ethHandler() });
    const results = await fetchEthereumChecks(URLS, deps(f));
    for (const r of results) {
      expect(r.status).toBe("ok");
      expect(r.endpoint).toBe("https://rpc-b.test");
    }
    expect(f.calls[0]).toBe("https://rpc-a.test");
  });

  it("falls over on HTTP 500", async () => {
    const f = mockRpc({ "https://rpc-a.test": "500", "https://rpc-b.test": ethHandler() });
    const results = await fetchEthereumChecks(URLS, deps(f));
    expect(results.every((r) => r.status === "ok" && r.endpoint === "https://rpc-b.test")).toBe(true);
  });

  it("marks every check error (never ok) when all RPCs fail", async () => {
    const f = mockRpc({ "https://rpc-a.test": "down", "https://rpc-b.test": "500" });
    const results = await fetchEthereumChecks(URLS, deps(f));
    expect(results).toHaveLength(7);
    for (const r of results) {
      expect(r.status).toBe("error");
      expect(r.raw).toBeNull();
    }
    expect(results[0]!.detail).toMatch(/All 2 endpoint\(s\) failed/);
  });
});
