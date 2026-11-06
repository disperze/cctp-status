import { beforeEach, describe, expect, it } from "vitest";
import {
  _clearModuleAddressCache,
  checkBurnLimit,
  checkNobleMinterAllowance,
  checkRemoteEthOnNoble,
  fetchNobleChecks,
  parseDepositForBurnTxs,
} from "../src/noble";
import { withFailover, AllEndpointsFailedError, redactUrl } from "../src/failover";
import { jsonResponse, lcdHandler, mockFetch, MODULE_ADDR } from "./helpers";

const URLS = ["https://lcd-a.test", "https://lcd-b.test"];
const deps = (fetch: typeof globalThis.fetch) => ({ fetch, timeoutMs: 1000, allowanceWarnRaw: 5_000_000_000_000n });

beforeEach(() => _clearModuleAddressCache());

describe("Noble checks", () => {
  it("acceptance 1: sample burn limit response => 500,000 USDC", async () => {
    const f = mockFetch({
      "https://lcd-a.test": () => jsonResponse({ burn_limits: [{ amount: "500000000000", denom: "uusdc" }], pagination: {} }),
    });
    const r = await checkBurnLimit(URLS, deps(f));
    expect(r).toMatchObject({ id: "A1", raw: "500000000000", value_usdc: "500000", status: "ok", endpoint: "https://lcd-a.test" });
    expect(r.source_url).toBe("https://lcd-a.test/circle/cctp/v1/per_message_burn_limits?pagination.limit=1000");
    expect(Date.parse(r.fetched_at)).not.toBeNaN();
  });

  it("burn limit 0 or missing => blocked", async () => {
    let r = await checkBurnLimit(URLS, deps(mockFetch({ "https://lcd-a.test": lcdHandler({ burnLimit: "0" }) })));
    expect(r.status).toBe("blocked");
    r = await checkBurnLimit(URLS, deps(mockFetch({ "https://lcd-a.test": lcdHandler({ burnLimit: null }) })));
    expect(r.status).toBe("blocked");
    expect(r.raw).toBeNull();
  });

  it("all checks healthy", async () => {
    const results = await fetchNobleChecks(URLS, deps(mockFetch({ "https://lcd-a.test": lcdHandler() })));
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["A1", "ok"],
      ["A2", "ok"],
      ["A3", "ok"],
      ["A4", "ok"],
      ["A11", "ok"],
      ["B2", "ok"],
    ]);
    expect(results.find((r) => r.id === "B2")!.value_usdc).toBe("88388165.260063");
  });

  it("pause flags true => blocked", async () => {
    const f = mockFetch({ "https://lcd-a.test": lcdHandler({ burningPaused: true, sendingPaused: true, fiatPaused: true }) });
    const results = await fetchNobleChecks(URLS, deps(f));
    for (const id of ["A2", "A3", "A4"]) expect(results.find((r) => r.id === id)!.status).toBe("blocked");
  });

  it("treats an omitted proto3 false bool as not paused", async () => {
    const f = mockFetch({ "https://lcd-a.test": (p) => (p.includes("paused") ? jsonResponse({ paused: {} }) : lcdHandler()(p)) });
    const results = await fetchNobleChecks(URLS, deps(f));
    expect(results.find((r) => r.id === "A2")!.status).toBe("ok");
  });

  it("B2 discovers the module account and treats NotFound as 'not a minter'", async () => {
    const f = mockFetch({ "https://lcd-a.test": lcdHandler({ allowance: null }) });
    const r = await checkNobleMinterAllowance(URLS, deps(f));
    expect(r.status).toBe("blocked");
    expect(r.raw).toBe("0");
    expect(f.calls.some((u) => u.endsWith("/cosmos/auth/v1beta1/module_accounts/cctp"))).toBe(true);
    expect(f.calls.some((u) => u.endsWith(`/noble/fiattokenfactory/minters/${MODULE_ADDR}`))).toBe(true);
    // NotFound is an answer, not a failure: the second endpoint is not tried
    expect(f.calls.some((u) => u.startsWith("https://lcd-b.test"))).toBe(false);
  });

  it("B2 warns below threshold and blocks at 0", async () => {
    let r = await checkNobleMinterAllowance(URLS, deps(mockFetch({ "https://lcd-a.test": lcdHandler({ allowance: "1000000" }) })));
    expect(r.status).toBe("warn");
    _clearModuleAddressCache();
    r = await checkNobleMinterAllowance(URLS, deps(mockFetch({ "https://lcd-a.test": lcdHandler({ allowance: "0" }) })));
    expect(r.status).toBe("blocked");
  });

  it("A11 matches Ethereum TokenMessenger; mismatch warns; missing blocks", async () => {
    let r = await checkRemoteEthOnNoble(URLS, deps(mockFetch({ "https://lcd-a.test": lcdHandler() })));
    expect(r.status).toBe("ok");
    expect(r.raw).toBe("0x000000000000000000000000bd3fa81b58ba92a82136038b25adec7066af3155");
    const other = Buffer.alloc(32, 7).toString("base64");
    r = await checkRemoteEthOnNoble(URLS, deps(mockFetch({ "https://lcd-a.test": lcdHandler({ remoteEth: other }) })));
    expect(r.status).toBe("warn");
    r = await checkRemoteEthOnNoble(URLS, deps(mockFetch({ "https://lcd-a.test": lcdHandler({ remoteEth: null }) })));
    expect(r.status).toBe("blocked");
  });
});

