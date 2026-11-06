import "./env";
import { serve } from "@hono/node-server";
import { createNotifier } from "./alerts";
import { loadConfig } from "./config";
import { errMsg, redactUrl } from "./failover";
import { createApp } from "./server";
import { StatusService } from "./service";
import { openStore } from "./storage";

const cfg = loadConfig();
const store = await openStore(cfg.dataPath);
const service = new StatusService(cfg, store, {
  notify: cfg.alertWebhookUrl || cfg.telegramBotToken ? createNotifier(cfg) : undefined,
});

async function snapshot() {
  try {
    const s = await service.snapshot();
    const r = s.routes;
    console.log(`[snapshot] ${s.generated_at} noble→eth=${r["noble-eth"].state} eth→noble=${r["eth-noble"].state}`);
  } catch (err) {
    console.error(`[snapshot] failed: ${errMsg(err)}`);
  }
}

const app = createApp(service);
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(`CCTP V1 status API on http://localhost:${info.port}`);
  console.log(`  ETH RPCs:   ${cfg.ethRpcUrls.map(redactUrl).join(", ")}`);
  console.log(`  Noble LCDs: ${cfg.nobleLcdUrls.map(redactUrl).join(", ")}`);
  console.log(`  Snapshots every ${cfg.snapshotIntervalMin} min → ${cfg.dataPath}`);
});

// First snapshot right away (it also warms the /api/status cache), then on the interval.
void snapshot();
setInterval(snapshot, cfg.snapshotIntervalMin * 60_000);
