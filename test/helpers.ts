import { decodeFunctionData, encodeFunctionResult, multicall3Abi, type Abi } from "viem";
import { fiatTokenAbi, messageTransmitterAbi, tokenMessengerAbi, tokenMinterAbi } from "../src/abis";
import { ETH } from "../src/config";
import type { AppConfig } from "../src/config";
import { loadConfig } from "../src/config";
import type { CheckId, CheckResult, CheckStatus } from "../src/types";

export const NOW = new Date("2026-11-06T12:00:00Z");

export function testConfig(over: Partial<AppConfig> = {}): AppConfig {
  return {
    ...loadConfig({ ETH_RPC_URLS: "https://rpc-a.test,https://rpc-b.test", NOBLE_LCD_URLS: "https://lcd-a.test,https://lcd-b.test" }),
    ...over,
  };
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

// ------------------------------------------------------------------ Noble LCD mock

export interface LcdState {
  burnLimit?: string | null; // null => no uusdc entry
  burningPaused?: boolean;
  sendingPaused?: boolean;
  fiatPaused?: boolean;
  remoteEth?: string | null; // base64 address, null => none
  moduleAddress?: string;
  allowance?: string | null; // null => NotFound
}

export const MODULE_ADDR = "noble12l2w4ugfz4m6dd73yysz477jszqnfughxvkss5";
export const ETH_TM_B64 = Buffer.from(ETH.tokenMessenger.slice(2).padStart(64, "0"), "hex").toString("base64");

export function lcdHandler(s: LcdState = {}) {
  const st = {
    burnLimit: "500000000000",
    burningPaused: false,
    sendingPaused: false,
    fiatPaused: false,
    remoteEth: ETH_TM_B64,
    moduleAddress: MODULE_ADDR,
    allowance: "88388165260063",
    ...s,
  };
  return (path: string): Response => {
    const p = path.split("?")[0]!;
    switch (p) {
      case "/circle/cctp/v1/per_message_burn_limits":
        return jsonResponse({
          burn_limits: st.burnLimit === null ? [] : [{ amount: st.burnLimit, denom: "uusdc" }],
          pagination: { next_key: null, total: "1" },
        });
      case "/circle/cctp/v1/burning_and_minting_paused":
        return jsonResponse({ paused: { paused: st.burningPaused } });
      case "/circle/cctp/v1/sending_and_receiving_messages_paused":
        return jsonResponse({ paused: { paused: st.sendingPaused } });
      case "/noble/fiattokenfactory/paused":
        return jsonResponse({ paused: { paused: st.fiatPaused } });
      case "/circle/cctp/v1/remote_token_messengers":
        return jsonResponse({ remote_token_messengers: st.remoteEth === null ? [] : [{ domain_id: 0, address: st.remoteEth }] });
      case "/cosmos/auth/v1beta1/module_accounts/cctp":
        return jsonResponse({ account: { "@type": "/cosmos.auth.v1beta1.ModuleAccount", base_account: { address: st.moduleAddress }, name: "cctp" } });
      case `/noble/fiattokenfactory/minters/${st.moduleAddress}`:
        if (st.allowance === null) return jsonResponse({ code: 5, message: "not found", details: [] }, 404);
        return jsonResponse({ minters: { address: st.moduleAddress, allowance: { denom: "uusdc", amount: st.allowance } } });
      default:
        return jsonResponse({ code: 12, message: "Not Implemented" }, 501);
    }
  };
}

/** fetch mock routing by base URL. `bases` maps base URL -> handler | "down" | "garbage" | "500". */
export function mockFetch(bases: Record<string, ((path: string) => Response) | "down" | "garbage" | "500">) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const base = Object.keys(bases).find((b) => url.startsWith(b));
    const h = base ? bases[base] : undefined;
    if (!h || h === "down") throw new TypeError("fetch failed: ECONNREFUSED");
    if (h === "garbage") return new Response("<html>bad gateway</html>", { status: 200 });
    if (h === "500") return new Response("Internal Server Error", { status: 500 });
    return h(url.slice(base!.length));
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

// ------------------------------------------------------------------ Ethereum JSON-RPC mock

export interface EthState {
  minterAllowance?: bigint;
  isMinter?: boolean;
  mtPaused?: boolean;
  tmPaused?: boolean;
  remoteNoble?: `0x${string}`;
  usdcPaused?: boolean;
  burnLimit?: bigint;
  revert?: Partial<Record<"minterAllowance" | "burnLimitsPerMessage", boolean>>;
}

const ABIS: { address: string; abi: Abi }[] = [
  { address: ETH.usdc, abi: fiatTokenAbi as unknown as Abi },
  { address: ETH.messageTransmitter, abi: messageTransmitterAbi as unknown as Abi },
  { address: ETH.tokenMinter, abi: tokenMinterAbi as unknown as Abi },
  { address: ETH.tokenMessenger, abi: tokenMessengerAbi as unknown as Abi },
];

export function ethHandler(s: EthState = {}) {
  const st = {
    minterAllowance: 75000000000000n,
    isMinter: true,
    mtPaused: false,
    tmPaused: false,
    remoteNoble: "0x00000000000000000000000057d4eaf1091577a6b7d121202afbd2808134f117" as `0x${string}`,
    usdcPaused: false,
    burnLimit: 500000000000n,
    revert: {},
    ...s,
  };
  function answer(target: string, data: `0x${string}`): { success: boolean; returnData: `0x${string}` } {
    const entry = ABIS.find((a) => a.address.toLowerCase() === target.toLowerCase());
    if (!entry) return { success: false, returnData: "0x" };
    const { functionName } = decodeFunctionData({ abi: entry.abi, data });
    if ((st.revert as any)[functionName]) return { success: false, returnData: "0x" };
    const key = `${entry.address}.${functionName}`;
    const values: Record<string, unknown> = {
      [`${ETH.usdc}.minterAllowance`]: st.minterAllowance,
      [`${ETH.usdc}.isMinter`]: st.isMinter,
      [`${ETH.usdc}.paused`]: st.usdcPaused,
      [`${ETH.messageTransmitter}.paused`]: st.mtPaused,
      [`${ETH.tokenMinter}.paused`]: st.tmPaused,
      [`${ETH.tokenMinter}.burnLimitsPerMessage`]: st.burnLimit,
      [`${ETH.tokenMessenger}.remoteTokenMessengers`]: st.remoteNoble,
    };
    if (!(key in values)) return { success: false, returnData: "0x" };
    return { success: true, returnData: encodeFunctionResult({ abi: entry.abi, functionName, result: values[key] } as any) };
  }
  return (body: any) => {
    const one = (req: any) => {
      if (req.method === "eth_blockNumber") return { jsonrpc: "2.0", id: req.id, result: "0x1922f4a" };
      if (req.method === "eth_chainId") return { jsonrpc: "2.0", id: req.id, result: "0x1" };
      if (req.method === "eth_call") {
        const { data } = req.params[0];
        const decoded = decodeFunctionData({ abi: multicall3Abi, data });
        const calls = decoded.args![0] as readonly { target: string; callData: `0x${string}` }[];
        const results = calls.map((c) => answer(c.target, c.callData));
        return { jsonrpc: "2.0", id: req.id, result: encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3", result: results }) };
      }
      return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: "method not found" } };
    };
    return Array.isArray(body) ? body.map(one) : one(body);
  };
}

