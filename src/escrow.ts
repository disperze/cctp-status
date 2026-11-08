/**
 * Noble USDC held in ICS-20 escrow accounts, one per counterparty chain.
 *
 * When Noble uusdc is IBC-transferred out on transfer/channel-N, ibc-go locks it
 * in the escrow account for that channel, so the escrow balance is how much
 * Noble USDC currently sits on (or is routed through) the counterparty chain.
 *
 * An ICS-20 channel and its escrow address never change, so both are fixed
 * below. They were taken from the Cosmos chain registry (_IBC/<a>-<b>.json) and
 * `npm run verify` re-checks them against the registry and Noble mainnet.
 * At runtime only the balances are read, from a Noble LCD. Browser-safe. Read-only.
 */
import { sha256 } from "viem";
import { NOBLE } from "./config";
import { redactUrl, withFailover } from "./failover";
import { lcdGet, type LcdDeps } from "./noble";
import { parseRaw } from "./units";

export const CHAIN_REGISTRY_IBC_URL = "https://raw.githubusercontent.com/cosmos/chain-registry/master/_IBC";
export const CHAIN_REGISTRY_REPO_URL = "https://github.com/cosmos/chain-registry/blob/master/_IBC";

export interface EscrowChainDef {
  /** chain_name in the Cosmos chain registry. */
  chain: string;
  label: string;
  /** Noble side of the transfer/transfer channel. */
  noble_channel: string;
  counterparty_channel: string;
  /** ibc-go GetEscrowAddress("transfer", noble_channel) on Noble. */
  escrow_address: string;
}

/**
 * The top Noble USDC counterparties, largest escrow first (as of 2026-11-07).
 * Channels from the chain registry (`preferred`, ACTIVE); escrow addresses checked
 * against GET /ibc/apps/transfer/v1/channels/{channel}/ports/transfer/escrow_address.
 */
export const ESCROW_CHAINS: readonly EscrowChainDef[] = [
  { chain: "dydx", label: "dYdX", noble_channel: "channel-33", counterparty_channel: "channel-0", escrow_address: "noble1ukv0qhw3zszzyjty32cck2j229ekpmr6g806yp" },
  { chain: "osmosis", label: "Osmosis", noble_channel: "channel-1", counterparty_channel: "channel-750", escrow_address: "noble1kq2rzz6fq2q7fsu75a9g7cpzjeanmk68qxshr6" },
  { chain: "neutron", label: "Neutron", noble_channel: "channel-18", counterparty_channel: "channel-30", escrow_address: "noble1gw2v3j8jxpmnq73rmu3vjz5egle5eep4xvvjtu" },
  { chain: "cosmoshub", label: "Cosmos Hub", noble_channel: "channel-4", counterparty_channel: "channel-536", escrow_address: "noble17sael2kcmm8npe2pmkxj3un90xfg60vvuk39mn" },
  { chain: "injective", label: "Injective", noble_channel: "channel-31", counterparty_channel: "channel-148", escrow_address: "noble1vn26uz7pxhz5aqd4s4q8kuar84ev9emhhgxuc2" },
  { chain: "terra2", label: "Terra", noble_channel: "channel-30", counterparty_channel: "channel-253", escrow_address: "noble12vssh8spx53qzg532xpj22sa7e85ts4x76e5rm" },
];

/** Registry files are named after both chains, sorted: "dydx-noble.json", "noble-osmosis.json". */
export const ibcFileName = (chain: string) => [chain, "noble"].sort().join("-") + ".json";
export const registryUrl = (chain: string) => `${CHAIN_REGISTRY_REPO_URL}/${ibcFileName(chain)}`;

// ---------------------------------------------------------------- escrow address (ibc-go)

const BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i]!;
  }
  return chk;
}

