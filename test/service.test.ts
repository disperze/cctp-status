import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { changeInfo, detectChanges } from "../src/history";
import { createApp } from "../src/server";
import { StatusService } from "../src/service";
import { JsonlStore, MemoryStore, openStore, type SnapshotRecord } from "../src/storage";
import type { CheckResult } from "../src/types";
import { healthyChecks, NOW, testConfig } from "./helpers";

/** Controllable fake chain + clock. */
function harness(cfgOver = {}) {
  let now = new Date(NOW);
  let checks: CheckResult[] = healthyChecks();
  let reads = 0;
  const stamp = (cs: CheckResult[]) => cs.map((c) => ({ ...c, fetched_at: now.toISOString() }));
  const isNoble = (c: CheckResult) => ["A1", "A2", "A3", "A4", "A11", "B2"].includes(c.id);
  const store = new MemoryStore();
  const notified: string[] = [];
  const service = new StatusService(testConfig(cfgOver), store, {
    now: () => now,
    fetchNoble: async () => {
      reads++;
      return stamp(checks.filter(isNoble));
    },
    fetchEth: async () => stamp(checks.filter((c) => !isNoble(c))),
    notify: async (evs) => void notified.push(...evs.map((e) => e.message)),
  });
  return {
    service,
    store,
    notified,
    get reads() {
      return reads;
    },
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
    set(over: Parameters<typeof healthyChecks>[0]) {
      checks = healthyChecks(over);
    },
  };
}

describe("StatusService", () => {
  it("caches /api/status for STATUS_CACHE_SEC and shares one fetch", async () => {
    const h = harness();
    await Promise.all([h.service.getStatus(), h.service.getStatus(), h.service.getStatus()]);
    expect(h.reads).toBe(1);
    h.advance(44_000);
    await h.service.getStatus();
    expect(h.reads).toBe(1);
    h.advance(2_000);
    await h.service.getStatus();
    expect(h.reads).toBe(2);
  });

  it("acceptance 3: a pause flag shows PAUSED within one poll cycle", async () => {
    const h = harness();
    expect((await h.service.getStatus()).routes["noble-eth"].state).toBe("OPEN");
    h.set({ A2: { status: "blocked", raw: "true", detail: "Paused on Noble" } });
    h.advance(45_000); // one cache cycle
    const s = await h.service.getStatus();
    expect(s.routes["noble-eth"].state).toBe("PAUSED");
    expect(s.routes["eth-noble"].state).toBe("PAUSED");
  });

  it("carries the last good value forward on error and reports UNKNOWN", async () => {
    const h = harness();
    await h.service.getStatus();
    h.set({ A5: { status: "error", raw: null, value_usdc: undefined, detail: "All endpoints failed" } });
    h.advance(60_000);
    const s = await h.service.getStatus();
    const a5 = s.checks.find((c) => c.id === "A5")!;
    expect(a5.status).toBe("error");
    expect(a5.last_good).toMatchObject({ raw: "75000000000000", value_usdc: "75000000" });
    expect(s.routes["noble-eth"].state).toBe("UNKNOWN");
  });

  it("flags values older than 2x the poll interval as stale and refuses OPEN", async () => {
    const h = harness();
    const s1 = await h.service.getStatus();
    expect(s1.checks.every((c) => c.stale === false)).toBe(true);
    expect(s1.config.stale_after_sec).toBe(90);

    // An upstream that serves an old reading (e.g. a lagging LCD cache) for A7.
    const old = new Date(NOW.getTime() - 120_000).toISOString();
    const svc = new StatusService(testConfig(), new MemoryStore(), {
      now: () => NOW,
      fetchNoble: async () => healthyChecks().filter((c) => ["A1", "A2", "A3", "A4", "A11", "B2"].includes(c.id)),
      fetchEth: async () =>
        healthyChecks({ A7: { fetched_at: old } }).filter((c) => !["A1", "A2", "A3", "A4", "A11", "B2"].includes(c.id)),
    });
    const s2 = await svc.getStatus();
    expect(s2.checks.find((c) => c.id === "A7")!.stale).toBe(true);
    expect(s2.routes["noble-eth"].state).toBe("UNKNOWN");
    expect(s2.routes["eth-noble"].state).toBe("UNKNOWN");
  });

  it("acceptance 4: history and 'last changed' update when a limit changes", async () => {
    const h = harness();
    await h.service.snapshot();
    h.advance(15 * 60_000);
    await h.service.snapshot();
    let hist = await h.service.history(72);
    expect(hist.count).toBe(2);
    expect(hist.changes.A1!.last_changed_at).toBeNull();

    h.set({ A1: { raw: "400000000000", value_usdc: "400000" } });
    h.advance(15 * 60_000);
    const changedAt = new Date(h.service["deps"].now!()).toISOString();
    const s = await h.service.snapshot();
    hist = await h.service.history(72);
    expect(hist.count).toBe(3);
    expect(hist.series.map((p) => p.A1)).toEqual(["500000000000", "500000000000", "400000000000"]);
    expect(hist.changes.A1).toMatchObject({
      current_raw: "400000000000",
      previous_raw: "500000000000",
      delta_raw: "-100000000000",
      delta_usdc: "-100000",
      last_changed_at: changedAt,
    });
    // limit fell vs the 24h max => DEGRADED, and alerts fired for the limit and the route flip
    expect(s.routes["noble-eth"].state).toBe("DEGRADED");
    expect(h.notified.some((m) => /Noble per-message burn limit|Check A1/.test(m) && /500000 → 400000/.test(m))).toBe(true);
    expect(h.notified.some((m) => /OPEN → DEGRADED/.test(m))).toBe(true);
  });

  it("history window filters by hours", async () => {
    const h = harness();
    await h.service.snapshot();
    h.advance(5 * 3600_000);
    await h.service.snapshot();
    expect((await h.service.history(1)).count).toBe(1);
    expect((await h.service.history(6)).count).toBe(2);
  });
});