export function mockRpc(bases: Record<string, ReturnType<typeof ethHandler> | "down" | "500">) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/\/+$/, "");
    calls.push(url);
    const h = bases[url];
    if (!h || h === "down") throw new TypeError("fetch failed");
    if (h === "500") return new Response("upstream error", { status: 500 });
    const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : "{}")));
    return jsonResponse(h(body));
  }) as typeof fetch;
  return Object.assign(f, { calls });
}

// ------------------------------------------------------------------ check fixtures

export function check(id: CheckId, status: CheckStatus = "ok", raw: string | null = "false", over: Partial<CheckResult> = {}): CheckResult {
  return {
    id,
    label: `Check ${id}`,
    raw,
    status,
    source: "test",
    source_url: "https://example.test",
    endpoint: "https://example.test",
    fetched_at: NOW.toISOString(),
    ...over,
  };
}

/** A fully healthy set of all 13 checks. */
export function healthyChecks(over: Partial<Record<CheckId, Partial<CheckResult>>> = {}): CheckResult[] {
  const base: CheckResult[] = [
    check("A1", "ok", "500000000000", { value_usdc: "500000" }),
    check("A2"),
    check("A3"),
    check("A4"),
    check("A5", "ok", "75000000000000", { value_usdc: "75000000" }),
    check("A6", "ok", "true"),
    check("A7"),
    check("A8"),
    check("A9", "ok", "0x" + "1".repeat(64)),
    check("A10"),
    check("A11", "ok", "0x" + "2".repeat(64)),
    check("B1", "ok", "500000000000", { value_usdc: "500000" }),
    check("B2", "ok", "88388165260063", { value_usdc: "88388165.260063" }),
  ];
  return base.map((c) => ({ ...c, ...(over[c.id] ?? {}) }));
}
