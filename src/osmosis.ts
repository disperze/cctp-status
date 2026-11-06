/**
 * Osmosis allUSDC alloyed transmuter (pool 3497): live liquidity read.
 * Browser-safe (plain fetch + btoa). Read-only.
 *
 * All three smart queries are answered by the same endpoint, so balances,
 * `is_active` and corrupted denoms come from one consistent node.
 */
import { OSMOSIS } from "./config";
import { redactUrl, withFailover } from "./failover";
import { lcdGet, type LcdDeps } from "./noble";
import { parseRaw } from "./units";

export interface AlloyedPoolState {
  pool_id: number;
  contract: string;
  /** Transmuter `is_active`: false means swaps are disabled. */
  active: boolean;
  /** Corrupted members can only be swapped out (redeemed), never in. */
  corrupted_denoms: string[];
  /** Pool balance per member denom, base units. */
  liquidity_raw: Record<string, string>;
  endpoint: string;
  block?: string;
  fetched_at: string;
  /** Link to verify the balances yourself. */
  source_url: string;
}

const b64 = (s: string) => btoa(s); // query JSON is ASCII
export const smartQueryPath = (msg: object) =>
  `/cosmwasm/wasm/v1/contract/${OSMOSIS.contract}/smart/${b64(JSON.stringify(msg))}`;

const Q = {
  liquidity: smartQueryPath({ get_total_pool_liquidity: {} }),
  active: smartQueryPath({ is_active: {} }),
  corrupted: smartQueryPath({ get_corrupted_denoms: {} }),
};

export async function fetchAlloyedPool(urls: readonly string[], deps: LcdDeps & { now?: () => Date }): Promise<AlloyedPoolState> {
  const { value, endpoint } = await withFailover(urls, async (base) => {
    const [liq, act, cor] = await Promise.all([
      lcdGet<any>(base, Q.liquidity, deps),
      lcdGet<any>(base, Q.active, deps),
      lcdGet<any>(base, Q.corrupted, deps),
    ]);
    // Shape validation inside the failover loop: a malformed body moves on to the next endpoint.
    const list = liq.body?.data?.total_pool_liquidity;
    if (!Array.isArray(list)) throw new Error("Unexpected response: missing data.total_pool_liquidity[]");
    const liquidity_raw: Record<string, string> = {};
    for (const c of list) {
      if (typeof c?.denom !== "string") throw new Error("Unexpected liquidity entry");
      liquidity_raw[c.denom] = parseRaw(c.amount).toString();
    }
    const active = act.body?.data?.is_active;
    if (typeof active !== "boolean") throw new Error("Unexpected response: missing data.is_active");
    const corrupted = cor.body?.data?.corrupted_denoms;
    if (!Array.isArray(corrupted)) throw new Error("Unexpected response: missing data.corrupted_denoms[]");
    return { liquidity_raw, active, corrupted_denoms: corrupted.map(String), block: liq.height };
  });
  const pub = redactUrl(endpoint);
  return {
    pool_id: OSMOSIS.poolId,
    contract: OSMOSIS.contract,
    ...value,
    endpoint: pub,
    fetched_at: (deps.now?.() ?? new Date()).toISOString(),
    source_url: pub + Q.liquidity,
  };
}
