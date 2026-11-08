import { describe, expect, it } from "vitest";
import {
  ESCROW_CHAINS,
  emptyEscrow,
  escrowAddress,
  escrowChange,
  escrowPaths,
  fetchEscrow,
  fetchRegistryChannel,
  ibcFileName,
  needsDailySnapshot,
  parseRegistryChannel,
  pct,
  recordDaily,
  type EscrowDay,
  type EscrowReading,
} from "../src/escrow";
import { AllEndpointsFailedError } from "../src/failover";
import { jsonResponse, mockFetch, NOW } from "./helpers";

const REG = "https://registry.test";
const LCD = ["https://lcd-a.test", "https://lcd-b.test"];

// Read from Noble mainnet on 2026-11-07: GET /ibc/apps/transfer/v1/channels/{ch}/ports/transfer/escrow_address
const MAINNET_ESCROW: Record<string, string> = {
  "channel-1": "noble1kq2rzz6fq2q7fsu75a9g7cpzjeanmk68qxshr6",
  "channel-4": "noble17sael2kcmm8npe2pmkxj3un90xfg60vvuk39mn",
  "channel-18": "noble1gw2v3j8jxpmnq73rmu3vjz5egle5eep4xvvjtu",
  "channel-30": "noble12vssh8spx53qzg532xpj22sa7e85ts4x76e5rm",
  "channel-31": "noble1vn26uz7pxhz5aqd4s4q8kuar84ev9emhhgxuc2",
  "channel-33": "noble1ukv0qhw3zszzyjty32cck2j229ekpmr6g806yp",
};

function ibcFile(a: string, b: string, channels: unknown[]) {
  return { chain_1: { chain_name: a }, chain_2: { chain_name: b }, channels };
}
const chan = (c1: string, c2: string, tags: Record<string, unknown> = { preferred: true, status: "ACTIVE" }) => ({
  chain_1: { channel_id: c1, port_id: "transfer" },
  chain_2: { channel_id: c2, port_id: "transfer" },
  ordering: "unordered",
  version: "ics20-1",
  tags,
});

/** Registry mock that serves each chain's fixed channel, so the expected values are known. */
function registryHandler() {
  return (path: string): Response => {
    const def = ESCROW_CHAINS.find((d) => `/${ibcFileName(d.chain)}` === path);
    if (!def) return new Response("404: Not Found", { status: 404 });
    const [a, b] = [def.chain, "noble"].sort();
    const c = a === "noble" ? chan(def.noble_channel, def.counterparty_channel) : chan(def.counterparty_channel, def.noble_channel);
    return jsonResponse(ibcFile(a!, b!, [c]));
  };
}

function lcdHandler(balances: Record<string, string>, opts: { totalEscrow?: boolean } = {}) {
  return (path: string): Response => {
    for (const [addr, amount] of Object.entries(balances)) {
      if (path === escrowPaths.balance(addr)) {
        return jsonResponse({ balance: { denom: "uusdc", amount } }, 200, { "grpc-metadata-x-cosmos-block-height": "63433803" });
      }
    }
    if (path === escrowPaths.totalEscrow) {
      return opts.totalEscrow === false ? jsonResponse({ code: 12, message: "Not Implemented" }, 501) : jsonResponse({ amount: { denom: "uusdc", amount: "82283601252571" } });
    }
    if (path === escrowPaths.supply) return jsonResponse({ amount: { denom: "uusdc", amount: "86390197192504" } });
    return jsonResponse({ code: 5, message: "not found" }, 404);
  };
}

const allBalances = () => Object.fromEntries(Object.values(MAINNET_ESCROW).map((a, i) => [a, String((i + 1) * 1_000_000_000_000)]));

describe("escrowAddress", () => {
  it("matches ibc-go GetEscrowAddress on Noble mainnet", () => {
    for (const [ch, addr] of Object.entries(MAINNET_ESCROW)) expect(escrowAddress("transfer", ch)).toBe(addr);
  });
  it("every fixed escrow address is GetEscrowAddress of its channel and matches mainnet", () => {
    for (const d of ESCROW_CHAINS) {
      expect(escrowAddress("transfer", d.noble_channel)).toBe(d.escrow_address);
      expect(MAINNET_ESCROW[d.noble_channel]).toBe(d.escrow_address);
    }
  });
});

