/**
 * Noble checks via plain fetch against Cosmos LCD/REST endpoints.
 * Paths come from the query.proto HTTP annotations (see config.ts).
 */
import { allowanceFields } from "./allowance";
import { DOMAIN, ETH, NOBLE } from "./config";
import { errMsg, redactUrl, withFailover } from "./failover";
import type { CheckId, CheckResult, CheckStatus } from "./types";
import { parseRaw, toUsdcString } from "./units";

export interface NobleDeps {
  fetch?: typeof fetch;
  timeoutMs: number;
  /** Destination allowance below this is `warn`. */
  allowanceWarnRaw: bigint;
  now?: () => Date;
}

export class LcdHttpError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly grpcCode?: number,
  ) {
    super(message);
    this.name = "LcdHttpError";
  }
}

const GRPC_NOT_FOUND = 5;

interface LcdResponse<T> {
  body: T;
  height?: string;
}

async function lcdGet<T>(base: string, path: string, deps: NobleDeps): Promise<LcdResponse<T>> {
  const f = deps.fetch ?? fetch;
  const res = await f(base + path, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(deps.timeoutMs),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new LcdHttpError(`HTTP ${res.status}: non-JSON response`, res.status);
  }
  if (!res.ok) {
    const code = typeof (body as { code?: unknown })?.code === "number" ? (body as { code: number }).code : undefined;
    const msg = (body as { message?: string })?.message ?? text.slice(0, 120);
    throw new LcdHttpError(`HTTP ${res.status}: ${msg}`, res.status, code);
  }
  const height =
    res.headers.get("grpc-metadata-x-cosmos-block-height") ?? res.headers.get("x-cosmos-block-height") ?? undefined;
  return { body: body as T, height };
}

/**
 * GET with failover. When `notFoundIsAnswer` is set, a well-formed gRPC
 * NotFound (code 5) is treated as an authoritative "does not exist" answer
 * instead of an endpoint failure.
 */
export async function lcdQuery<T>(
  urls: readonly string[],
  path: string,
  deps: NobleDeps,
  opts: { notFoundIsAnswer?: boolean } = {},
): Promise<{ value: LcdResponse<T | null>; endpoint: string }> {
  return withFailover(urls, (base) => lcdGetOne<T>(base, path, deps, opts));
}

