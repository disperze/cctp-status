/**
 * Route options for the transfer calculator. Pure bigint math, no I/O.
 *
 * Goal: get out of Noble USDC before Circle deprecates it, into Circle-native
 * USDC: USDC.inj on Injective or USDC on Ethereum. So for Noble → out:
 *
 *   1. Osmosis allUSDC pool 3497 (via Skip Go) → USDC.inj: preferred whenever
 *      the pool holds enough USDC.inj.
 *        usable = floor(pool_balance(USDC.inj) × margin)
 *        fits   = amount <= usable
 *   2. CCTP V1 direct → Ethereum USDC: the chunked plan (see calc.ts).
 *      Recommended when the pool can't take the whole amount, or can't be read.
 *
 * Ethereum → Noble moves funds *into* Noble USDC, so it has no Osmosis option:
 * only CCTP applies there.
 *
 * Liquidity check only: no Skip Go quote is requested. Other users' swaps move
 * the pool balance at any time, exactly like the CCTP allowance.
 */
import { calculate, safeChunk, type CalcResponse, type Ratio } from "./calc";
import { OSMOSIS } from "./config";
import type { AlloyedPoolState } from "./osmosis";
import type { Direction, StatusSnapshot } from "./types";
import { formatUsdc, toUsdcString } from "./units";

export type RouteOptionId = "osmosis" | "cctp";

/** ok: enough liquidity · insufficient: pool too small · unavailable: pool inactive or member corrupted · unknown: no fresh read. */
export type OsmosisStatus = "ok" | "insufficient" | "unavailable" | "unknown";

export interface OsmosisOption {
  id: "osmosis";
  label: string;
  status: OsmosisStatus;
  /** Why the status is what it is, one line. */
  status_detail: string;
  asset_in: { symbol: string; denom: string };
  asset_out: { symbol: string; denom: string };
  /** Pool balance of asset_out: the most a single swap can take out. */
  available_raw: string | null;
  available_usdc: string | null;
  /** floor(available × margin). */
  usable_raw: string | null;
  usable_usdc: string | null;
  fits: boolean | null;
  steps: string[];
  notes: string[];
  fetched_at: string | null;
  source_url: string | null;
  endpoint: string | null;
  block?: string;
  stale: boolean;
}

export interface RoutePlan {
  direction: Direction;
  amount_raw: string;
  amount_usdc: string;
  recommended: RouteOptionId;
  recommended_reason: string;
  /** null for Ethereum → Noble: that moves funds into Noble USDC, so only CCTP applies. */
  osmosis: OsmosisOption | null;
  cctp: CalcResponse;
}

const USDC_N = { symbol: "USDC.n", denom: OSMOSIS.usdcNoble };
const USDC_INJ = { symbol: "USDC.inj", denom: OSMOSIS.usdcInjective };

/** The exit leg: Noble USDC → Circle-native USDC on Injective. */
export const OSMOSIS_EXIT = {
  in: USDC_N,
  out: USDC_INJ,
  steps: [
    "IBC transfer USDC from Noble to Osmosis (arrives as USDC.n)",
    `Swap USDC.n → USDC.inj 1:1 in the allUSDC pool ${OSMOSIS.poolId}`,
    "IBC transfer USDC.inj from Osmosis to Injective",
  ],
  notes: [
    "Skip Go runs these three steps as one transaction, without using Noble CCTP V1 or its limits.",
    "You end with USDC.inj: Circle-native USDC on Injective, not Noble USDC.",
  ],
} as const;

/** Deep link into Skip Go with the exit prefilled: Noble USDC → Injective USDC. */
export function skipGoUrl(amount: bigint): string {
  const q = new URLSearchParams({
    src_chain: "noble-1",
    src_asset: "uusdc",
    dest_chain: "injective-1",
    dest_asset: OSMOSIS.injectiveUsdc,
    amount_in: toUsdcString(amount),
  });
  return `${OSMOSIS.skipUrl}/?${q}`;
}