describe("history helpers", () => {
  const rec = (ts: string, a1: string | null): SnapshotRecord => ({
    ts,
    checks: { A1: a1 === null ? { s: "error", r: null } : { s: "ok", r: a1 } },
    routes: { "noble-eth": "OPEN", "eth-noble": "OPEN" },
  });

  it("changeInfo skips error gaps and finds the first snapshot with the current value", () => {
    const records = [rec("t1", "5"), rec("t2", "5"), rec("t3", null), rec("t4", "3"), rec("t5", "3")];
    expect(changeInfo(records, "A1")).toMatchObject({ current_raw: "3", previous_raw: "5", last_changed_at: "t4", delta_raw: "-2" });
    expect(changeInfo([], "A1").current_raw).toBeNull();
  });

  it("detectChanges ignores error flips per check", () => {
    const prev = rec("t1", "500000000000");
    const s = {
      generated_at: "t2",
      checks: healthyChecks({ A3: { status: "error", raw: null } }),
      routes: {
        "noble-eth": { label: "Noble → Ethereum", state: "OPEN", reasons: [] },
        "eth-noble": { label: "Ethereum → Noble", state: "OPEN", reasons: [] },
      },
    } as any;
    expect(detectChanges(prev, s)).toEqual([]);
  });
});

describe("storage", () => {
  const dir = mkdtempSync(join(tmpdir(), "cctp-status-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const sample = (ts: string): SnapshotRecord => ({ ts, checks: { A1: { s: "ok", r: "1" } }, routes: { "noble-eth": "OPEN", "eth-noble": "OPEN" } });

  it("JSONL store persists and reloads", async () => {
    const path = join(dir, "s.jsonl");
    const a = new JsonlStore(path);
    await a.append(sample("2026-11-06T00:00:00.000Z"));
    await a.append(sample("2026-11-06T01:00:00.000Z"));
    const b = new JsonlStore(path);
    expect((await b.since(new Date("2026-11-06T00:30:00Z"))).map((r) => r.ts)).toEqual(["2026-11-06T01:00:00.000Z"]);
    expect((await b.latest())?.ts).toBe("2026-11-06T01:00:00.000Z");
  });

  it("SQLite store (node:sqlite) when available", async () => {
    let store;
    try {
      store = await openStore(join(dir, "s.db"));
    } catch {
      return; // Node < 22.13: JSONL is the supported backend
    }
    await store.append(sample("2026-11-06T00:00:00.000Z"));
    await store.append(sample("2026-11-06T02:00:00.000Z"));
    expect((await store.since(new Date("2026-11-06T01:00:00Z"))).length).toBe(1);
    expect((await store.latest())?.ts).toBe("2026-11-06T02:00:00.000Z");
    store.close?.();
  });
});

describe("HTTP API", () => {
  const h = harness();
  const app = createApp(h.service);

  it("GET /api/calc acceptance: 2,000,000 USDC => 5 messages", async () => {
    const res = await app.request("/api/calc?amount=2000000&direction=noble-eth");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ messages: "5", per_tx_limit_usdc: "500000", safe_chunk_usdc: "499000", fits_destination_cap: true });
  });

  it("GET /api/calc validates input", async () => {
    expect((await app.request("/api/calc?amount=abc")).status).toBe(400);
    expect((await app.request("/api/calc?amount=0")).status).toBe(400);
    expect((await app.request("/api/calc?amount=1&direction=sideways")).status).toBe(400);
    expect((await app.request("/api/calc")).status).toBe(400);
    expect((await app.request("/api/calc?amount_raw=2000000000000")).status).toBe(200);
  });

  it("GET /api/status returns every check in the common shape", async () => {
    const body = await (await app.request("/api/status")).json();
    expect(body.checks).toHaveLength(13);
    for (const c of body.checks) {
      for (const k of ["id", "label", "raw", "status", "source", "fetched_at"]) expect(c).toHaveProperty(k);
    }
    expect(body.routes["noble-eth"]).toMatchObject({ state: "OPEN", max_per_tx_usdc: "500000", destination_cap_usdc: "75000000" });
  });

  it("GET /api/history validates hours", async () => {
    expect((await app.request("/api/history?hours=-1")).status).toBe(400);
    expect((await app.request("/api/history?hours=72")).status).toBe(200);
  });
});