async function lcdGetOne<T>(base: string, path: string, deps: NobleDeps, opts: { notFoundIsAnswer?: boolean } = {}) {
  try {
    return await lcdGet<T>(base, path, deps);
  } catch (err) {
    if (opts.notFoundIsAnswer && err instanceof LcdHttpError && err.grpcCode === GRPC_NOT_FOUND) {
      return { body: null } as LcdResponse<T | null>;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------

type Draft = Pick<CheckResult, "id" | "label" | "source"> & { path: string };

function base(draft: Draft, now: Date) {
  return { id: draft.id, label: draft.label, source: draft.source, fetched_at: now.toISOString() };
}

function okResult(
  draft: Draft,
  endpoint: string,
  now: Date,
  fields: { raw: string | null; status: CheckStatus; value_usdc?: string; detail?: string; block?: string },
): CheckResult {
  const pub = redactUrl(endpoint);
  return { ...base(draft, now), ...fields, endpoint: pub, source_url: pub + draft.path };
}

function errorResult(draft: Draft, urls: readonly string[], now: Date, err: unknown): CheckResult {
  return {
    ...base(draft, now),
    raw: null,
    status: "error",
    endpoint: null,
    source_url: redactUrl(urls[0] ?? "") + draft.path,
    detail: errMsg(err),
  };
}

async function runCheck(
  draft: Draft,
  urls: readonly string[],
  deps: NobleDeps,
  evaluate: (body: any, endpoint: string, height?: string) => Parameters<typeof okResult>[3],
  opts?: { notFoundIsAnswer?: boolean; pathOverride?: string },
): Promise<CheckResult> {
  const now = () => (deps.now ? deps.now() : new Date());
  try {
    // Shape validation runs inside the failover loop, so an endpoint returning a
    // malformed body is treated like a failed endpoint and the next one is tried.
    const { value, endpoint } = await withFailover(urls, async (base) => {
      const res = await lcdGetOne<any>(base, opts?.pathOverride ?? draft.path, deps, opts);
      return { fields: evaluate(res.body, base, res.height), height: res.height };
    });
    return okResult(draft, endpoint, now(), { block: value.height, ...value.fields });
  } catch (err) {
    return errorResult(draft, urls, now(), err);
  }
}

function pausedFlag(body: any): boolean {
  // Response shape: {"paused":{"paused":false}}. proto3 JSON may omit a false bool.
  if (!body || typeof body.paused !== "object" || body.paused === null) {
    throw new Error(`Unexpected response shape: ${JSON.stringify(body).slice(0, 120)}`);
  }
  const v = body.paused.paused;
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new Error(`paused is not a boolean: ${JSON.stringify(v)}`);
  return v;
}

function pauseCheck(id: CheckId, label: string, path: string, source: string) {
  return (urls: readonly string[], deps: NobleDeps) =>
    runCheck({ id, label, path, source }, urls, deps, (body) => {
      const paused = pausedFlag(body);
      return { raw: String(paused), status: paused ? "blocked" : "ok", detail: paused ? "Paused on Noble" : undefined };
    });
}

/** A1 — Noble per-message burn limit for uusdc. */
export function checkBurnLimit(urls: readonly string[], deps: NobleDeps): Promise<CheckResult> {
  const path = `${NOBLE.paths.perMessageBurnLimits}?pagination.limit=1000`;
  return runCheck(
    { id: "A1", label: "Noble per-message burn limit (uusdc)", path, source: `Noble x/cctp PerMessageBurnLimits` },
    urls,
    deps,
    (body) => {
      if (!body || !Array.isArray(body.burn_limits)) throw new Error("Unexpected response: missing burn_limits[]");
      const entry = body.burn_limits.find((b: any) => b?.denom === NOBLE.denom);
      if (!entry) return { raw: null, status: "blocked", detail: `No burn limit set for ${NOBLE.denom}` };
      const raw = parseRaw(entry.amount);
      return {
        raw: raw.toString(),
        value_usdc: toUsdcString(raw),
        status: raw === 0n ? "blocked" : "ok",
        detail: raw === 0n ? "Burn limit is 0: burning uusdc is disabled" : undefined,
      };
    },
  );
}

export const checkBurningMintingPaused = pauseCheck(
  "A2",
  "Noble CCTP burning & minting paused",
  NOBLE.paths.burningAndMintingPaused,
  "Noble x/cctp BurningAndMintingPaused",
);

export const checkSendingReceivingPaused = pauseCheck(
  "A3",
  "Noble CCTP sending & receiving messages paused",
  NOBLE.paths.sendingAndReceivingPaused,
  "Noble x/cctp SendingAndReceivingMessagesPaused",
);

export const checkFiatTokenPaused = pauseCheck(
  "A4",
  "Noble USDC (fiattokenfactory) paused",
  NOBLE.paths.fiatPaused,
  "Noble x/fiattokenfactory Paused",
);

/** Ethereum TokenMessenger as a 32-byte, left-padded, lowercase hex string. */
export const ETH_TOKEN_MESSENGER_BYTES32 = "0x" + ETH.tokenMessenger.slice(2).toLowerCase().padStart(64, "0");

/** Browser-safe (no Buffer). */
export function base64ToHex(b64: string): string {
  const bin = atob(b64);
  let hex = "0x";
  for (let i = 0; i < bin.length; i++) hex += bin.charCodeAt(i).toString(16).padStart(2, "0");
  return hex;
}

/** A11 — Ethereum's TokenMessenger is registered as the remote for domain 0 on Noble. */
export function checkRemoteEthOnNoble(urls: readonly string[], deps: NobleDeps): Promise<CheckResult> {
  const path = `${NOBLE.paths.remoteTokenMessengers}?pagination.limit=1000`;
  return runCheck(
    {
      id: "A11",
      label: "Ethereum registered as remote on Noble (domain 0)",
      path,
      source: "Noble x/cctp RemoteTokenMessengers",
    },
    urls,
    deps,
    (body) => {
      if (!body || !Array.isArray(body.remote_token_messengers)) {
        throw new Error("Unexpected response: missing remote_token_messengers[]");
      }
      // proto3 JSON may omit domain_id when it is 0.
      const entry = body.remote_token_messengers.find((r: any) => Number(r?.domain_id ?? 0) === DOMAIN.ETHEREUM);
      if (!entry?.address) return { raw: null, status: "blocked", detail: "No remote token messenger for domain 0" };
      const hex = base64ToHex(entry.address);
      if (/^0x0*$/.test(hex)) return { raw: hex, status: "blocked", detail: "Remote token messenger is zero" };
      const matches = hex.toLowerCase() === ETH_TOKEN_MESSENGER_BYTES32;
      return {
        raw: hex,
        status: matches ? "ok" : "warn",
        detail: matches ? undefined : `Registered remote ${hex} differs from configured TokenMessenger ${ETH.tokenMessenger}`,
      };
    },
  );
}

// --- B2: Noble minter allowance for the CCTP module account ---------------

const moduleAddressCache = new Map<string, string>();

export async function getCctpModuleAddress(urls: readonly string[], deps: NobleDeps): Promise<string> {
  const key = urls.join(",");
  const cached = moduleAddressCache.get(key);
  if (cached) return cached;
  const { value } = await lcdQuery<any>(urls, NOBLE.paths.moduleAccount(NOBLE.cctpModuleName), deps);
  const addr: unknown = value.body?.account?.base_account?.address ?? value.body?.account?.address;
  if (typeof addr !== "string" || !addr.startsWith("noble1")) {
    throw new Error("Could not read cctp module account address");
  }
  moduleAddressCache.set(key, addr);
  return addr;
}

export function _clearModuleAddressCache() {
  moduleAddressCache.clear();
}

export async function checkNobleMinterAllowance(urls: readonly string[], deps: NobleDeps): Promise<CheckResult> {
  const draftBase = {
    id: "B2" as const,
    label: "Noble minter allowance for CCTP module",
    source: "Noble x/fiattokenfactory Minters(cctp module account)",
  };
  let address: string;
  try {
    address = await getCctpModuleAddress(urls, deps);
  } catch (err) {
    return errorResult({ ...draftBase, path: NOBLE.paths.moduleAccount(NOBLE.cctpModuleName) }, urls, deps.now?.() ?? new Date(), err);
  }
  const path = NOBLE.paths.fiatMinter(address);
  return runCheck(
    { ...draftBase, path, source: `Noble x/fiattokenfactory Minters(${address})` },
    urls,
    deps,
    (body) => {
      if (body === null) return { raw: "0", value_usdc: "0", status: "blocked", detail: "CCTP module is not a minter" };
      const allowance = body?.minters?.allowance;
      if (!allowance) throw new Error("Unexpected response: missing minters.allowance");
      if (allowance.denom !== NOBLE.denom) throw new Error(`Unexpected allowance denom ${allowance.denom}`);
      const raw = parseRaw(allowance.amount);
      return allowanceFields(raw, deps.allowanceWarnRaw);
    },
    { notFoundIsAnswer: true },
  );
}

// --- C: recent DepositForBurn activity ------------------------------------

export interface RecentBurn {
  txhash: string;
  height: string;
  time: string;
  nonce: string | null;
  amount_raw: string;
  amount_usdc: string;
  depositor: string | null;
  destination_domain: number;
  mint_recipient: string | null;
  explorer_url: string;
}

function attrValue(v: unknown): string {
  if (typeof v !== "string") return "";
  try {
    const parsed = JSON.parse(v);
    return typeof parsed === "string" || typeof parsed === "number" ? String(parsed) : v;
  } catch {
    return v;
  }
}

/**
 * Extract DepositForBurn events from a /cosmos/tx/v1beta1/txs response.
 * Pass `destinationDomain` to keep one destination only; omit it for all.
 * Failed txs (code != 0) are skipped.
 */
export function parseDepositForBurnTxs(body: any, destinationDomain?: number): RecentBurn[] {
  const out: RecentBurn[] = [];
  for (const tx of body?.tx_responses ?? []) {
    if (tx.code !== undefined && Number(tx.code) !== 0) continue;
    for (const ev of tx.events ?? []) {
      if (ev.type !== NOBLE.depositForBurnEvent) continue;
      const a: Record<string, string> = {};
      for (const attr of ev.attributes ?? []) a[attr.key] = attrValue(attr.value);
      const domain = Number(a.destination_domain);
      if (!Number.isInteger(domain)) continue;
      if (destinationDomain !== undefined && domain !== destinationDomain) continue;
      if (!a.amount || !/^\d+$/.test(a.amount)) continue;
      const amount = BigInt(a.amount);
      let recipient: string | null = null;
      if (a.mint_recipient) {
        const hex = base64ToHex(a.mint_recipient);
        // EVM recipients are left-padded 20-byte addresses; others (Solana, Sui, Aptos) use all 32 bytes.
        recipient = /^0x0{24}/.test(hex) ? "0x" + hex.slice(-40) : hex;
      }
      out.push({
        txhash: tx.txhash,
        height: tx.height,
        time: tx.timestamp,
        nonce: a.nonce ?? null,
        amount_raw: amount.toString(),
        amount_usdc: toUsdcString(amount),
        depositor: a.depositor ?? null,
        destination_domain: domain,
        mint_recipient: recipient,
        explorer_url: NOBLE.explorerTx + tx.txhash,
      });
    }
  }
  return out;
}

export async function fetchRecentBurns(urls: readonly string[], deps: NobleDeps, limit = 10) {
  const q = encodeURIComponent(`${NOBLE.depositForBurnEvent}.destination_domain=${DOMAIN.ETHEREUM}`);
  // SDK 0.50 uses `query` + `limit`; `pagination.limit` kept for older nodes.
  const path = `${NOBLE.paths.txs}?query=${q}&order_by=ORDER_BY_DESC&limit=${limit}&pagination.limit=${limit}`;
  const { value, endpoint } = await lcdQuery<any>(urls, path, { ...deps, timeoutMs: Math.max(deps.timeoutMs, 20000) });
  return {
    fetched_at: new Date().toISOString(),
    endpoint: redactUrl(endpoint),
    source_url: redactUrl(endpoint) + path,
    note: "Context only: recent burns succeeding does not guarantee your transfer fits the current limits.",
    items: parseDepositForBurnTxs(value.body, DOMAIN.ETHEREUM).slice(0, limit),
  };
}

/** All Noble-side checks, run in parallel. */
export async function fetchNobleChecks(urls: readonly string[], deps: NobleDeps): Promise<CheckResult[]> {
  return Promise.all([
    checkBurnLimit(urls, deps),
    checkBurningMintingPaused(urls, deps),
    checkSendingReceivingPaused(urls, deps),
    checkFiatTokenPaused(urls, deps),
    checkRemoteEthOnNoble(urls, deps),
    checkNobleMinterAllowance(urls, deps),
  ]);
}
