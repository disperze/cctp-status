import { Hono } from "hono";
import { errMsg } from "./failover";
import type { StatusService } from "./service";
import type { Direction } from "./types";
import { parseRaw, parseUsdc } from "./units";

const DIRECTIONS: Direction[] = ["noble-eth", "eth-noble"];

/** JSON with bigint safety (we only emit strings, but guard anyway). */
function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function createApp(service: StatusService) {
  const app = new Hono();
  const cacheSec = service.cfg.statusCacheSec;

  app.get("/api/status", async () => json(await service.getStatus(), 200, { "cache-control": `public, max-age=${Math.min(30, cacheSec)}` }));

  app.get("/api/history", async (c) => {
    const hours = Number(c.req.query("hours") ?? "72");
    if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 180) return json({ error: "hours must be in (0, 4320]" }, 400);
    return json(await service.history(hours));
  });

  app.get("/api/calc", async (c) => {
    const direction = (c.req.query("direction") ?? "noble-eth") as Direction;
    if (!DIRECTIONS.includes(direction)) return json({ error: `direction must be one of ${DIRECTIONS.join(", ")}` }, 400);
    let amount: bigint;
    try {
      const raw = c.req.query("amount_raw");
      const usdc = c.req.query("amount");
      if (raw !== undefined) amount = parseRaw(raw);
      else if (usdc !== undefined) amount = parseUsdc(usdc);
      else return json({ error: "Pass amount (USDC, e.g. 2000000 or 1500.25) or amount_raw (base units)" }, 400);
    } catch (err) {
      return json({ error: errMsg(err) }, 400);
    }
    if (amount <= 0n) return json({ error: "amount must be greater than 0" }, 400);
    return json(await service.calc(direction, amount));
  });

  app.get("/api/activity", async () => {
    try {
      return json(await service.recentActivity());
    } catch (err) {
      return json({ error: errMsg(err), items: [] }, 502);
    }
  });

  app.get("/healthz", () => json({ ok: true }));

  app.onError((err) => {
    console.error(err);
    return json({ error: "internal error" }, 500);
  });

  return app;
}
