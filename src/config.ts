/**
 * All constants and env-driven settings live here.
 *
 * Every hardcoded value below was verified on 2026-11-06 against the linked
 * source AND against mainnet (see `npm run verify`, scripts/verify-mainnet.ts).
 */
import type { Address } from "viem";
import { parseDecimalRatio } from "./units";

// ---------------------------------------------------------------------------
// CCTP domains — https://developers.circle.com/cctp/v1/supported-domains
// Confirmed on-chain: MessageTransmitter.localDomain() == 0 on Ethereum,
// GET /circle/cctp/v1/local_domain == {"domain_id":4} on Noble.
// ---------------------------------------------------------------------------
export const DOMAIN = {
  ETHEREUM: 0,
  NOBLE: 4,
} as const;

/** CCTP V1 domain IDs, for labelling burn destinations. Unknown IDs render as "Domain N". */
export const DOMAIN_NAMES: Record<number, string> = {
  0: "Ethereum",
  1: "Avalanche",
  2: "OP Mainnet",
  3: "Arbitrum",
  4: "Noble",
  5: "Solana",
  6: "Base",
  7: "Polygon PoS",
  8: "Sui",
  9: "Aptos",
  10: "Unichain",
};

export const domainName = (d: number) => DOMAIN_NAMES[d] ?? `Domain ${d}`;

// ---------------------------------------------------------------------------
// Ethereum mainnet CCTP V1 — https://developers.circle.com/cctp/v1/evm-smart-contracts
// Cross-checked on-chain: TokenMessenger.localMinter() == TokenMinter,
// TokenMessenger.localMessageTransmitter() == MessageTransmitter,
// TokenMinter.localTokenMessenger() == TokenMessenger.
// ---------------------------------------------------------------------------
export const ETH = {
  chainId: 1,
  tokenMessenger: "0xBd3fa81B58Ba92a82136038B25aDec7066af3155" as Address,
  messageTransmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81" as Address,
  tokenMinter: "0xc4922d64a24675E16e1586e3e3Aa56C06fABe907" as Address,
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address,
  explorer: "https://etherscan.io",
} as const;

// ---------------------------------------------------------------------------
// Noble — paths taken from the google.api.http annotations in:
//   https://github.com/circlefin/noble-cctp/blob/master/proto/circle/cctp/v1/query.proto
//   https://github.com/circlefin/noble-fiattokenfactory/blob/master/proto/circle/fiattokenfactory/v1/query.proto
// ---------------------------------------------------------------------------
export const NOBLE = {
  denom: "uusdc",
  cctpModuleName: "cctp",
  explorerTx: "https://www.mintscan.io/noble/tx/",
  paths: {
    perMessageBurnLimits: "/circle/cctp/v1/per_message_burn_limits",
    burningAndMintingPaused: "/circle/cctp/v1/burning_and_minting_paused",
    sendingAndReceivingPaused: "/circle/cctp/v1/sending_and_receiving_messages_paused",
    remoteTokenMessengers: "/circle/cctp/v1/remote_token_messengers",
    localDomain: "/circle/cctp/v1/local_domain",
    fiatPaused: "/noble/fiattokenfactory/paused",
    fiatMinter: (address: string) => `/noble/fiattokenfactory/minters/${encodeURIComponent(address)}`,
    moduleAccount: (name: string) => `/cosmos/auth/v1beta1/module_accounts/${encodeURIComponent(name)}`,
    txs: "/cosmos/tx/v1beta1/txs",
    latestBlock: "/cosmos/base/tendermint/v1beta1/blocks/latest",
    block: (height: bigint | string) => `/cosmos/base/tendermint/v1beta1/blocks/${height}`,
  },
  /** Typed event emitted by noble-cctp on burn: proto/circle/cctp/v1/events.proto `message DepositForBurn` */
  depositForBurnEvent: "circle.cctp.v1.DepositForBurn",
} as const;

// ---------------------------------------------------------------------------
// Osmosis allUSDC alloyed-asset transmuter, pool 3497 (CosmWasm transmuter v3).
// It swaps its member USDC variants 1:1 (every normalization_factor is 1), so a
// swap out of member X can never exceed the pool's balance of X.
// Verified on 2026-11-06 (`npm run verify`):
//   GET /osmosis/poolmanager/v1beta1/pools/3497 -> contract_address, alloyed_asset_subdenom "allUSDC"
//   GET /ibc/apps/transfer/v1/denom_traces/{hash} -> the paths below
//   Skip Go routes noble-1 uusdc -> injective-1 USDC through this pool.
// ---------------------------------------------------------------------------
export const OSMOSIS = {
  poolId: 3497,
  contract: "osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0",
  alloyedDenom: "factory/osmo147h5x9pcj7lm0cttlaefx6sqq5vdfnmwfcqxkmjd7exqm9gc7grqhr75m0/alloyed/allUSDC",
  /** USDC.n: Noble uusdc on Osmosis, transfer/channel-750. */
  usdcNoble: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4",
  /** USDC.inj: Circle-native USDC on Injective (erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a), transfer/channel-122. */
  usdcInjective: "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138",
  injectiveUsdc: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
  traces: {
    "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4": { path: "transfer/channel-750", base_denom: "uusdc" },
    "ibc/794C7D7F3B857713878A3A1927251FA6AC1EEE520424C1F6FAFE9BA26D476138": {
      path: "transfer/channel-122",
      base_denom: "erc20:0xa00C59fF5a080D2b954d0c75e46E22a0c371235a",
    },
  } as Record<string, { path: string; base_denom: string }>,
  poolUrl: "https://app.osmosis.zone/pool/3497",
  skipUrl: "https://go.skip.build",
} as const;

