/**
 * Static JSON files published to the `data` branch by the GitHub Action.
 * They double as a keyless, domain-less read-only API:
 *   latest.json   last full status snapshot (same shape as StatusSnapshot)
 *   history.json  compact snapshots for the last HISTORY_PUBLISH_DAYS (limits + route states)
 *   burns.json    daily USDC burned on Noble per destination + recent burns
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BurnsFile } from "./burns";
import type { AppConfig } from "./config";
import { TRACKED_LIMITS } from "./history";
import type { SnapshotRecord, SnapshotStore } from "./storage";
import type { StatusSnapshot } from "./types";

export interface HistoryFile {
  generated_at: string;
  snapshot_interval_min: number;
  days: number;
  records: SnapshotRecord[];
}

export function compactRecord(r: SnapshotRecord): SnapshotRecord {
  const checks: SnapshotRecord["checks"] = {};
  for (const id of TRACKED_LIMITS) if (r.checks[id]) checks[id] = r.checks[id];
  return { ts: r.ts, checks, routes: r.routes };
}

async function writeJson(path: string, data: unknown) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data) + "\n", "utf8");
  await rename(tmp, path); // atomic on the same filesystem
}

export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err: any) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export async function publishData(
  cfg: AppConfig,
  status: StatusSnapshot,
  store: SnapshotStore,
  burns: BurnsFile | null,
  now = new Date(),
) {
  await mkdir(cfg.dataDir, { recursive: true });
  const since = new Date(now.getTime() - cfg.historyPublishDays * 86400_000);
  const history: HistoryFile = {
    generated_at: now.toISOString(),
    snapshot_interval_min: cfg.snapshotIntervalMin,
    days: cfg.historyPublishDays,
    records: (await store.since(since)).map(compactRecord),
  };
  await writeJson(join(cfg.dataDir, "latest.json"), status);
  await writeJson(join(cfg.dataDir, "history.json"), history);
  if (burns) await writeJson(join(cfg.dataDir, "burns.json"), burns);
  return { history_records: history.records.length };
}
