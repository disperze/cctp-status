/**
 * Daily USDC burned on Noble via CCTP V1, per destination domain.
 *
 * Incremental and idempotent: `cursor_height` is the highest block whose burns are
 * all counted. Each run fetches txs with `tx.height > cursor` in ascending order,
 * so nothing is counted twice. The first run backfills `burnsBackfillDays`; a large
 * backfill is spread over several runs by `burnsMaxPages`.
 */
import { NOBLE } from "./config";
import { lcdQuery, parseDepositForBurnTxs, type NobleDeps, type RecentBurn } from "./noble";

export interface DayBucket {
  count: number;
  amount_raw: string;
}

export interface BurnsFile {
  version: 1;
  updated_at: string | null;
  /** Every burn at height <= cursor_height is counted. */
  cursor_height: string | null;
  /** Timestamp of the newest counted burn. */
  cursor_time: string | null;
  /** Tracking started here (exclusive). Days before tracking_since are not covered. */
  start_height: string | null;
  tracking_since: string | null;
  /** True when the last run reached the chain head (false while a backfill is catching up). */
  caught_up: boolean;
  /** UTC date (YYYY-MM-DD) -> destination domain -> totals. */
  days: Record<string, Record<string, DayBucket>>;
  /** Newest first. */
  recent: RecentBurn[];
}

export const RECENT_KEEP = 25;
export const PAGE_LIMIT = 50;

export function emptyBurns(): BurnsFile {
  return {
    version: 1,
    updated_at: null,
    cursor_height: null,
    cursor_time: null,
    start_height: null,
    tracking_since: null,
    caught_up: false,
    days: {},
    recent: [],
  };
}

interface BlockInfo {
  height: bigint;
  time: string;
}

async function getBlock(urls: readonly string[], deps: NobleDeps, height?: bigint): Promise<BlockInfo> {
  const path = height === undefined ? NOBLE.paths.latestBlock : NOBLE.paths.block(height);
  const { value } = await lcdQuery<any>(urls, path, deps);
  const header = value.body?.block?.header ?? value.body?.sdk_block?.header;
  if (!header?.height || !header?.time) throw new Error(`Unexpected block response for ${path}`);
  return { height: BigInt(header.height), time: header.time };
}

/** Pick the height `days` ago from the measured average block time. */
async function backfillStart(urls: readonly string[], deps: NobleDeps, days: number): Promise<{ height: bigint; time: string }> {
  const latest = await getBlock(urls, deps);
  const sampleGap = 1000n;
  const sample = await getBlock(urls, deps, latest.height - sampleGap);
  const secsPerBlock = (Date.parse(latest.time) - Date.parse(sample.time)) / 1000 / Number(sampleGap);
  if (!(secsPerBlock > 0)) throw new Error("Could not estimate block time");
  const back = BigInt(Math.ceil((days * 86400) / secsPerBlock));
  const height = latest.height > back ? latest.height - back : 0n;
  return { height, time: new Date(Date.parse(latest.time) - days * 86400_000).toISOString() };
}

export function txsPath(afterHeight: bigint, page: number, limit = PAGE_LIMIT): string {
  const q = encodeURIComponent(`${NOBLE.depositForBurnEvent}.destination_domain EXISTS AND tx.height>${afterHeight}`);
  return `${NOBLE.paths.txs}?query=${q}&order_by=ORDER_BY_ASC&page=${page}&limit=${limit}&pagination.limit=${limit}`;
}

export function addBurns(file: BurnsFile, burns: RecentBurn[]): void {
  for (const b of burns) {
    const day = b.time.slice(0, 10);
    const dom = String(b.destination_domain);
    const bucket = ((file.days[day] ??= {})[dom] ??= { count: 0, amount_raw: "0" });
    bucket.count += 1;
    bucket.amount_raw = (BigInt(bucket.amount_raw) + BigInt(b.amount_raw)).toString();
  }
  const merged = [...burns].reverse().concat(file.recent);
  file.recent = merged.slice(0, RECENT_KEEP);
}

export async function syncBurns(
  prev: BurnsFile,
  urls: readonly string[],
  deps: NobleDeps,
  opts: { backfillDays: number; maxPages: number; pageLimit?: number; now?: Date },
): Promise<{ file: BurnsFile; added: number; pages: number }> {
  const file: BurnsFile = structuredClone(prev);
  const limit = opts.pageLimit ?? PAGE_LIMIT;
  // Burn txs carry relayer light-client headers (~70 KB each): allow slow responses.
  const txDeps = { ...deps, timeoutMs: Math.max(deps.timeoutMs, 60_000) };

  if (file.cursor_height === null) {
    const start = await backfillStart(urls, deps, opts.backfillDays);
    file.cursor_height = start.height.toString();
    file.start_height = start.height.toString();
    file.tracking_since = start.time;
  }
  const cursor = BigInt(file.cursor_height);

  const collected: RecentBurn[] = [];
  let pages = 0;
  let complete = false;
  for (let page = 1; page <= opts.maxPages; page++) {
    const { value } = await lcdQuery<any>(urls, txsPath(cursor, page, limit), txDeps);
    pages++;
    const txs: any[] = value.body?.tx_responses ?? [];
    collected.push(...parseDepositForBurnTxs(value.body));
    if (txs.length < limit) {
      complete = true;
      break;
    }
  }

  // Ascending order: if we stopped early, the last height may be split across pages.
  // Drop it and let the next run fetch that height again.
  let counted = collected;
  if (!complete && collected.length) {
    const last = BigInt(collected.at(-1)!.height);
    const before = collected.filter((b) => BigInt(b.height) < last);
    if (before.length) counted = before; // else: one huge block; accept it to guarantee progress
  }
  counted.sort((a, b) => Number(BigInt(a.height) - BigInt(b.height)));

  addBurns(file, counted);
  if (counted.length) {
    const newest = counted.at(-1)!;
    file.cursor_height = newest.height;
    file.cursor_time = newest.time;
  }
  file.caught_up = complete;
  file.updated_at = (opts.now ?? new Date()).toISOString();
  return { file, added: counted.length, pages };
}
