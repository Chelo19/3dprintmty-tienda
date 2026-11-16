import type { ImportPaymentType } from "@tienda/shared";
/** Normalized income from an uploaded report. External IDs survive history cleanup. */
export interface NormalizedIncome {
  external_id: string;
  payment_type?: ImportPaymentType;
  clip_status?: string;
  clip_base?: string | null;
  clip_tip?: string | null;
  clip_financing?: string | null;
  clip_report_net?: string | null;
  clip_financial_raw?: Record<string, string> | null;
  clip_transaction_id?: string;
  clip_payment_id?: string;
  clip_receipt_no?: string;
  date: string;
  gross: string;
  net: string | null;
  cogs: string | null;
  fees: string | null;
  method: string;
  status: "active" | "cancelled";
  description: string;
}

/** Amounts from Clip are not fiscal sale net or an ordinary processing fee. */
export const clipAmounts = ["clip_base", "clip_tip", "clip_financing", "clip_report_net"] as const;
