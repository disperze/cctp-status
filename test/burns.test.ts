import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addBurns, emptyBurns, syncBurns, type BurnsFile } from "../src/burns";
import { parseDepositForBurnTxs } from "../src/noble";
import { publishData } from "../src/publish";
import { MemoryStore } from "../src/storage";
import { jsonResponse, mockFetch, testConfig } from "./helpers";

const URLS = ["https://lcd-a.test", "https://lcd-b.test"];
const deps = (f: typeof fetch) => ({ fetch: f, timeoutMs: 1000, allowanceWarnRaw: 0n });

interface FakeBurn { height: number; time: string; amount: string; domain: number; code?: number }

function burnTx(b: FakeBurn, i: number) {
  return {
    txhash: `TX${b.height}_${i}`,
    height: String(b.height),
    timestamp: b.time,
    code: b.code ?? 0,
    events: [
      {
        type: "circle.cctp.v1.DepositForBurn",
        attributes: [
          { key: "amount", value: JSON.stringify(b.amount) },
          { key: "destination_domain", value: String(b.domain) },
          { key: "mint_recipient", value: '"AAAAAAAAAAAAAAAAbtI6GIpRqAG2CEY+NZhv3CgvKnk="' },
          { key: "nonce", value: `"${b.height}${i}"` },
        ],
      },
    ],
  };
}

/** A fake Noble LCD holding a list of burns, honoring `tx.height>N`, ascending order, page & limit. */
function chain(burns: FakeBurn[], opts: { latest?: number; secsPerBlock?: number } = {}) {
  const latest = opts.latest ?? 100_000;
  const spb = opts.secsPerBlock ?? 1;
  const tLatest = Date.parse("2026-11-06T12:00:00Z");
  const queries: string[] = [];
  const handler = (path: string) => {
    if (path === "/cosmos/base/tendermint/v1beta1/blocks/latest") {
      return jsonResponse({ block: { header: { height: String(latest), time: new Date(tLatest).toISOString() } } });
    }
    const blk = /^\/cosmos\/base\/tendermint\/v1beta1\/blocks\/(\d+)$/.exec(path);
    if (blk) {
      const h = Number(blk[1]);
      return jsonResponse({ block: { header: { height: String(h), time: new Date(tLatest - (latest - h) * spb * 1000).toISOString() } } });
    }
    if (path.startsWith("/cosmos/tx/v1beta1/txs?")) {
      const qs = new URLSearchParams(path.split("?")[1]);
      const q = qs.get("query")!;
      queries.push(q);
      expect(q).toMatch(/^circle\.cctp\.v1\.DepositForBurn\.destination_domain EXISTS AND tx\.height>\d+$/);
      expect(qs.get("order_by")).toBe("ORDER_BY_ASC");
      const after = Number(/tx\.height>(\d+)/.exec(q)![1]);
      const page = Number(qs.get("page"));
      const limit = Number(qs.get("limit"));
      const all = burns.filter((b) => b.height > after).sort((a, b) => a.height - b.height).map(burnTx);
      return jsonResponse({ tx_responses: all.slice((page - 1) * limit, page * limit), total: String(all.length) });
    }
    return jsonResponse({ code: 12, message: "not implemented" }, 501);
  };
  return { handler, queries };
}

