/**
 * Minimal ABI fragments. Signatures match:
 *  - https://github.com/circlefin/evm-cctp-contracts/tree/master/docs/abis/cctp
 *    (MessageTransmitter.json, TokenMinter.json, TokenMessenger.json)
 *  - FiatTokenV2_2 (https://github.com/circlefin/stablecoin-evm), the
 *    implementation behind the USDC proxy at 0xA0b8...eB48.
 */
export const fiatTokenAbi = [
  { type: "function", name: "minterAllowance", stateMutability: "view", inputs: [{ name: "minter", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "isMinter", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
] as const;

export const messageTransmitterAbi = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "localDomain", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "uint32" }] },
] as const;

export const tokenMinterAbi = [
  { type: "function", name: "paused", stateMutability: "view", inputs: [], outputs: [{ type: "bool" }] },
  { type: "function", name: "burnLimitsPerMessage", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "localTokenMessenger", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export const tokenMessengerAbi = [
  { type: "function", name: "remoteTokenMessengers", stateMutability: "view", inputs: [{ name: "", type: "uint32" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "localMinter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "localMessageTransmitter", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
