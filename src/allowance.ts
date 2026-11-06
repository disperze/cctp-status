import type { CheckStatus } from "./types";
import { formatUsdc, toUsdcString } from "./units";

/** Shared evaluation for destination minter allowances (A5 / B2). */
export function allowanceFields(raw: bigint, warnBelow: bigint) {
  let status: CheckStatus = "ok";
  let detail: string | undefined;
  if (raw === 0n) {
    status = "blocked";
    detail = "Minter allowance is 0: destination cannot mint";
  } else if (raw < warnBelow) {
    status = "warn";
    detail = `Allowance below warning threshold of ${formatUsdc(warnBelow)} USDC`;
  }
  return { raw: raw.toString(), value_usdc: toUsdcString(raw), status, detail };
}
