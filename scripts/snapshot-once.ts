/**
 * One scheduled run (the GitHub Action calls this every 15 minutes):
 *   1. read every check on-chain, append a snapshot to <DATA_DIR>/snapshots.jsonl, send alerts on changes
 *   2. sync new Noble DepositForBurn txs into <DATA_DIR>/burns.json
 *   3. write latest.json + history.json for the static page
 *
 * Usage: npm run snapshot
 */
import "../src/env";
import { join } from "node:path";
import { createNotifier } from "../src/alerts";
import { emptyBurns, syncBurns, type BurnsFile } from "../src/burns";
import { loadConfig } from "../src/config";
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

const pub = await publishData(cfg, status, store, burns);
console.log(`[publish] ${cfg.dataDir}: latest.json, history.json (${pub.history_records} records), burns.json`);
store.close?.();
