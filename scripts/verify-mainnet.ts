/**
 * Read-only mainnet verification of every hardcoded constant in src/config.ts,
 * then a live run of all checks.  Usage: npm run verify
 */
import "../src/env";
import { createPublicClient, getAddress, http } from "viem";
import { mainnet } from "viem/chains";
import { messageTransmitterAbi, tokenMessengerAbi, tokenMinterAbi } from "../src/abis";
import { DOMAIN, ETH, NOBLE, loadConfig } from "../src/config";
import { fetchEthereumChecks } from "../src/ethereum";
import { withFailover } from "../src/failover";
import { ETH_TOKEN_MESSENGER_BYTES32, base64ToHex, fetchNobleChecks, getCctpModuleAddress, lcdQuery } from "../src/noble";

const cfg = loadConfig();
const deps = { timeoutMs: cfg.requestTimeoutMs, allowanceWarnRaw: cfg.allowanceWarnRaw };
let failures = 0;
function assert(ok: boolean, what: string, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}${detail ? `  (${detail})` : ""}`);
  if (!ok) failures++;
}

/** Minimal bech32 -> bytes (no checksum validation needed: the address came from the chain). */
function bech32ToHex(addr: string): string {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const data = addr.slice(addr.lastIndexOf("1") + 1, -6).split("").map((c) => CHARSET.indexOf(c));
  let acc = 0, bits = 0;
  const out: number[] = [];
  for (const v of data) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return "0x" + Buffer.from(out).toString("hex");
}

console.log("== Ethereum: contract wiring");
const { value: eth } = await withFailover(cfg.ethRpcUrls, async (url) => {
  const c = createPublicClient({ chain: mainnet, transport: http(url, { timeout: cfg.requestTimeoutMs, retryCount: 0 }) });
  const [localMinter, localMT, minterMessenger, localDomain, remoteNoble, ...codes] = await Promise.all([
    c.readContract({ address: ETH.tokenMessenger, abi: tokenMessengerAbi, functionName: "localMinter" }),
    c.readContract({ address: ETH.tokenMessenger, abi: tokenMessengerAbi, functionName: "localMessageTransmitter" }),
    c.readContract({ address: ETH.tokenMinter, abi: tokenMinterAbi, functionName: "localTokenMessenger" }),
    c.readContract({ address: ETH.messageTransmitter, abi: messageTransmitterAbi, functionName: "localDomain" }),
    c.readContract({ address: ETH.tokenMessenger, abi: tokenMessengerAbi, functionName: "remoteTokenMessengers", args: [DOMAIN.NOBLE] }),
    ...[ETH.tokenMessenger, ETH.messageTransmitter, ETH.tokenMinter, ETH.usdc].map((a) => c.getCode({ address: a })),
  ]);
  return { localMinter, localMT, minterMessenger, localDomain, remoteNoble, codes };
});
assert(getAddress(eth.localMinter) === getAddress(ETH.tokenMinter), "TokenMessenger.localMinter() == TokenMinter", eth.localMinter);
assert(getAddress(eth.localMT) === getAddress(ETH.messageTransmitter), "TokenMessenger.localMessageTransmitter() == MessageTransmitter", eth.localMT);
assert(getAddress(eth.minterMessenger) === getAddress(ETH.tokenMessenger), "TokenMinter.localTokenMessenger() == TokenMessenger", eth.minterMessenger);
assert(eth.localDomain === DOMAIN.ETHEREUM, `MessageTransmitter.localDomain() == ${DOMAIN.ETHEREUM}`, String(eth.localDomain));
assert(eth.codes.every((c) => !!c && c.length > 2), "All four addresses have deployed bytecode");

console.log("\n== Noble: module wiring");
const { value: ld } = await lcdQuery<any>(cfg.nobleLcdUrls, NOBLE.paths.localDomain, deps);
assert(Number(ld.body?.domain_id) === DOMAIN.NOBLE, `Noble local_domain == ${DOMAIN.NOBLE}`, JSON.stringify(ld.body));
const { value: rtm } = await lcdQuery<any>(cfg.nobleLcdUrls, NOBLE.paths.remoteTokenMessengers, deps);
const ethEntry = rtm.body?.remote_token_messengers?.find((r: any) => Number(r.domain_id ?? 0) === 0);
assert(!!ethEntry && base64ToHex(ethEntry.address) === ETH_TOKEN_MESSENGER_BYTES32, "Noble remote token messenger for domain 0 == Ethereum TokenMessenger");
const moduleAddr = await getCctpModuleAddress(cfg.nobleLcdUrls, deps);
const moduleHex = bech32ToHex(moduleAddr);
assert(moduleAddr.startsWith("noble1"), "cctp module account discovered", moduleAddr);
assert(
  eth.remoteNoble.toLowerCase() === "0x" + moduleHex.slice(2).padStart(64, "0"),
  "Ethereum TokenMessenger.remoteTokenMessengers(4) == Noble cctp module account",
  `${eth.remoteNoble} vs ${moduleHex}`,
);

console.log("\n== Live checks");
const results = [...(await fetchNobleChecks(cfg.nobleLcdUrls, deps)), ...(await fetchEthereumChecks(cfg.ethRpcUrls, deps))];
for (const r of results) {
  console.log(`${r.id.padEnd(4)} ${r.status.padEnd(7)} ${(r.value_usdc ? r.value_usdc + " USDC" : String(r.raw)).padEnd(70)} ${r.label}`);
  if (r.status === "error") failures++;
}

console.log(failures ? `\n${failures} problem(s) found` : "\nAll constants verified against mainnet.");
process.exit(failures ? 1 : 0);
