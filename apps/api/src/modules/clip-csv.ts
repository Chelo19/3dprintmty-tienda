import type { Row } from "@tienda/shared";
import { cents, major } from "@tienda/domain";
import { date, money } from "./validation";
import type { NormalizedIncome } from "./import-income";

const required = [
  "Date",
  "Transaction ID",
  "Payment ID",
  "Receipt No",
  "Payment Status",
  "Payment Currency",
  "Paid Amount",
  "Payment Method Type",
];
export const isClipReport = (headers: string[]) => required.every((h) => headers.includes(h));
export function clipReportRows(raw: Row[], decisions: Record<string, "include" | "exclude"> = {}) {
  const rows: NormalizedIncome[] = [],
    errors: Row[] = [];
  for (const [i, r] of raw.entries()) {
    try {
      if (!isClipReport(Object.keys(r))) throw new Error("Faltan columnas del reporte de Clip.");
      const status = r["Payment Status"].trim().toLowerCase();
      if (status !== "approved") {
        const decision = Object.hasOwn(decisions, status) ? decisions[status] : undefined;
        if (!decision)
          throw new Error(
            "Decide si incluir o excluir el estatus: " + (status || "Sin estatus") + ".",
          );
        if (decision === "exclude") continue;
      }
      if (r["Payment Currency"] !== "MXN") throw new Error("Solo se aceptan cobros en MXN.");
      const stamp = String(r.Date).trim();
      if (
        !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(stamp) ||
        Number(stamp.slice(11, 13)) > 23 ||
        Number(stamp.slice(14, 16)) > 59 ||
        Number(stamp.slice(17, 19) || 0) > 59
      )
        throw new Error("Fecha u hora inválida; se espera fecha y hora de Monterrey.");
      const day = date.parse(stamp.slice(0, 10));
      const gross = major(cents(money.parse(r["Paid Amount"])));
      const readAmount = (key: string) =>
        r[key]?.trim() ? major(cents(money.parse(r[key].trim()))) : null;
      const base = readAmount("Base Amount"),
        tip = readAmount("Tip Amount"),
        financing = readAmount("Deferral Comission"),
        reportNet = readAmount("Net Amount");
      if (
        base !== null &&
        tip !== null &&
        financing !== null &&
        cents(base) + cents(tip) + cents(financing) !== cents(gross)
      )
        throw new Error(
          "No cuadra Paid Amount con Base Amount + Tip Amount + Deferral Comission. Revisa el reporte sin ajustar centavos automáticamente.",
        );

      if (r["Refunded Amount"] && cents(money.parse(r["Refunded Amount"])) > 0n)
        throw new Error(
          "Tiene devoluciones. Regístralas con su fecha real antes de conciliar este cobro.",
        );
      const ids = [r["Transaction ID"], r["Payment ID"], r["Receipt No"]].map((v) =>
        String(v ?? "").trim(),
      );
      if (!ids.some(Boolean) || ids.some((v) => v.length > 200))
        throw new Error("Falta un identificador válido de Clip.");
      const method = String(
        r["Payment Method Type"] || r["Payment Method Brand"] || "Sin identificar",
      ).trim();
      rows.push({
        external_id: "clip:" + (ids[2] || ids[0] || ids[1]),
        clip_transaction_id: ids[0] || undefined,
        clip_payment_id: ids[1] || undefined,
        clip_receipt_no: ids[2] || undefined,
        clip_base: base,
        clip_tip: tip,
        clip_financing: financing,
        clip_report_net: reportNet,
        clip_financial_raw: Object.fromEntries(
          [
            "Base Amount",
            "Tip Amount",
            "Net Amount",
            "Deferral Comission",
            "Paid Amount",
            "Installment",
            "Installment Type",
            "Payment Status",
            "Payment Method Type",
            "Payment Method Brand",
          ]
            .filter((key) => r[key] !== undefined)
            .map((key) => [key, String(r[key])]),
        ),
        date: day,
        gross,
        net: null,
        cogs: null,
        fees: null,
        method,
        status: ["cancelled", "canceled"].includes(status) ? "cancelled" : "active",
        clip_status: status,
        description: "Clip · " + (ids[2] || ids[0] || ids[1]),
      });
    } catch (e) {
      errors.push({ row: i + 2, message: e instanceof Error ? e.message : "Fila inválida" });
    }
  }
  return { rows, errors };
}
