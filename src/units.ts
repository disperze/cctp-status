/**
 * USDC amount helpers. Every on-chain amount is an integer in 6-decimal base
 * units and is handled as `bigint`. Nothing here touches floating point.
 */
export const DECIMALS = 6;
const SCALE = 10n ** BigInt(DECIMALS);

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Format base units for display.
 *   formatUsdc(500000000000n)                  -> "500,000"
 *   formatUsdc(500000000000n, { full: true })  -> "500,000.000000"
 *   formatUsdc(1234500000n)                    -> "1,234.5"
 */
export function formatUsdc(raw: bigint, opts: { full?: boolean; grouping?: boolean } = {}): string {
  const { full = false, grouping = true } = opts;
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const intPart = (abs / SCALE).toString();
  let frac = (abs % SCALE).toString().padStart(DECIMALS, "0");
  if (!full) frac = frac.replace(/0+$/, "");
  const head = grouping ? group(intPart) : intPart;
  return `${neg ? "-" : ""}${head}${frac ? "." + frac : ""}`;
}

/** Plain machine-readable decimal string: 500000000000n -> "500000" */
export function toUsdcString(raw: bigint): string {
  return formatUsdc(raw, { grouping: false });
}

/**
 * Parse a user-entered USDC amount ("2,000,000", "1500.25", "0.000001") into
 * base units. Rejects negatives, more than 6 decimals, and junk.
 */
export function parseUsdc(input: string): bigint {
  const s = input.trim().replace(/[,_\s]/g, "");
  const m = /^(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[1] === "" && (m[2] ?? "") === "")) throw new Error(`Invalid USDC amount: "${input}"`);
  const whole = m[1] || "0";
  const frac = m[2] ?? "";
  if (frac.length > DECIMALS) throw new Error(`USDC has at most ${DECIMALS} decimals: "${input}"`);
  return BigInt(whole) * SCALE + BigInt(frac.padEnd(DECIMALS, "0") || "0");
}

/** Parse a strict non-negative integer string (on-chain raw amount). */
export function parseRaw(input: unknown): bigint {
  if (typeof input === "bigint") return input;
  if (typeof input !== "string" || !/^\d+$/.test(input)) throw new Error(`Expected integer string, got ${JSON.stringify(input)}`);
  return BigInt(input);
}

/** "0.998" -> { num: 998n, den: 1000n }. Exact; no float parsing. */
export function parseDecimalRatio(text: string): { num: bigint; den: bigint } {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`Invalid decimal: "${text}"`);
  const frac = m[2] ?? "";
  const den = 10n ** BigInt(frac.length);
  return { num: BigInt((m[1] ?? "0") + frac), den };
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  if (b <= 0n) throw new Error("ceilDiv by non-positive");
  return (a + b - 1n) / b;
}