describe("syncBurns", () => {
  const now = new Date("2026-11-06T12:00:00Z");

  it("first run backfills N days from the measured block time", async () => {
    const c = chain([], { latest: 1_000_000, secsPerBlock: 2 });
    const { file } = await syncBurns(emptyBurns(), URLS, deps(mockFetch({ "https://lcd-a.test": c.handler })), { backfillDays: 1, maxPages: 5, now });
    // 1 day at 2 s/block = 43,200 blocks back
    expect(file.start_height).toBe(String(1_000_000 - 43_200));
    expect(file.cursor_height).toBe(file.start_height);
    expect(file.tracking_since).toBe("2026-11-05T12:00:00.000Z");
    expect(file.caught_up).toBe(true);
    expect(c.queries[0]).toContain(`tx.height>${1_000_000 - 43_200}`);
  });

  it("aggregates per UTC day and destination, skips failed txs, keeps recent newest-first", async () => {
    const burns: FakeBurn[] = [
      { height: 99_990, time: "2026-11-05T23:59:59Z", amount: "1000000", domain: 0 },
      { height: 99_991, time: "2026-11-06T00:00:01Z", amount: "2500000", domain: 0 },
      { height: 99_992, time: "2026-11-06T01:00:00Z", amount: "7000000", domain: 3 },
      { height: 99_993, time: "2026-11-06T02:00:00Z", amount: "9999000000", domain: 0, code: 5 }, // failed
    ];
    const c = chain(burns);
    const { file, added } = await syncBurns(emptyBurns(), URLS, deps(mockFetch({ "https://lcd-a.test": c.handler })), { backfillDays: 1, maxPages: 5, now });
    expect(added).toBe(3);
    expect(file.days).toEqual({
      "2026-11-05": { "0": { count: 1, amount_raw: "1000000" } },
      "2026-11-06": { "0": { count: 1, amount_raw: "2500000" }, "3": { count: 1, amount_raw: "7000000" } },
    });
    expect(file.recent.map((r) => r.height)).toEqual(["99992", "99991", "99990"]);
    expect(file.cursor_height).toBe("99992");
  });

  it("is idempotent: a second run with no new burns adds nothing", async () => {
    const burns: FakeBurn[] = [{ height: 99_995, time: "2026-11-06T10:00:00Z", amount: "5000000", domain: 0 }];
    const c = chain(burns);
    const f = mockFetch({ "https://lcd-a.test": c.handler });
    const first = await syncBurns(emptyBurns(), URLS, deps(f), { backfillDays: 1, maxPages: 5, now });
    const second = await syncBurns(first.file, URLS, deps(f), { backfillDays: 1, maxPages: 5, now });
    expect(second.added).toBe(0);
    expect(second.file.days).toEqual(first.file.days);
    // and picks up only newer burns afterwards
    burns.push({ height: 99_999, time: "2026-11-06T11:00:00Z", amount: "1000000", domain: 6 });
    const third = await syncBurns(second.file, URLS, deps(f), { backfillDays: 1, maxPages: 5, now });
    expect(third.added).toBe(1);
    expect(third.file.days["2026-11-06"]).toEqual({ "0": { count: 1, amount_raw: "5000000" }, "6": { count: 1, amount_raw: "1000000" } });
  });

  it("spreads a large backfill over several runs without double counting a split height", async () => {
    // 7 burns; heights 10,11,12,12,12,13,14 — page size 2, max 2 pages per run.
    const heights = [99_910, 99_911, 99_912, 99_912, 99_912, 99_913, 99_914];
    const burns = heights.map((h, i) => ({ height: h, time: `2026-11-06T0${i}:00:00Z`, amount: "1000000", domain: 0 }));
    const c = chain(burns);
    const f = mockFetch({ "https://lcd-a.test": c.handler });
    const opts = { backfillDays: 1, maxPages: 2, pageLimit: 2, now };

    let r = await syncBurns(emptyBurns(), URLS, deps(f), opts);
    // fetched 99910, 99911, 99912, 99912 (page cap hit) -> height 99912 is split, so it is dropped
    expect(r.added).toBe(2);
    expect(r.file.cursor_height).toBe("99911");
    expect(r.file.caught_up).toBe(false);

    let file = r.file;
    for (let i = 0; i < 5 && !file.caught_up; i++) file = (await syncBurns(file, URLS, deps(f), opts)).file;
    expect(file.caught_up).toBe(true);
    expect(file.days["2026-11-06"]!["0"]).toEqual({ count: 7, amount_raw: "7000000" });
    expect(file.cursor_height).toBe("99914");
  });

  it("fails over to the next LCD and throws (keeping state) when all fail", async () => {
    const c = chain([{ height: 99_999, time: "2026-11-06T11:00:00Z", amount: "1", domain: 0 }]);
    const ok = await syncBurns(emptyBurns(), URLS, deps(mockFetch({ "https://lcd-a.test": "down", "https://lcd-b.test": c.handler })), {
      backfillDays: 1, maxPages: 5, now,
    });
    expect(ok.added).toBe(1);
    const prev = ok.file;
    await expect(
      syncBurns(prev, URLS, deps(mockFetch({ "https://lcd-a.test": "down", "https://lcd-b.test": "500" })), { backfillDays: 1, maxPages: 5, now }),
    ).rejects.toThrow(/All 2 endpoint/);
    expect(prev.cursor_height).toBe("99999"); // input not mutated
  });
});

