import { useState } from "react";
import { Decimal } from "@tienda/domain";
import { Badge, Capture, Field, MoneyInput, Notice } from "../components/ui";
import { amount, money, shortDate, today, mxn } from "../lib/format";

export function ClipSettlement({ income, onSuccess }: { income: any; onSuccess: () => void }) {
  const [show, setShow] = useState(false),
    [difference, setDifference] = useState<string | null>(null);
  if (income.source === "manual_summary") return null;
  return (
    <section className="panel">
      <h3>Desglose y conciliación de Clip</h3>
      <dl className="detail-list">
        {[
          ["Importe base del reporte (no es venta sin IVA)", income.clip_base_cents],
          ["Propina", income.clip_tip_cents],
          ["Cargo por diferimiento del reporte", income.clip_financing_cents],
          ["Net Amount del reporte (no es depósito confirmado)", income.clip_report_net_cents],
          ["Total cobrado al cliente", income.gross_cents],
        ].map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{money(value)}</dd>
          </div>
        ))}
      </dl>
      {income.channel !== "clip" ? (
        <Notice>
          El cobro se registra en la cuenta elegida al importar: Efectivo o Banco para
          transferencias. No requiere liquidación de tarjeta Clip.
        </Notice>
      ) : income.settled_at ? (
        <>
          <Badge tone="success">Depósito conciliado</Badge>
          <dl className="detail-list">
            {[
              ["Procesamiento retenido, IVA incluido", income.processing_fee_cents],
              ["Financiamiento retenido, IVA incluido", income.financing_withheld_cents],
              ["IVA acreditable documentado de los cargos", income.fee_creditable_tax_cents],
              ["Costo de comisiones reconocido en utilidad", income.fees_cents],
              ["Depósito registrado en Banco", income.deposited_cents],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{money(value)}</dd>
              </div>
            ))}
          </dl>
          <p>
            {shortDate(income.settlement_date)} · {income.settlement_reference}
          </p>
          <Notice>
            El depósito ya está en Efectivo → Banco. Las comisiones ya se descuentan en la utilidad;
            registrarlas otra vez como gasto duplicaría su efecto.
          </Notice>
        </>
      ) : (
        <>
          <Notice>
            Comisión y depósito pendientes de verificar. El cargo por diferimiento del CSV no
            demuestra lo retenido por Clip. Usa el estado de cuenta para completar los cargos
            reales. No registres de nuevo estas comisiones como gasto.
          </Notice>
          {income.status === "active" && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setDifference(null);
                setShow(!show);
              }}
            >
              {show ? "Ocultar conciliación" : "Conciliar depósito"}
            </button>
          )}
          {show && (
            <div
              onInput={(e) => {
                const form = e.currentTarget.querySelector("form");
                if (!form) return;
                const v = Object.fromEntries(new FormData(form));
                const keys = ["processing_fee", "financing_withheld", "deposited"];
                if (keys.some((k) => !/^\d+(\.\d{1,2})?$/.test(String(v[k] ?? "")))) {
                  setDifference(null);
                  return;
                }
                setDifference(
                  new Decimal(amount(income.gross_cents))
                    .minus(String(v.processing_fee))
                    .minus(String(v.financing_withheld))
                    .minus(String(v.deposited))
                    .toFixed(2),
                );
              }}
            >
              <Capture
                name="settle-clip"
                submit="Confirmar conciliación y registrar depósito"
                onSuccess={onSuccess}
                transform={(v) => ({ ...v, id: income.id })}
              >
                <Notice>
                  Debe cuadrar al centavo: total cobrado = depósito + procesamiento retenido +
                  financiamiento retenido. Los importes deben corresponder a esta transacción; si el
                  banco agrupa varias, usa el detalle de liquidación para asignarlos.
                </Notice>
                <div className="form-grid">
                  <Field label="Comisión de procesamiento retenida, IVA incluido">
                    <MoneyInput name="processing_fee" required />
                  </Field>
                  <Field
                    label="Financiamiento retenido, IVA incluido"
                    hint="Escribe 0 si el estado de cuenta confirma que no se retuvo este cargo."
                  >
                    <MoneyInput name="financing_withheld" required />
                  </Field>
                  <Field
                    label="IVA acreditable documentado de los cargos"
                    hint="Escribe 0 cuando no sea recuperable. No se calcula automáticamente."
                  >
                    <MoneyInput name="creditable_tax" required />
                  </Field>
                  <Field label="Depósito neto de esta transacción">
                    <MoneyInput name="deposited" required />
                  </Field>
                  <Field label="Fecha real del depósito">
                    <input type="date" name="date" defaultValue={today()} required />
                  </Field>
                  <Field label="Referencia del estado de cuenta o liquidación">
                    <input name="reference" minLength={5} maxLength={1000} required />
                  </Field>
                </div>
                <Notice tone={difference !== null && difference !== "0.00" ? "error" : "info"}>
                  Diferencia: {difference === null ? "completa los importes" : mxn(difference)}.
                  Solo se guarda cuando es $0.00. Se registrará el depósito en Banco una sola vez y
                  se liberará el saldo correspondiente de Clip.
                </Notice>
              </Capture>
            </div>
          )}
        </>
      )}
    </section>
  );
}
