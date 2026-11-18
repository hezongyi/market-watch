import type { PositionContract } from "./positionContracts";

/** Decimal boundaries and arithmetic stay integer/rational; display never feeds calculation. */
export function decimalUnits(
  value: string,
  precision: number,
): bigint | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value) || value.length > 30) return;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > precision) return;
  return (
    BigInt(whole) * 10n ** BigInt(precision) +
    BigInt(fraction.padEnd(precision, "0") || "0")
  );
}
export function fixedUnits(value: bigint, precision: number): string {
  const text = value.toString().padStart(precision + 1, "0");
  return precision
    ? `${text.slice(0, -precision)}.${text.slice(-precision)}`
    : text;
}
export function normalizePrice(
  value: string,
  precision: number,
): string | undefined {
  if (!/^\d+(?:\.\d+)?$/.test(value) || value.length > 30) return;
  const [whole, fraction = ""] = value.split(".");
  let units =
    BigInt(whole) * 10n ** BigInt(precision) +
    BigInt(fraction.slice(0, precision).padEnd(precision, "0") || "0");
  if ((fraction[precision] || "0") >= "5") units++;
  return units > 0n ? fixedUnits(units, precision) : undefined;
}
function rounded(n: bigint, d: bigint, places = 2) {
  const scale = 10n ** BigInt(places);
  return fixedUnits((n * scale * 2n + d) / (d * 2n), places);
}
export type PositionResult = {
  lots: string;
  loss: string;
  remaining: string;
  distance: string;
  pipValue: string;
  perLot: string;
};
export function calculatePosition(
  contract: PositionContract,
  input: {
    risk: string;
    entry: string;
    stop: string;
    direction: "long" | "short";
    conversion?: string;
  },
): { result?: PositionResult; error?: string } {
  const risk = decimalUnits(input.risk, 2),
    entry = decimalUnits(input.entry, contract.precision),
    stop = decimalUnits(input.stop, contract.precision);
  if (!risk || !entry || !stop)
    return { error: "填写有效的允许亏损金额、入场价和止损价" };
  if (entry === stop) return { error: "入场价与止损价不能相同" };
  if (
    (input.direction === "long" && stop >= entry) ||
    (input.direction === "short" && stop <= entry)
  )
    return {
      error:
        input.direction === "long"
          ? "做多时止损价应低于入场价"
          : "做空时止损价应高于入场价",
    };
  const units = decimalUnits(contract.units, 0),
    minimum = decimalUnits(contract.minimum, 2),
    step = decimalUnits(contract.step, 2);
  if (!units || !minimum || !step)
    return { error: "合约参数须为正数；手数最多两位小数" };
  let xn = 1n,
    xd = 1n;
  if (contract.base === "USD") {
    xn = 10n ** BigInt(contract.precision);
    xd = stop;
  } else if (contract.conversion) {
    const precision = contract.conversion.endsWith("/JPY") ? 2 : 4;
    const rate = decimalUnits(input.conversion || "", precision);
    if (!rate) return { error: `填写 ${contract.conversion} 换算报价` };
    const scale = 10n ** BigInt(precision);
    [xn, xd] = contract.conversion.startsWith("USD/")
      ? [scale, rate]
      : [rate, scale];
  }
  const distance = entry > stop ? entry - stop : stop - entry;
  const numerator = distance * units * xn,
    denominator = 10n ** BigInt(contract.precision) * xd;
  const maximum = (risk * denominator) / numerator; // hundredths of one lot
  if (maximum < minimum) return { error: "当前风险预算不足最小交易数量" };
  const quantity = minimum + ((maximum - minimum) / step) * step;
  const lossN = quantity * numerator,
    lossD = 100n * denominator;
  return {
    result: {
      lots: fixedUnits(quantity, 2),
      loss: rounded(lossN, lossD),
      remaining: rounded(risk * denominator - lossN, 100n * denominator),
      distance: contract.gold
        ? fixedUnits(distance, contract.precision)
        : distance.toString(),
      pipValue: rounded(units * xn, 10n ** BigInt(contract.precision) * xd),
      perLot: rounded(numerator, denominator),
    },
  };
}