describe("parseDepositForBurnTxs (all destinations)", () => {
  it("keeps 32-byte recipients for non-EVM destinations", () => {
    const solanaRecipient = Buffer.alloc(32, 0xab).toString("base64");
    const body = {
      tx_responses: [
        {
          txhash: "S", height: "1", timestamp: "2026-11-06T00:00:00Z", code: 0,
          events: [{ type: "circle.cctp.v1.DepositForBurn", attributes: [
            { key: "amount", value: '"5"' }, { key: "destination_domain", value: "5" }, { key: "mint_recipient", value: JSON.stringify(solanaRecipient) },
          ] }],
        },
      ],
    };
    const [b] = parseDepositForBurnTxs(body);
    expect(b!.destination_domain).toBe(5);
    expect(b!.mint_recipient).toBe("0x" + "ab".repeat(32));
  });
});

describe("addBurns", () => {
  it("caps recent at 25", () => {
    const f: BurnsFile = emptyBurns();
    const many = Array.from({ length: 40 }, (_, i) => ({
      txhash: `T${i}`, height: String(i), time: "2026-11-06T00:00:00Z", nonce: null, amount_raw: "1", amount_usdc: "0.000001",
      depositor: null, destination_domain: 0, mint_recipient: null, explorer_url: "",
    }));
    addBurns(f, many);
    expect(f.recent).toHaveLength(25);
    expect(f.recent[0]!.txhash).toBe("T39");
    expect(f.days["2026-11-06"]!["0"]!.count).toBe(40);
  });
});

describe("publishData", () => {
  const dir = mkdtempSync(join(tmpdir(), "cctp-pub-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("writes latest/history/burns, with history trimmed to the window and tracked limits", async () => {
    const cfg = { ...testConfig(), dataDir: dir, historyPublishDays: 1 };
    const store = new MemoryStore();
    const rec = (ts: string) => ({
      ts,
      checks: { A1: { s: "ok" as const, r: "1" }, A2: { s: "ok" as const, r: "false" }, B2: { s: "ok" as const, r: "2" } },
      routes: { "noble-eth": "OPEN" as const, "eth-noble": "OPEN" as const },
    });
    await store.append(rec("2026-11-04T00:00:00.000Z")); // outside 1-day window
    await store.append(rec("2026-11-06T00:00:00.000Z"));
    const status = { generated_at: "2026-11-06T12:00:00.000Z" } as any;
    const burns = emptyBurns();
    await publishData(cfg, status, store, burns, new Date("2026-11-06T12:00:00Z"));

    const hist = JSON.parse(readFileSync(join(dir, "history.json"), "utf8"));
    expect(hist.records).toHaveLength(1);
    expect(Object.keys(hist.records[0].checks).sort()).toEqual(["A1", "B2"]); // A2 dropped
    expect(JSON.parse(readFileSync(join(dir, "latest.json"), "utf8")).generated_at).toBe(status.generated_at);
    expect(JSON.parse(readFileSync(join(dir, "burns.json"), "utf8")).version).toBe(1);
  });
});