/** Bech32 (BIP-173) encode of raw bytes. */
export function bech32Encode(hrp: string, bytes: Uint8Array): string {
  const words: number[] = [];
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      words.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) words.push((acc << (5 - bits)) & 31);
  const hrpExpand = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat(0, [...hrp].map((c) => c.charCodeAt(0) & 31));
  const mod = polymod([...hrpExpand, ...words, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = Array.from({ length: 6 }, (_, i) => (mod >>> (5 * (5 - i))) & 31);
  return hrp + "1" + [...words, ...checksum].map((w) => BECH32[w]).join("");
}

/**
 * ibc-go `types.GetEscrowAddress(portID, channelID)`:
 *   sha256("ics20-1" || 0x00 || "<port>/<channel>")[:20]
 */
export function escrowAddress(port: string, channel: string, hrp = "noble"): string {
  const pre = new TextEncoder().encode(`ics20-1\0${port}/${channel}`);
  return bech32Encode(hrp, sha256(pre, "bytes").slice(0, 20));
}

// ---------------------------------------------------------------- chain registry (verify script only)

/**
 * Pick the Noble <-> counterparty ICS-20 channel from a registry _IBC file:
 * transfer port on both ends, not closed, `preferred` first.
 */
export function parseRegistryChannel(body: any, chain: string): { port: string; noble_channel: string; counterparty_channel: string } {
  const c1 = body?.chain_1?.chain_name;
  const c2 = body?.chain_2?.chain_name;
  const nobleSide = c1 === "noble" && c2 === chain ? "chain_1" : c2 === "noble" && c1 === chain ? "chain_2" : null;
  if (!nobleSide) throw new Error(`Registry file is not noble <-> ${chain} (${c1} <-> ${c2})`);
  const otherSide = nobleSide === "chain_1" ? "chain_2" : "chain_1";
  if (!Array.isArray(body.channels)) throw new Error("Registry file has no channels[]");
  const usable = body.channels.filter((ch: any) => {
    const status = String(ch?.tags?.status ?? "").toLowerCase();
    return (
      ch?.[nobleSide]?.port_id === "transfer" &&
      ch?.[otherSide]?.port_id === "transfer" &&
      /^channel-\d+$/.test(ch?.[nobleSide]?.channel_id ?? "") &&
      !["killed", "closed", "inactive", "upcoming"].includes(status)
    );
  });
  const pick = usable.find((ch: any) => ch?.tags?.preferred === true) ?? usable[0];
  if (!pick) throw new Error(`No usable transfer channel between noble and ${chain}`);
  return { port: "transfer", noble_channel: pick[nobleSide].channel_id, counterparty_channel: String(pick[otherSide].channel_id) };
}

/** Read a pair's channel from the chain registry (used by `npm run verify` to re-check ESCROW_CHAINS). */
export async function fetchRegistryChannel(chain: string, deps: LcdDeps & { registryUrl?: string }) {
  const base = (deps.registryUrl ?? CHAIN_REGISTRY_IBC_URL).replace(/\/+$/, "");
  const f = deps.fetch ?? fetch;
  const res = await f(`${base}/${ibcFileName(chain)}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(deps.timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRegistryChannel(await res.json(), chain);
}

// ---------------------------------------------------------------- balances

export const escrowPaths = {
  balance: (address: string) => `/cosmos/bank/v1beta1/balances/${encodeURIComponent(address)}/by_denom?denom=${NOBLE.denom}`,
  totalEscrow: `/ibc/apps/transfer/v1/denoms/${NOBLE.denom}/total_escrow`,
  supply: `/cosmos/bank/v1beta1/supply/by_denom?denom=${NOBLE.denom}`,
};

export interface EscrowChainReading extends EscrowChainDef {
  /** The pair's file in the chain registry (a link for the UI; never fetched by the page). */
  registry_url: string;
  balance_raw: string;
  /** Link to verify the balance yourself. */
  source_url: string;
}

export interface EscrowReading {
  fetched_at: string;
  endpoint: string;
  block?: string;
  chains: EscrowChainReading[];
  /** Noble uusdc escrowed on every IBC channel (ibc-go total_escrow); null if the node does not serve it. */
  total_escrow_raw: string | null;
  /** Noble uusdc total supply; null if unavailable. */
  supply_raw: string | null;
}

const amountOf = (body: any, key: "balance" | "amount") => {
  const a = body?.[key];
  if (!a || typeof a !== "object") throw new Error(`Unexpected response: missing ${key}`);
  if (a.denom !== undefined && a.denom !== NOBLE.denom) throw new Error(`Unexpected denom ${a.denom}`);
  return parseRaw(a.amount ?? "0").toString();
};

/**
 * Read every escrow balance from ONE Noble endpoint so the numbers share a
 * block. Supply and total escrow are optional extras: a node without them
 * still answers.
 */
export async function fetchEscrow(
  nobleUrls: readonly string[],
  deps: LcdDeps & { now?: () => Date; chains?: readonly EscrowChainDef[] },
): Promise<EscrowReading> {
  const channels = deps.chains ?? ESCROW_CHAINS;
  const { value, endpoint } = await withFailover(nobleUrls, async (base) => {
    const [balances, extras] = await Promise.all([
      Promise.all(channels.map((c) => lcdGet<any>(base, escrowPaths.balance(c.escrow_address), deps))),
      Promise.allSettled([lcdGet<any>(base, escrowPaths.totalEscrow, deps), lcdGet<any>(base, escrowPaths.supply, deps)]),
    ]);
    const [total, supply] = extras.map((r) => (r.status === "fulfilled" ? r.value.body : null));
    return {
      raws: balances.map((b) => amountOf(b.body, "balance")),
      block: balances[0]?.height,
      total_escrow_raw: total ? amountOf(total, "amount") : null,
      supply_raw: supply ? amountOf(supply, "amount") : null,
    };
  });
  const pub = redactUrl(endpoint);
  return {
    fetched_at: (deps.now?.() ?? new Date()).toISOString(),
    endpoint: pub,
    block: value.block,
    chains: channels.map((c, i) => ({
      ...c,
      registry_url: registryUrl(c.chain),
      balance_raw: value.raws[i]!,
      source_url: pub + escrowPaths.balance(c.escrow_address),
    })),
    total_escrow_raw: value.total_escrow_raw,
    supply_raw: value.supply_raw,
  };
}

// ---------------------------------------------------------------- daily history (escrow.json)

export interface EscrowDay {
  /** UTC day, YYYY-MM-DD. */
  date: string;
  /** When the reading was taken. */
  ts: string;
  block?: string;
  /** chain_name -> uusdc in that chain's escrow. */
  balances: Record<string, string>;
  /** chain_name -> Noble channel the reading used (channels can change). */
  channels: Record<string, string>;
  total_escrow_raw: string | null;
  supply_raw: string | null;
}

export interface EscrowFile {
  version: 1;
  updated_at: string | null;
  /** One reading per UTC day, oldest first. */
  days: EscrowDay[];
}

export const ESCROW_HISTORY_DAYS = 400;

export const emptyEscrow = (): EscrowFile => ({ version: 1, updated_at: null, days: [] });

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** The scheduled job only needs a fresh reading once per UTC day. */
export function needsDailySnapshot(file: EscrowFile, now: Date, chains: readonly EscrowChainDef[] = ESCROW_CHAINS): boolean {
  const today = file.days.find((d) => d.date === utcDay(now));
  return !today || chains.some((c) => today.balances[c.chain] === undefined);
}

export function toEscrowDay(r: EscrowReading): EscrowDay {
  return {
    date: r.fetched_at.slice(0, 10),
    ts: r.fetched_at,
    block: r.block,
    balances: Object.fromEntries(r.chains.map((c) => [c.chain, c.balance_raw])),
    channels: Object.fromEntries(r.chains.map((c) => [c.chain, c.noble_channel])),
    total_escrow_raw: r.total_escrow_raw,
    supply_raw: r.supply_raw,
  };
}

/** Add (or complete) today's entry and trim to ESCROW_HISTORY_DAYS. Today's first complete reading is kept. */
export function recordDaily(file: EscrowFile, reading: EscrowReading, maxDays = ESCROW_HISTORY_DAYS): EscrowFile {
  const day = toEscrowDay(reading);
  const others = file.days.filter((d) => d.date !== day.date);
  const existing = file.days.find((d) => d.date === day.date);
  const keep = existing && Object.keys(existing.balances).length >= Object.keys(day.balances).length ? existing : day;
  const days = [...others, keep].sort((a, b) => a.date.localeCompare(b.date)).slice(-maxDays);
  return { version: 1, updated_at: reading.fetched_at, days };
}

export interface EscrowChange {
  /** Baseline reading used for the comparison. */
  since: string;
  previous_raw: string;
  delta_raw: string;
  /** Percent change with 2 decimals, e.g. "-1.25"; null when the baseline is 0. */
  delta_pct: string | null;
}

/**
 * Change of one chain's escrow vs the daily snapshot nearest to `now - hours`.
 * The baseline must be at least hours/2 old (so "24h" is never compared to a
 * reading from an hour ago) and use the same channel. Ties go to the older one.
 * Pass an array of chains for their sum.
 */
export function escrowChange(
  days: readonly EscrowDay[],
  current: { raw: bigint; channel?: string },
  chain: string | readonly string[],
  hours: number,
  now: Date,
): EscrowChange | null {
  const target = now.getTime() - hours * 3600_000;
  const maxTs = now.getTime() - (hours * 3600_000) / 2;
  const keys = typeof chain === "string" ? [chain] : chain;
  let best: { day: EscrowDay; dist: number } | null = null;
  for (const d of days) {
    const t = Date.parse(d.ts);
    if (t > maxTs) continue;
    if (keys.some((k) => d.balances[k] === undefined)) continue;
    if (typeof chain === "string" && current.channel && d.channels[chain] && d.channels[chain] !== current.channel) continue;
    const dist = Math.abs(t - target);
    if (!best || dist < best.dist || (dist === best.dist && t < Date.parse(best.day.ts))) best = { day: d, dist };
  }
  if (!best) return null;
  const prev = keys.reduce((s, k) => s + BigInt(best!.day.balances[k]!), 0n);
  const delta = current.raw - prev;
  return {
    since: best.day.ts,
    previous_raw: prev.toString(),
    delta_raw: delta.toString(),
    delta_pct: prev === 0n ? null : pct(delta, prev),
  };
}

/** a / b as a percent string with 2 decimals, exact bigint math (rounded half away from zero). */
export function pct(a: bigint, b: bigint): string {
  const neg = (a < 0n) !== (b < 0n) && a !== 0n;
  const abs = (x: bigint) => (x < 0n ? -x : x);
  const scaled = (abs(a) * 20000n) / abs(b); // basis points * 2
  const bp = (scaled + 1n) / 2n;
  const s = `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}`;
  return neg && bp !== 0n ? "-" + s : s;
}
