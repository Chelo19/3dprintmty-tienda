import type { Row } from "@tienda/shared";
export const roundRatio = (value: bigint, numerator: bigint, denominator: bigint) =>
  denominator ? (value * numerator + denominator / 2n) / denominator : 0n;
export const netAt16 = (gross: bigint) => roundRatio(gross, 100n, 116n);
export function effectiveNet(r: Row): string | null {
  if (r.net_cents != null) return String(r.net_cents);
  if (BigInt(r.clip_tip_cents ?? 0) !== 0n || BigInt(r.clip_financing_cents ?? 0) !== 0n)
    return null;
  return netAt16(BigInt(r.gross_cents)).toString();
}
export function resicoTax(base: bigint): { tax: bigint; rate: string } | null {
  if (base < 0n || base > 350000000n) return null;
  const points =
    base <= 2500000n
      ? 100n
      : base <= 5000000n
        ? 110n
        : base <= 8333333n
          ? 150n
          : base <= 20833333n
            ? 200n
            : 250n;
  return { tax: roundRatio(base, points, 10000n), rate: (Number(points) / 100).toFixed(2) };
}
