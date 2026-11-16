export const NOTES_MAX_LENGTH = 20_000;

export class AppError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}
export type Row = Record<string, any>;
export interface Metric {
  value: string | null;
  status: "completo" | "parcial" | "no_disponible";
  reason?: string;
}
export interface FiscalSummary {
  profile: string;
  monthly: Row[];
  vat_collected: Metric;
  vat_creditable: Metric;
  vat_due: Metric;
  vat_favor: Metric;
  isr_estimate: Metric;
  isr_due: Metric;
  notice: string;
}
export interface SourceSummary {
  purchase_count: number;
  expense_count: number;
  purchases_total: Metric;
  acquisition_cost: Metric;
  expenses_total: Metric;
  operating_expense: Metric;
  assets_total: Metric;
  purchases_paid: Metric;
  expenses_paid: Metric;
  recoveries: Metric;
  vat_recorded: Metric;
  vat_paid_pending: Metric;
}
export interface Report {
  financial?: {
    warnings: string[];
    movements: { name: string; amount: string }[];
    months: { month: string; cash: string }[];
  };
  sourceSummary?: SourceSummary;
  fiscal?: FiscalSummary;
  afterIsr?: Metric;
  costBasis?: "monthly" | "per_income";
  inventoryMode?: "summary" | "detailed" | "external";
  from: string;
  to: string;
  sales: Metric;
  collected: Metric;
  cogs: Metric;
  gross: Metric;
  fees: Metric;
  contribution: Metric;
  expenses: Metric;
  operating: Metric;
  cash: Metric;
  inventory: Metric;
  grossMargin: string | null;
  operatingMargin: string | null;
  warnings: string[];
  months: Row[];
  categories: Row[];
  expenseCategories: Row[];
  payments: Row[];
  productPerformance: Row[];
  inventoryHistory: Row[];
  slowProducts: Row[];
  recentPurchases: Row[];
  recentExpenses: Row[];
  count: number;
  knownCosts: number;
}

export type ImportPaymentType = "cash" | "card" | "transfer";
export function inferImportPaymentType(method: string): ImportPaymentType | undefined {
  const value = method
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  if (["cash", "efectivo"].includes(value)) return "cash";
  if (
    [
      "transfer",
      "transferencia",
      "transferencia bancaria",
      "bank_transfer",
      "bank transfer",
      "spei",
    ].includes(value)
  )
    return "transfer";
  if (
    [
      "card",
      "credit_card",
      "debit_card",
      "credit",
      "debit",
      "credito",
      "debito",
      "tarjeta",
      "tarjeta de credito",
      "tarjeta de debito",
      "msi",
      "wallet",
    ].includes(value)
  )
    return "card";
  return undefined;
}