export const USDC_DECIMALS = 6;

export const RETIREMENT_DATES = [
  { id: "burn-limits-decrease", date: "2026-10-31T00:00:00Z", label: "V1 burn limits start decreasing" },
  { id: "v1-paused", date: "2026-12-01T00:00:00Z", label: "V1 contracts paused network-wide" },
  { id: "noble-paused", date: "2027-01-12T00:00:00Z", label: "Noble USDC and all Noble CCTP routes fully paused" },
  { id: "manual-redemption", date: "2027-01-13T00:00:00Z", label: "Circle manual redemption opens" },
] as const;

// ---------------------------------------------------------------------------
// Env-driven runtime settings
// ---------------------------------------------------------------------------
const DEFAULT_ETH_RPC_URLS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://1rpc.io/eth"];
const DEFAULT_NOBLE_LCD_URLS = ["https://noble-api.polkachu.com", "https://api.noble.xyz", "https://rest.cosmos.directory/noble"];
// lcd.osmosis.zone is not listed: it answers 403 to CosmWasm smart queries.
const DEFAULT_OSMOSIS_LCD_URLS = ["https://osmosis-api.polkachu.com", "https://osmosis-rest.publicnode.com", "https://rest.cosmos.directory/osmosis"];

function list(v: string | undefined, fallback: string[]): string[] {
  const out = (v ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return out.length ? out : fallback;
}

function num(v: string | undefined, fallback: number, name: string): number {
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`Invalid ${name}: ${v}`);
  return n;
}

export interface AppConfig {
  ethRpcUrls: string[];
  nobleLcdUrls: string[];
  /** Osmosis LCDs for the allUSDC pool liquidity read (must allow CosmWasm smart queries). */
  osmosisLcdUrls: string[];
  /** History snapshot interval. */
  snapshotIntervalMin: number;
  /** /api/status cache TTL; also the "poll interval" used for staleness (stale = 2x this). */
  statusCacheSec: number;
  /** safe_chunk = limit * margin. Kept as an exact ratio so there is no float math. */
  safetyMargin: { num: bigint; den: bigint; text: string };
  /** Destination allowance below this (base units) marks the route DEGRADED. */
  allowanceWarnRaw: bigint;
  /** Per-message limit below the max seen in this window marks the route DEGRADED. */
  trendWindowHours: number;
  requestTimeoutMs: number;
  /** Directory for the published JSON files (latest.json, history.json, burns.json). */
  dataDir: string;
  /** Snapshot store; defaults to <dataDir>/snapshots.jsonl. */
  dataPath: string;
  /** Days of history included in the published history.json. */
  historyPublishDays: number;
  /** On first run, how far back to backfill burns. */
  burnsBackfillDays: number;
  /** Max tx pages (50 txs each) fetched per run; a backfill catches up over several runs. */
  burnsMaxPages: number;
  port: number;
  alertWebhookUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
}

export function loadConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const marginText = env.SAFETY_MARGIN?.trim() || "0.998";
  const margin = parseDecimalRatio(marginText);
  if (margin.num <= 0n || margin.num > margin.den) {
    throw new Error(`SAFETY_MARGIN must be in (0, 1], got ${marginText}`);
  }
  const allowanceWarnUsdc = BigInt(env.ALLOWANCE_WARN_USDC?.trim() || "5000000");
  return {
    ethRpcUrls: list(env.ETH_RPC_URLS, DEFAULT_ETH_RPC_URLS),
    nobleLcdUrls: list(env.NOBLE_LCD_URLS, DEFAULT_NOBLE_LCD_URLS),
    osmosisLcdUrls: list(env.OSMOSIS_LCD_URLS, DEFAULT_OSMOSIS_LCD_URLS),
    snapshotIntervalMin: num(env.SNAPSHOT_INTERVAL_MIN, 15, "SNAPSHOT_INTERVAL_MIN"),
    statusCacheSec: num(env.STATUS_CACHE_SEC, 45, "STATUS_CACHE_SEC"),
    safetyMargin: { ...margin, text: marginText },
    allowanceWarnRaw: allowanceWarnUsdc * 10n ** BigInt(USDC_DECIMALS),
    trendWindowHours: num(env.TREND_WINDOW_HOURS, 24, "TREND_WINDOW_HOURS"),
    requestTimeoutMs: num(env.REQUEST_TIMEOUT_MS, 8000, "REQUEST_TIMEOUT_MS"),
    dataDir: (env.DATA_DIR?.trim() || "data").replace(/[\\/]+$/, ""),
    dataPath: env.DATA_PATH?.trim() || `${(env.DATA_DIR?.trim() || "data").replace(/[\\/]+$/, "")}/snapshots.jsonl`,
    historyPublishDays: num(env.HISTORY_PUBLISH_DAYS, 30, "HISTORY_PUBLISH_DAYS"),
    burnsBackfillDays: num(env.BURNS_BACKFILL_DAYS, 7, "BURNS_BACKFILL_DAYS"),
    burnsMaxPages: num(env.BURNS_MAX_PAGES, 20, "BURNS_MAX_PAGES"),
    port: num(env.PORT, 8787, "PORT"),
    alertWebhookUrl: env.ALERT_WEBHOOK_URL?.trim() || undefined,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
    telegramChatId: env.TELEGRAM_CHAT_ID?.trim() || undefined,
  };
}
