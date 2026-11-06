/**
 * Transfer-size calculator. Pure bigint math.
 *
 *   safe_chunk = floor(limit × margin)
 *   messages   = ceil(amount / safe_chunk)
 */
import { ROUTES } from "./aggregate";
import type { Direction, StatusSnapshot } from "./types";
import { ceilDiv, formatUsdc, toUsdcString } from "./units";

export interface Ratio {
  num: bigint;
  den: bigint;
}

export interface ChunkGroup {
  count: bigint;
  amount: bigint;
}

export interface TransferPlan {
  safeChunk: bigint;
  messages: bigint;
  chunks: ChunkGroup[];
}

export function safeChunk(limit: bigint, margin: Ratio): bigint {
  return (limit * margin.num) / margin.den;
}

export function planTransfer(amount: bigint, limit: bigint, margin: Ratio): TransferPlan {
  if (amount <= 0n) throw new Error("Amount must be greater than 0");
  const chunk = safeChunk(limit, margin);
  if (chunk <= 0n) throw new Error("Per-message limit is 0: no transfer possible");
  const full = amount / chunk;
  const rest = amount % chunk;
  const chunks: ChunkGroup[] = [];
  if (full > 0n) chunks.push({ count: full, amount: chunk });
  if (rest > 0n) chunks.push({ count: 1n, amount: rest });
  return { safeChunk: chunk, messages: ceilDiv(amount, chunk), chunks };
}

export interface CalcResponse {
  direction: Direction;
  route_label: string;
  route_state: string;
  amount_raw: string;
  amount_usdc: string;
  safety_margin: string;
  per_tx_limit_raw: string | null;
  per_tx_limit_usdc: string | null;
  safe_chunk_raw: string | null;
  safe_chunk_usdc: string | null;
  messages: string | null;
  chunks: { count: string; amount_raw: string; amount_usdc: string }[];
  destination_cap_raw: string | null;
  destination_cap_usdc: string | null;
  /** amount <= destination allowance (aggregate, shared with all users). null if unknown. */
  fits_destination_cap: boolean | null;
  warnings: string[];
  status_generated_at: string;
}

export function calculate(status: StatusSnapshot, direction: Direction, amount: bigint, margin: Ratio & { text: string }): CalcResponse {
  const route = status.routes[direction];
  const limit = route.max_per_tx_raw !== null ? BigInt(route.max_per_tx_raw) : null;
  const cap = route.destination_cap_raw !== null ? BigInt(route.destination_cap_raw) : null;
  const warnings: string[] = [
    "Limits can change between messages. Re-check the live limit before every burn.",
    "The destination allowance is shared by all users and is not reserved for you.",
  ];

  let plan: TransferPlan | null = null;
  if (limit === null) warnings.unshift("Per-message limit is unavailable right now, so no plan can be computed.");
  else {
    try {
      plan = planTransfer(amount, limit, margin);
    } catch (err) {
      warnings.unshift((err as Error).message);
    }
  }

  const fits = cap === null ? null : amount <= cap;
  if (fits === false) {
    warnings.unshift(
      `Amount exceeds the current destination minter allowance (${formatUsdc(cap!)} USDC). The mint would fail until Circle tops it up.`,
    );
  }
  if (route.state !== "OPEN") warnings.unshift(`Route is ${route.state}: ${route.reasons[0] ?? "see status"}`);

  return {
    direction,
    route_label: ROUTES[direction].label,
    route_state: route.state,
    amount_raw: amount.toString(),
    amount_usdc: toUsdcString(amount),
    safety_margin: margin.text,
    per_tx_limit_raw: limit?.toString() ?? null,
    per_tx_limit_usdc: limit !== null ? toUsdcString(limit) : null,
    safe_chunk_raw: plan?.safeChunk.toString() ?? null,
    safe_chunk_usdc: plan ? toUsdcString(plan.safeChunk) : null,
    messages: plan?.messages.toString() ?? null,
    chunks: (plan?.chunks ?? []).map((c) => ({
      count: c.count.toString(),
      amount_raw: c.amount.toString(),
      amount_usdc: toUsdcString(c.amount),
    })),
    destination_cap_raw: cap?.toString() ?? null,
    destination_cap_usdc: cap !== null ? toUsdcString(cap) : null,
    fits_destination_cap: fits,
    warnings,
    status_generated_at: status.generated_at,
  };
}
