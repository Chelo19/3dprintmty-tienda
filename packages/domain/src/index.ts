import Decimal from "decimal.js";
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export { Decimal };
export function cents(input: string): bigint {
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(input))
    throw new Error("Importe inválido: usa hasta dos decimales y valores positivos.");
  return BigInt(new Decimal(input).times(100).toFixed(0));
}
export function major(input: bigint | string): string {
  return new Decimal(input.toString()).div(100).toFixed(2);
}
export function sum(values: (string | bigint)[]): bigint {
  return values.reduce<bigint>((a, b) => a + BigInt(b), 0n);
}
export function allocate(total: bigint, weights: bigint[]): bigint[] {
  const base = sum(weights);
  if (total < 0n || weights.some((w) => w < 0n) || (!base && total))
    throw new Error("No se pueden distribuir costos sin una base positiva.");
  const parts = weights.map((w) => (base ? (total * w) / base : 0n));
  let rest = total - sum(parts);
  const order = weights
    .map((w, i) => ({ i, remainder: base ? (total * w) % base : 0n }))
    .sort((a, b) => (a.remainder === b.remainder ? a.i - b.i : a.remainder > b.remainder ? -1 : 1));
  for (const item of order) {
    if (!rest) break;
    parts[item.i] = (parts[item.i] ?? 0n) + 1n;
    rest--;
  }
  return parts;
}
export function lineCost(qty: string, unit: string, discount = "0"): bigint {
  const gross = new Decimal(qty).times(unit).times(100).toDecimalPlaces(0);
  const result = BigInt(gross.toFixed(0)) - cents(discount);
  if (result < 0n) throw new Error("El descuento excede el importe de la partida.");
  return result;
}
export function outflowCost(qty: string, stock: string, value: bigint): bigint {
  if (new Decimal(qty).lte(0) || new Decimal(qty).gt(stock))
    throw new Error("Existencias insuficientes. Revisa la apertura o concilia el inventario.");
  return BigInt(new Decimal(value.toString()).times(qty).div(stock).toFixed(0));
}
export function margin(profit: bigint | null, sales: bigint | null): string | null {
  return profit === null || sales === null || sales <= 0n
    ? null
    : new Decimal(profit.toString()).div(sales.toString()).times(100).toFixed(1);
}
export function monthBounds(month: string): { from: string; to: string } {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("Mes inválido.");
  const [y, m] = month.split("-").map(Number);
  const next = new Date(Date.UTC(y!, m!, 1));
  return { from: month + "-01", to: next.toISOString().slice(0, 10) };
}
export function localDate(timestamp: string): string {
  const dt = new Date(timestamp);
  if (!Number.isFinite(dt.getTime())) throw new Error("Fecha inválida.");
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Monterrey",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
}