describe("chain registry", () => {
  it("names files with both chains sorted", () => {
    expect(ibcFileName("dydx")).toBe("dydx-noble.json");
    expect(ibcFileName("osmosis")).toBe("noble-osmosis.json");
    expect(ibcFileName("terra2")).toBe("noble-terra2.json");
  });

  it("reads the Noble side whichever chain is chain_1", () => {
    expect(parseRegistryChannel(ibcFile("noble", "osmosis", [chan("channel-1", "channel-750")]), "osmosis")).toEqual({
      port: "transfer",
      noble_channel: "channel-1",
      counterparty_channel: "channel-750",
    });
    expect(parseRegistryChannel(ibcFile("dydx", "noble", [chan("channel-0", "channel-33")]), "dydx").noble_channel).toBe("channel-33");
  });

  it("prefers the preferred channel and skips closed or non-transfer ones", () => {
    const file = ibcFile("noble", "osmosis", [
      chan("channel-9", "channel-90", { status: "killed", preferred: true }),
      { ...chan("channel-8", "channel-80"), chain_1: { channel_id: "channel-8", port_id: "icahost" } },
      chan("channel-7", "channel-70", { status: "ACTIVE" }),
      chan("channel-1", "channel-750", { status: "live", preferred: true }),
    ]);
    expect(parseRegistryChannel(file, "osmosis").noble_channel).toBe("channel-1");
  });

  it("rejects a file for another pair", () => {
    expect(() => parseRegistryChannel(ibcFile("noble", "osmosis", [chan("channel-1", "channel-750")]), "dydx")).toThrow(/not noble <-> dydx/);
  });

  it("fetchRegistryChannel (used by npm run verify) reads the pair file", async () => {
    const fetch = mockFetch({ [REG]: registryHandler() });
    for (const d of ESCROW_CHAINS) {
      expect(await fetchRegistryChannel(d.chain, { fetch, timeoutMs: 1000, registryUrl: REG })).toMatchObject({
        noble_channel: d.noble_channel,
        counterparty_channel: d.counterparty_channel,
      });
    }
    await expect(fetchRegistryChannel("nope", { fetch, timeoutMs: 1000, registryUrl: REG })).rejects.toThrow(/HTTP 404/);
  });
});

describe("fetchEscrow", () => {
  it("reads every escrow balance plus total escrow and supply, without touching the registry", async () => {
    const fetch = mockFetch({ [LCD[0]!]: lcdHandler(allBalances()) });
    const r = await fetchEscrow(LCD, { fetch, timeoutMs: 1000, now: () => NOW });
    expect(fetch.calls.every((u) => u.startsWith(LCD[0]!))).toBe(true);
    expect(r.chains.map((c) => c.chain)).toEqual(ESCROW_CHAINS.map((d) => d.chain));
    expect(r.chains[0]!.registry_url).toBe("https://github.com/cosmos/chain-registry/blob/master/_IBC/dydx-noble.json");
    const dydx = r.chains.find((c) => c.chain === "dydx")!;
    expect(dydx.balance_raw).toBe(allBalances()[MAINNET_ESCROW["channel-33"]!]);
    expect(dydx.source_url).toBe(LCD[0] + escrowPaths.balance(dydx.escrow_address));
    expect(r).toMatchObject({ endpoint: LCD[0], block: "63433803", total_escrow_raw: "82283601252571", supply_raw: "86390197192504", fetched_at: NOW.toISOString() });
  });

  it("moves to the next endpoint when one returns garbage, so all balances share an endpoint", async () => {
    const fetch = mockFetch({ [LCD[0]!]: "garbage", [LCD[1]!]: lcdHandler(allBalances()) });
    const r = await fetchEscrow(LCD, { fetch, timeoutMs: 1000 });
    expect(r.endpoint).toBe(LCD[1]);
  });

  it("treats total escrow as optional", async () => {
    const fetch = mockFetch({ [LCD[0]!]: lcdHandler(allBalances(), { totalEscrow: false }) });
    const r = await fetchEscrow(LCD, { fetch, timeoutMs: 1000 });
    expect(r.total_escrow_raw).toBeNull();
    expect(r.supply_raw).toBe("86390197192504");
  });

  it("fails when no endpoint can read the balances", async () => {
    const fetch = mockFetch({ [LCD[0]!]: "down", [LCD[1]!]: "500" });
    await expect(fetchEscrow(LCD, { fetch, timeoutMs: 1000 })).rejects.toBeInstanceOf(AllEndpointsFailedError);
  });
});

// ---------------------------------------------------------------- daily history

function reading(ts: string, balances: Record<string, string>, channels: Record<string, string> = {}): EscrowReading {
  return {
    fetched_at: ts,
    endpoint: LCD[0]!,
    chains: Object.entries(balances).map(([chain, balance_raw]) => ({
      chain,
      label: chain,
      port: "transfer",
      noble_channel: channels[chain] ?? "channel-1",
      counterparty_channel: "channel-x",
      registry_url: "",
      escrow_address: "noble1x",
      balance_raw,
      source_url: "",
    })),
    total_escrow_raw: null,
    supply_raw: null,
  };
}

const day = (ts: string, balances: Record<string, string>, channels: Record<string, string> = {}): EscrowDay => ({
  date: ts.slice(0, 10),
  ts,
  balances,
  channels: Object.fromEntries(Object.keys(balances).map((k) => [k, channels[k] ?? "channel-1"])),
  total_escrow_raw: null,
  supply_raw: null,
});