describe("LCD failover", () => {
  it("falls over from a down endpoint to the next one", async () => {
    const f = mockFetch({ "https://lcd-a.test": "down", "https://lcd-b.test": lcdHandler() });
    const r = await checkBurnLimit(URLS, deps(f));
    expect(r.status).toBe("ok");
    expect(r.endpoint).toBe("https://lcd-b.test");
  });

  it("falls over on HTTP 500 and on non-JSON garbage", async () => {
    for (const bad of ["500", "garbage"] as const) {
      const f = mockFetch({ "https://lcd-a.test": bad, "https://lcd-b.test": lcdHandler() });
      const r = await checkBurnLimit(URLS, deps(f));
      expect(r.status, bad).toBe("ok");
      expect(r.endpoint).toBe("https://lcd-b.test");
    }
  });

  it("falls over on an unexpected response shape", async () => {
    const f = mockFetch({ "https://lcd-a.test": () => jsonResponse({ hello: "world" }), "https://lcd-b.test": lcdHandler() });
    const r = await checkBurnLimit(URLS, deps(f));
    expect(r.status).toBe("ok");
    expect(r.endpoint).toBe("https://lcd-b.test");
  });

  it("a malformed body on every endpoint is error, not ok", async () => {
    const bad = () => jsonResponse({ hello: "world" });
    const r = await checkBurnLimit(URLS, deps(mockFetch({ "https://lcd-a.test": bad, "https://lcd-b.test": bad })));
    expect(r.status).toBe("error");
    expect(r.detail).toMatch(/missing burn_limits/);
  });

  it("marks the check error (never ok) when every endpoint fails", async () => {
    const f = mockFetch({ "https://lcd-a.test": "down", "https://lcd-b.test": "500" });
    const results = await fetchNobleChecks(URLS, deps(f));
    for (const r of results) {
      expect(r.status, r.id).toBe("error");
      expect(r.raw).toBeNull();
      expect(r.endpoint).toBeNull();
    }
    expect(results[0]!.detail).toMatch(/All 2 endpoint\(s\) failed/);
  });

  it("times out a hanging endpoint and moves on", async () => {
    const hang = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://lcd-b.test")) return lcdHandler()(url.slice("https://lcd-b.test".length));
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }) as typeof fetch;
    const r = await checkBurnLimit(URLS, { fetch: hang, timeoutMs: 50, allowanceWarnRaw: 0n });
    expect(r.status).toBe("ok");
    expect(r.endpoint).toBe("https://lcd-b.test");
  });
});

describe("withFailover / redactUrl", () => {
  it("returns the first success and reports which endpoint answered", async () => {
    const seen: string[] = [];
    const r = await withFailover(["a", "b", "c"], async (e) => {
      seen.push(e);
      if (e !== "b") throw new Error("nope");
      return 42;
    });
    expect(r).toEqual({ value: 42, endpoint: "b" });
    expect(seen).toEqual(["a", "b"]);
  });

  it("throws AllEndpointsFailedError with every failure", async () => {
    await expect(withFailover(["x", "y"], async () => Promise.reject(new Error("boom")))).rejects.toBeInstanceOf(AllEndpointsFailedError);
    await expect(withFailover([], async () => 1)).rejects.toThrow(/No endpoints/);
  });

  it("masks API keys in endpoint URLs", () => {
    expect(redactUrl("https://eth-mainnet.g.alchemy.com/v2/abcDEF1234567890xyzKEY")).toBe("https://eth-mainnet.g.alchemy.com/v2/***");
    expect(redactUrl("https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef")).toBe("https://mainnet.infura.io/v3/***");
    expect(redactUrl("https://rpc.example.com/?apikey=secret")).toBe("https://rpc.example.com");
    expect(redactUrl("https://user:pass@rpc.example.com")).toBe("https://rpc.example.com");
    expect(redactUrl("https://rest.cosmos.directory/noble")).toBe("https://rest.cosmos.directory/noble");
  });
});

describe("recent DepositForBurn parsing", () => {
  it("parses typed event attributes (JSON-encoded values)", () => {
    const body = {
      tx_responses: [
        {
          txhash: "CEDB",
          height: "63347163",
          timestamp: "2026-11-06T20:07:30Z",
          events: [
            { type: "transfer", attributes: [] },
            {
              type: "circle.cctp.v1.DepositForBurn",
              attributes: [
                { key: "amount", value: '"779122106"' },
                { key: "depositor", value: '"noble15xt7kx5mles58vkkfxvf0lq78sw04jajvfgd4d"' },
                { key: "destination_domain", value: "0" },
                { key: "mint_recipient", value: '"AAAAAAAAAAAAAAAAbtI6GIpRqAG2CEY+NZhv3CgvKnk="' },
                { key: "nonce", value: '"380455"' },
              ],
            },
            {
              type: "circle.cctp.v1.DepositForBurn",
              attributes: [
                { key: "amount", value: '"5"' },
                { key: "destination_domain", value: "6" },
              ],
            },
          ],
        },
      ],
    };
    const items = parseDepositForBurnTxs(body, 0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      txhash: "CEDB",
      amount_raw: "779122106",
      amount_usdc: "779.122106",
      nonce: "380455",
      mint_recipient: "0x6ed23a188a51a801b608463e35986fdc282f2a79",
      explorer_url: "https://www.mintscan.io/noble/tx/CEDB",
    });
  });
});
