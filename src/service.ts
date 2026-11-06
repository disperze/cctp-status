import type { TrendBaseline } from "./aggregate";
import { calculate, type CalcResponse } from "./calc";
import type { AppConfig } from "./config";
import { fetchEthereumChecks } from "./ethereum";
import { changeInfo, chartSeries, detectChanges, toRecord, TRACKED_LIMITS } from "./history";
import { fetchNobleChecks, fetchRecentBurns } from "./noble";
import type { SnapshotStore } from "./storage";
import { composeStatus, sortChecks, staleAfterMs, trendFromRecords } from "./status";
import type { CheckId, CheckResult, Direction, StatusSnapshot } from "./types";
import type { Notifier } from "./alerts";

export interface ServiceDeps {
  fetchNoble?: (urls: readonly string[]) => Promise<CheckResult[]>;
  fetchEth?: (urls: readonly string[]) => Promise<CheckResult[]>;
  fetchActivity?: () => Promise<unknown>;
  notify?: Notifier;
  now?: () => Date;
}

interface Reading {
  checks: CheckResult[];
  trend: Record<Direction, TrendBaseline | null>;
  at: number;
}

export class StatusService {
  private reading: Reading | null = null;
  private inflight: Promise<Reading> | null = null;
  private lastGood = new Map<CheckId, CheckResult>();
  private activity: { at: number; data: unknown } | null = null;
  private activityInflight: Promise<unknown> | null = null;

  constructor(
    readonly cfg: AppConfig,
    readonly store: SnapshotStore,
    private readonly deps: ServiceDeps = {},
  ) {}

  private now() {
    return this.deps.now ? this.deps.now() : new Date();
  }

  get staleAfterMs() {
    return staleAfterMs(this.cfg);
  }

  /** Read every check from chain right now (no cache). */
  private async read(): Promise<Reading> {
    const depsCommon = { timeoutMs: this.cfg.requestTimeoutMs, allowanceWarnRaw: this.cfg.allowanceWarnRaw };
    const fetchNoble = this.deps.fetchNoble ?? ((u) => fetchNobleChecks(u, depsCommon));
    const fetchEth = this.deps.fetchEth ?? ((u) => fetchEthereumChecks(u, depsCommon));
    const [noble, eth] = await Promise.all([fetchNoble(this.cfg.nobleLcdUrls), fetchEth(this.cfg.ethRpcUrls)]);

    const checks = sortChecks([...noble, ...eth]).map((c) => {
      if (c.status !== "error") {
        this.lastGood.set(c.id, c);
        return c;
      }
      const prev = this.lastGood.get(c.id);
      return prev ? { ...c, last_good: { raw: prev.raw, value_usdc: prev.value_usdc, fetched_at: prev.fetched_at } } : c;
    });

    const now = this.now();
    const recent = await this.store.since(new Date(now.getTime() - this.cfg.trendWindowHours * 3600_000));
    return { checks, trend: trendFromRecords(recent, this.cfg, now), at: now.getTime() };
  }

  private refresh(): Promise<Reading> {
    if (!this.inflight) {
      this.inflight = this.read()
        .then((r) => (this.reading = r))
        .finally(() => (this.inflight = null));
    }
    return this.inflight;
  }

  /** Build the public snapshot. Route state is recomputed each time so staleness is always current. */
  private compose(reading: Reading): StatusSnapshot {
    return composeStatus(reading.checks, reading.trend, this.cfg, new Date(reading.at), this.now());
  }

  /** Latest status, cached for STATUS_CACHE_SEC. Concurrent callers share one fetch. */
  async getStatus(): Promise<StatusSnapshot> {
    const fresh = this.reading && this.now().getTime() - this.reading.at < this.cfg.statusCacheSec * 1000;
    const reading = fresh ? this.reading! : await this.refresh();
    return this.compose(reading);
  }

  /** Fresh read, persisted to history, alerts on changes. Called by the scheduler. */
  async snapshot(): Promise<StatusSnapshot> {
    const prev = await this.store.latest();
    const status = this.compose(await this.refresh());
    const rec = toRecord(status);
    await this.store.append(rec);
    const events = detectChanges(prev, status);
    if (events.length && this.deps.notify) await this.deps.notify(events);
    return status;
  }

  async history(hours: number) {
    const to = this.now();
    const from = new Date(to.getTime() - hours * 3600_000);
    const records = await this.store.since(from);
    const changes = Object.fromEntries(TRACKED_LIMITS.map((id) => [id, changeInfo(records, id)]));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      hours,
      count: records.length,
      series: chartSeries(records),
      changes,
    };
  }

  async calc(direction: Direction, amount: bigint): Promise<CalcResponse> {
    return calculate(await this.getStatus(), direction, amount, this.cfg.safetyMargin);
  }

  async recentActivity(): Promise<unknown> {
    const ttl = 120_000;
    if (this.activity && this.now().getTime() - this.activity.at < ttl) return this.activity.data;
    if (!this.activityInflight) {
      const f =
        this.deps.fetchActivity ??
        (() => fetchRecentBurns(this.cfg.nobleLcdUrls, { timeoutMs: this.cfg.requestTimeoutMs, allowanceWarnRaw: 0n }, 10));
      this.activityInflight = f()
        .then((data) => {
          this.activity = { at: this.now().getTime(), data };
          return data;
        })
        .finally(() => (this.activityInflight = null));
    }
    return this.activityInflight;
  }
}