describe("daily snapshots", () => {
  const defs = [{ chain: "a", label: "A", noble_channel: "channel-1", counterparty_channel: "channel-2", escrow_address: "noble1a" }];

  it("needs one reading per UTC day", () => {
    const f = recordDaily(emptyEscrow(), reading("2026-11-06T00:07:00Z", { a: "1" }));
    expect(needsDailySnapshot(f, new Date("2026-11-06T23:52:00Z"), defs)).toBe(false);
    expect(needsDailySnapshot(f, new Date("2026-11-07T00:07:00Z"), defs)).toBe(true);
    expect(needsDailySnapshot(emptyEscrow(), NOW, defs)).toBe(true);
  });

  it("retries a day that is missing a chain", () => {
    const f = recordDaily(emptyEscrow(), reading("2026-11-06T00:07:00Z", { a: "1" }));
    expect(needsDailySnapshot(f, NOW, [...defs, { ...defs[0]!, chain: "b" }])).toBe(true);
  });

  it("keeps the first complete reading of the day and orders days", () => {
    let f = recordDaily(emptyEscrow(), reading("2026-11-06T00:07:00Z", { a: "1", b: "2" }));
    f = recordDaily(f, reading("2026-11-05T00:07:00Z", { a: "0", b: "0" }));
    f = recordDaily(f, reading("2026-11-06T00:22:00Z", { a: "9", b: "9" }));
    expect(f.days.map((d) => d.date)).toEqual(["2026-11-05", "2026-11-06"]);
    expect(f.days[1]!.balances).toEqual({ a: "1", b: "2" });
    // A more complete reading replaces an incomplete one.
    f = recordDaily(recordDaily(emptyEscrow(), reading("2026-11-06T00:07:00Z", { a: "1" })), reading("2026-11-06T00:22:00Z", { a: "5", b: "6" }));
    expect(f.days[0]).toMatchObject({ ts: "2026-11-06T00:22:00Z", balances: { a: "5", b: "6" } });
  });

  it("trims to the history limit", () => {
    let f = emptyEscrow();
    for (let i = 1; i <= 5; i++) f = recordDaily(f, reading(`2026-11-0${i}T00:07:00Z`, { a: String(i) }), 3);
    expect(f.days.map((d) => d.date)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05"]);
  });
});

describe("escrowChange", () => {
  const now = new Date("2026-11-08T12:00:00Z");
  const days = [
    day("2026-11-01T00:07:00Z", { a: "1000000000" }),
    day("2026-11-07T00:07:00Z", { a: "2000000000" }),
    day("2026-11-08T00:07:00Z", { a: "3000000000" }),
  ];

  it("compares with the snapshot nearest to 24h / 7d ago", () => {
    // 24h target 11-07 12:00: 11-07 00:07 and 11-08 00:07 are ~12h away; the older one wins the tie.
    expect(escrowChange(days, { raw: 2_500_000_000n }, "a", 24, now)).toEqual({
      since: "2026-11-07T00:07:00Z",
      previous_raw: "2000000000",
      delta_raw: "500000000",
      delta_pct: "25.00",
    });
    expect(escrowChange(days, { raw: 500_000_000n }, "a", 168, now)).toMatchObject({ since: "2026-11-01T00:07:00Z", delta_raw: "-500000000", delta_pct: "-50.00" });
  });

  it("never uses a baseline younger than half the window", () => {
    expect(escrowChange([day("2026-11-08T06:00:00Z", { a: "1" })], { raw: 2n }, "a", 24, now)).toBeNull();
    expect(escrowChange([], { raw: 2n }, "a", 24, now)).toBeNull();
  });

  it("skips snapshots taken on a different channel", () => {
    const d = [day("2026-11-07T00:07:00Z", { a: "1" }, { a: "channel-9" })];
    expect(escrowChange(d, { raw: 2n, channel: "channel-1" }, "a", 24, now)).toBeNull();
    expect(escrowChange(d, { raw: 2n, channel: "channel-9" }, "a", 24, now)?.delta_raw).toBe("1");
  });

  it("sums several chains and needs all of them in the baseline", () => {
    const d = [day("2026-11-07T00:07:00Z", { a: "1", b: "2" }), day("2026-11-06T12:00:00Z", { a: "1" })];
    expect(escrowChange(d, { raw: 10n }, ["a", "b"], 24, now)).toMatchObject({ previous_raw: "3", delta_raw: "7" });
  });

  it("has no percent against a zero baseline", () => {
    expect(escrowChange([day("2026-11-07T00:07:00Z", { a: "0" })], { raw: 5n }, "a", 24, now)?.delta_pct).toBeNull();
  });
});

describe("pct", () => {
  it("is exact with 2 decimals, rounded half away from zero", () => {
    expect(pct(1n, 3n)).toBe("33.33");
    expect(pct(2n, 3n)).toBe("66.67");
    expect(pct(-1n, 8n)).toBe("-12.50");
    expect(pct(0n, 5n)).toBe("0.00");
    expect(pct(-1n, 1_000_000n)).toBe("0.00");
    expect(pct(70806636018842n, 80330641073397n)).toBe("88.14");
  });
});
