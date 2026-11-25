import Decimal from "decimal.js";
export { warrantyExpiry, warrantyDetails } from "./warranty";
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export { Decimal };
export interface CardFeeRule {
  method: string;
  percent: string;
  fixed_cents: string;
  tax_percent: string;
  installments?: number | null;
  msi_percent?: string;
}
const feeMethod = (method: string) =>
  method
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
/** One default tariff applies to both debit and credit; conflicting legacy tariffs need an explicit default. */
export function defaultCardFeeRule(rules: CardFeeRule[]): CardFeeRule | undefined {
  const common = rules.find((r) => ["tarjeta", "card"].includes(feeMethod(r.method)));
  if (common) return common;
  const legacy = rules.filter((r) =>
    ["debito", "credito", "debit", "credit", "debit_card", "credit_card"].includes(
      feeMethod(r.method),
    ),
  );
  if (!legacy.length) return undefined;
  const same = legacy.every(
    (r) =>
      new Decimal(r.percent).eq(legacy[0]!.percent) &&
      new Decimal(r.fixed_cents).eq(legacy[0]!.fixed_cents) &&
      new Decimal(r.tax_percent).eq(legacy[0]!.tax_percent),
  );
  return same ? legacy[0] : undefined;
}
export function cardInstallmentPlan(raw?: Record<string, unknown> | null) {
  const type = feeMethod(String(raw?.["Installment Type"] ?? ""));
  const count = String(raw?.Installment ?? "1").trim();
  const installments = /^\d+$/.test(count) ? Number(count) : null;
  const msi = type === "msi" || type.includes("sin interes");
  return {
    msi,
    installments,
    needsReview:
      (msi && (installments === null || installments < 2 || installments > 120)) ||
      (!msi && (installments === null || installments > 1)),
  };
}
export function estimateCardFee(
  grossCents: string,
  rules: CardFeeRule[],
  raw?: Record<string, unknown> | null,
) {
  const plan = cardInstallmentPlan(raw);
  if (plan.needsReview) return null;
  const rule = plan.msi
    ? rules.find((r) => r.method === "MSI" && r.installments === plan.installments)
    : defaultCardFeeRule(rules);
  if (!rule || !/^\d+$/.test(grossCents)) return null;
  if (plan.msi && rule.msi_percent == null) return null;
  const gross = new Decimal(grossCents);
  const base = gross.times(rule.percent).div(100).plus(rule.fixed_cents).toDecimalPlaces(0);
  const tax = base.times(rule.tax_percent).div(100).toDecimalPlaces(0);
  const financingBase = plan.msi
    ? gross.times(rule.msi_percent!).div(100).toDecimalPlaces(0)
    : new Decimal(0);
  const financingTax = financingBase.times(rule.tax_percent).div(100).toDecimalPlaces(0);
  const financing = financingBase.plus(financingTax);
  const processing = base.plus(tax);
  const total = processing.plus(financing);
  return {
    rule_method: rule.method,
    percent: rule.percent,
    fixed_cents: String(rule.fixed_cents),
    tax_percent: rule.tax_percent,
    base_cents: base.toFixed(0),
    tax_cents: tax.plus(financingTax).toFixed(0),
    processing_tax_cents: tax.toFixed(0),
    processing_cents: processing.toFixed(0),
    financing_base_cents: financingBase.toFixed(0),
    financing_tax_cents: financingTax.toFixed(0),
    financing_cents: financing.toFixed(0),
    total_cents: total.toFixed(0),
    installments: plan.installments,
    msi: plan.msi,
    msi_priced: plan.msi,
    msi_percent: plan.msi ? rule.msi_percent! : "0",
    deposited_cents: total.lte(gross) ? gross.minus(total).toFixed(0) : null,
  };
}
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
