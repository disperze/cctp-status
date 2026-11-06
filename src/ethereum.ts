/**
 * Ethereum checks A5–A10 and B1, read in a single multicall at one block.
 */
import { createPublicClient, http, type Address } from "viem";
import { mainnet } from "viem/chains";
import { fiatTokenAbi, messageTransmitterAbi, tokenMessengerAbi, tokenMinterAbi } from "./abis";
import { DOMAIN, ETH } from "./config";
import { allowanceFields } from "./allowance";
import { errMsg, redactUrl, withFailover } from "./failover";
import type { CheckId, CheckResult, CheckStatus } from "./types";
import { toUsdcString } from "./units";

export interface EthDeps {
  timeoutMs: number;
  allowanceWarnRaw: bigint;
  /** Injected for tests; passed to viem's http transport. */
  fetchFn?: typeof fetch;
  now?: () => Date;
}

const etherscan = (addr: Address, proxy = false) =>
  `${ETH.explorer}/address/${addr}#${proxy ? "readProxyContract" : "readContract"}`;

interface CallSpec {
  id: CheckId;
  label: string;
  source: string;
  source_url: string;
  call: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] };
  evaluate: (result: unknown) => { raw: string; status: CheckStatus; value_usdc?: string; detail?: string };
}

const pausedEval = (what: string) => (r: unknown) => {
  if (typeof r !== "boolean") throw new Error("expected bool");
  return { raw: String(r), status: (r ? "blocked" : "ok") as CheckStatus, detail: r ? `${what} is paused` : undefined };
};

export function ethCallSpecs(allowanceWarnRaw: bigint): CallSpec[] {
  return [
    {
      id: "A5",
      label: "Ethereum USDC minter allowance for TokenMinter",
      source: `USDC(${ETH.usdc}).minterAllowance(TokenMinter ${ETH.tokenMinter})`,
      source_url: etherscan(ETH.usdc, true),
      call: { address: ETH.usdc, abi: fiatTokenAbi, functionName: "minterAllowance", args: [ETH.tokenMinter] },
      evaluate: (r) => {
        if (typeof r !== "bigint") throw new Error("expected uint256");
        return allowanceFields(r, allowanceWarnRaw);
      },
    },
    {
      id: "A6",
      label: "TokenMinter is a USDC minter on Ethereum",
      source: `USDC(${ETH.usdc}).isMinter(TokenMinter ${ETH.tokenMinter})`,
      source_url: etherscan(ETH.usdc, true),
      call: { address: ETH.usdc, abi: fiatTokenAbi, functionName: "isMinter", args: [ETH.tokenMinter] },
      evaluate: (r) => {
        if (typeof r !== "boolean") throw new Error("expected bool");
        return { raw: String(r), status: r ? "ok" : "blocked", detail: r ? undefined : "TokenMinter is no longer a USDC minter" };
      },
    },
    {
      id: "A7",
      label: "Ethereum MessageTransmitter paused",
      source: `MessageTransmitter(${ETH.messageTransmitter}).paused()`,
      source_url: etherscan(ETH.messageTransmitter),
      call: { address: ETH.messageTransmitter, abi: messageTransmitterAbi, functionName: "paused" },
      evaluate: pausedEval("MessageTransmitter"),
    },
    {
      id: "A8",
      label: "Ethereum TokenMinter paused",
      source: `TokenMinter(${ETH.tokenMinter}).paused()`,
      source_url: etherscan(ETH.tokenMinter),
      call: { address: ETH.tokenMinter, abi: tokenMinterAbi, functionName: "paused" },
      evaluate: pausedEval("TokenMinter"),
    },
    {
      id: "A9",
      label: "Noble registered as remote on Ethereum (domain 4)",
      source: `TokenMessenger(${ETH.tokenMessenger}).remoteTokenMessengers(${DOMAIN.NOBLE})`,
      source_url: etherscan(ETH.tokenMessenger),
      call: { address: ETH.tokenMessenger, abi: tokenMessengerAbi, functionName: "remoteTokenMessengers", args: [DOMAIN.NOBLE] },
      evaluate: (r) => {
        if (typeof r !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(r)) throw new Error("expected bytes32");
        const zero = /^0x0+$/.test(r);
        return { raw: r, status: zero ? "blocked" : "ok", detail: zero ? "Noble is not registered as a remote domain" : undefined };
      },
    },
    {
      id: "A10",
      label: "Ethereum USDC paused",
      source: `USDC(${ETH.usdc}).paused()`,
      source_url: etherscan(ETH.usdc, true),
      call: { address: ETH.usdc, abi: fiatTokenAbi, functionName: "paused" },
      evaluate: pausedEval("USDC"),
    },
    {
      id: "B1",
      label: "Ethereum per-message burn limit (USDC)",
      source: `TokenMinter(${ETH.tokenMinter}).burnLimitsPerMessage(USDC ${ETH.usdc})`,
      source_url: etherscan(ETH.tokenMinter),
      call: { address: ETH.tokenMinter, abi: tokenMinterAbi, functionName: "burnLimitsPerMessage", args: [ETH.usdc] },
      evaluate: (r) => {
        if (typeof r !== "bigint") throw new Error("expected uint256");
        return {
          raw: r.toString(),
          value_usdc: toUsdcString(r),
          status: r === 0n ? "blocked" : "ok",
          detail: r === 0n ? "Burn limit is 0: burning USDC on Ethereum is disabled" : undefined,
        };
      },
    },
  ];
}

type McResult = { status: "success"; result: unknown } | { status: "failure"; error: Error };

export async function fetchEthereumChecks(urls: readonly string[], deps: EthDeps): Promise<CheckResult[]> {
  const specs = ethCallSpecs(deps.allowanceWarnRaw);
  const now = () => (deps.now ? deps.now() : new Date()).toISOString();

  try {
    const { value, endpoint } = await withFailover(urls, async (url) => {
      const client = createPublicClient({
        chain: mainnet,
        transport: http(url, { timeout: deps.timeoutMs, retryCount: 0, fetchFn: deps.fetchFn }),
      });
      const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
      const results = (await client.multicall({
        contracts: specs.map((s) => s.call) as any,
        allowFailure: true,
        blockNumber,
      })) as McResult[];
      if (results.length !== specs.length) throw new Error("multicall returned wrong number of results");
      return { blockNumber, results };
    });

    const fetched_at = now();
    return specs.map((spec, i): CheckResult => {
      const common = {
        id: spec.id,
        label: spec.label,
        source: spec.source,
        source_url: spec.source_url,
        endpoint: redactUrl(endpoint),
        block: value.blockNumber.toString(),
        fetched_at,
      };
      const r = value.results[i]!;
      if (r.status === "failure") return { ...common, raw: null, status: "error", detail: errMsg(r.error) };
      try {
        return { ...common, ...spec.evaluate(r.result) };
      } catch (err) {
        return { ...common, raw: null, status: "error", detail: errMsg(err) };
      }
    });
  } catch (err) {
    const fetched_at = now();
    return specs.map((spec) => ({
      id: spec.id,
      label: spec.label,
      source: spec.source,
      source_url: spec.source_url,
      endpoint: null,
      raw: null,
      status: "error" as const,
      fetched_at,
      detail: errMsg(err),
    }));
  }
}