export function osmosisOption(
  amount: bigint,
  margin: Ratio,
  pool: AlloyedPoolState | null,
  opts: { now: Date; staleAfterMs: number; error?: string },
): OsmosisOption {
  const leg = OSMOSIS_EXIT;
  const base = {
    id: "osmosis" as const,
    label: `Noble → USDC.inj via Osmosis pool ${OSMOSIS.poolId} (Skip Go)`,
    asset_in: leg.in,
    asset_out: leg.out,
    steps: [...leg.steps],
    notes: [...leg.notes] as string[],
  };
  if (!pool) {
    return {
      ...base, status: "unknown", status_detail: `Pool liquidity could not be read${opts.error ? ` (${opts.error})` : ""}.`,
      available_raw: null, available_usdc: null, usable_raw: null, usable_usdc: null, fits: null,
      fetched_at: null, source_url: null, endpoint: null, stale: false,
    };
  }
  const availableStr = pool.liquidity_raw[leg.out.denom];
  const available = availableStr !== undefined ? BigInt(availableStr) : 0n;
  const usable = safeChunk(available, margin);
  const stale = opts.now.getTime() - Date.parse(pool.fetched_at) > opts.staleAfterMs;
  const read = {
    available_raw: available.toString(),
    available_usdc: toUsdcString(available),
    usable_raw: usable.toString(),
    usable_usdc: toUsdcString(usable),
    fetched_at: pool.fetched_at,
    source_url: pool.source_url,
    endpoint: pool.endpoint,
    block: pool.block,
    stale,
  };
  const fits = amount <= usable;

  let status: OsmosisStatus;
  let detail: string;
  if (!pool.active) [status, detail] = ["unavailable", "The pool is inactive: swaps are disabled."];
  else if (pool.corrupted_denoms.includes(leg.in.denom)) [status, detail] = ["unavailable", `${leg.in.symbol} is marked corrupted in the pool and can't be swapped in.`];
  else if (stale) [status, detail] = ["unknown", "The pool reading is stale: waiting for a fresh read."];
  else if (fits) [status, detail] = ["ok", `Enough liquidity: ${formatUsdc(usable)} ${leg.out.symbol} usable, you need ${formatUsdc(amount)}.`];
  else {
    [status, detail] = ["insufficient", `Not enough liquidity: ${formatUsdc(usable)} ${leg.out.symbol} usable, you need ${formatUsdc(amount)}.`];
    if (usable > 0n) base.notes.unshift(`Up to ${formatUsdc(usable)} USDC could still exit through the pool, and the rest through CCTP V1.`);
  }
  base.notes.push("Other users' swaps change the pool balance at any time. Re-check right before you swap.");
  return { ...base, ...read, status, status_detail: detail, fits: stale ? null : fits };
}

export function planRoutes(
  status: StatusSnapshot,
  direction: Direction,
  amount: bigint,
  margin: Ratio & { text: string },
  pool: AlloyedPoolState | null,
  opts: { now: Date; staleAfterMs: number; poolError?: string },
): RoutePlan {
  const cctp = calculate(status, direction, amount, margin);
  if (direction !== "noble-eth") {
    return {
      direction,
      amount_raw: amount.toString(),
      amount_usdc: toUsdcString(amount),
      recommended: "cctp",
      recommended_reason: "This moves USDC into Noble, so the Osmosis exit doesn't apply. Only CCTP is shown.",
      osmosis: null,
      cctp,
    };
  }
  const osmosis = osmosisOption(amount, margin, pool, { now: opts.now, staleAfterMs: opts.staleAfterMs, error: opts.poolError });
  const useOsmosis = osmosis.status === "ok";
  const why: Record<OsmosisStatus, string> = {
    ok: `Pool ${OSMOSIS.poolId} has enough USDC.inj for the whole amount, so you can exit Noble USDC without CCTP V1.`,
    insufficient: `Pool ${OSMOSIS.poolId} doesn't have enough USDC.inj, so use CCTP V1 to Ethereum.`,
    unavailable: `Pool ${OSMOSIS.poolId} can't be used right now, so use CCTP V1 to Ethereum.`,
    unknown: `Pool ${OSMOSIS.poolId} liquidity is unknown, so use CCTP V1 to Ethereum.`,
  };
  return {
    direction,
    amount_raw: amount.toString(),
    amount_usdc: toUsdcString(amount),
    recommended: useOsmosis ? "osmosis" : "cctp",
    recommended_reason: why[osmosis.status],
    osmosis,
    cctp,
  };
}
