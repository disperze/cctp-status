/**
 * One scheduled run (the GitHub Action calls this every 15 minutes):
 *   1. read every check on-chain, append a snapshot to <DATA_DIR>/snapshots.jsonl, send alerts on changes
 *   2. sync new Noble DepositForBurn txs into <DATA_DIR>/burns.json
 *   3. once per UTC day, record Noble USDC in the IBC escrow of each top chain (escrow.json)
 *   4. write latest.json + history.json for the static page
 *
 * Usage: npm run snapshot
 */
import "../src/env";
import { join } from "node:path";
import { createNotifier } from "../src/alerts";
import { emptyBurns, syncBurns, type BurnsFile } from "../src/burns";
import { loadConfig } from "../src/config";
import { emptyEscrow, fetchEscrow, needsDailySnapshot, recordDaily, type EscrowFile } from "../src/escrow";
import { errMsg } from "../src/failover";
import { publishData, readJsonFile } from "../src/publish";
import { StatusService } from "../src/service";
import { openStore } from "../src/storage";

const cfg = loadConfig();
const store = await openStore(cfg.dataPath);
const service = new StatusService(cfg, store, {
  notify: cfg.alertWebhookUrl || cfg.telegramBotToken ? createNotifier(cfg) : undefined,
});

const status = await service.snapshot();
const states = Object.fromEntries(Object.entries(status.routes).map(([k, v]) => [k, v.state]));
console.log(`[snapshot] ${status.generated_at} ${JSON.stringify(states)}`);

// Burns are best-effort: a failure here must not lose the status snapshot.
const burnsPath = join(cfg.dataDir, "burns.json");
let burns: BurnsFile = (await readJsonFile<BurnsFile>(burnsPath)) ?? emptyBurns();
try {
  const r = await syncBurns(burns, cfg.nobleLcdUrls, { timeoutMs: cfg.requestTimeoutMs, allowanceWarnRaw: 0n }, {
    backfillDays: cfg.burnsBackfillDays,
    maxPages: cfg.burnsMaxPages,
  });
  burns = r.file;
  console.log(`[burns] +${r.added} burns in ${r.pages} page(s); cursor ${burns.cursor_height}; caught_up=${burns.caught_up}`);
} catch (err) {
  console.error(`[burns] sync failed, keeping previous data: ${errMsg(err)}`);
}

// IBC escrow: one reading per UTC day, best-effort like burns.
const escrowPath = join(cfg.dataDir, "escrow.json");
let escrow: EscrowFile = (await readJsonFile<EscrowFile>(escrowPath)) ?? emptyEscrow();
if (needsDailySnapshot(escrow, new Date())) {
  try {
    const reading = await fetchEscrow(cfg.nobleLcdUrls, { timeoutMs: cfg.requestTimeoutMs });
    escrow = recordDaily(escrow, reading);
    console.log(`[escrow] daily reading at block ${reading.block ?? "?"} (${escrow.days.length} days)`);
  } catch (err) {
    console.error(`[escrow] read failed, will retry next run: ${errMsg(err)}`);
  }
} else {
  console.log("[escrow] today's reading already recorded");
}

const pub = await publishData(cfg, status, store, burns, new Date(), escrow.days.length ? escrow : null);
console.log(`[publish] ${cfg.dataDir}: latest.json, history.json (${pub.history_records} records), burns.json, escrow.json`);
store.close?.();
