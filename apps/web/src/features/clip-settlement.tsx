import { Amount } from "../components/Amount";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Decimal } from "@tienda/domain";
import { Badge, Capture, Field, MoneyInput, Notice } from "../components/ui";
import { amount, shortDate, today, mxn } from "../lib/format";

function CommissionBreakdown({ income, quote }: { income: any; quote: any }) {
  const subtract = (a: any, b: any) =>
    a == null || b == null ? null : (BigInt(a) - BigInt(b)).toString();
  const processingTax = quote.processing_tax_cents ?? quote.tax_cents;
  const processingBase = subtract(quote.processing_cents, processingTax);
  const financing = quote.financing_cents ?? "0",
    financingTax = quote.financing_tax_cents ?? "0";
  const incomplete =
    !income.settled_at &&
    (income.fee_missing_rule ||
      income.card_plan?.needsReview ||
      (quote.msi && !quote.msi_priced && !income.msi_fee_applied));
  const total = incomplete ? null : (quote.total_cents ?? quote.processing_cents);
  const rate = (value: any) => (value == null ? "" : ` (${Number(value)}%)`);
  const rows: [string, any][] = [
    ["Base de cálculo: total cobrado", income.gross_cents],
    ["Comisión porcentual" + rate(quote.percent), subtract(processingBase, quote.fixed_cents)],
    ["Cargo fijo", quote.fixed_cents],
    ["Subtotal de procesamiento sin IVA", processingBase],
    ["IVA del procesamiento" + rate(quote.tax_percent), processingTax],
    ["Procesamiento con IVA", quote.processing_cents],
    ...(quote.msi
      ? ([
          [
            `Recargo MSI de ${quote.installments} meses` +
              (incomplete ? "" : rate(quote.msi_percent)),
            incomplete ? null : subtract(financing, financingTax),
          ],
          [
            "IVA del recargo MSI" + rate(quote.financing_tax_percent ?? quote.tax_percent),
            incomplete ? null : financingTax,
          ],
          ["MSI con IVA", incomplete ? null : financing],
        ] as [string, any][])
      : []),
    ["IVA total de las comisiones", incomplete ? null : quote.tax_cents],
    ["Total de comisiones con IVA", total],
    ["Neto después de comisiones", incomplete ? null : quote.deposited_cents],
  ];
  return (
    <section aria-label="Desglose de comisiones">
      <h4>Desglose de comisiones</h4>
      <Badge tone="neutral">
        {income.settled_at
          ? "Tarifa aplicada originalmente"
          : income.fee_needs_apply || !income.fee_applied
            ? "Estimación pendiente de aplicar"
            : "Tarifa aplicada · conciliación pendiente"}
      </Badge>
      <p>
        Tarifa{" "}
        {quote.msi ? `MSI ${quote.installments} meses` : "predeterminada para débito y crédito"}.
      </p>
      <dl className="detail-list">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <Amount
                value={value}
                cents
                effect={
                  label.includes("cobrado") ||
                  label.startsWith("Base de cálculo") ||
                  label.includes("Neto") ||
                  label.includes("Depósito")
                    ? "neutral"
                    : "expense"
                }
              />
            </dd>
          </div>
        ))}
      </dl>
      <p className="tiny muted">
        {income.settled_at
          ? "Este desglose conserva la tarifa usada al registrar el cobro. Los importes reales conciliados aparecen abajo."
          : "El cálculo se precarga al conciliar y puede ajustarse con los importes reales de Clip."}{" "}
        El IVA requiere comprobación fiscal para acreditarse.
      </p>
    </section>
  );
}

export function ClipSettlement({ income, onSuccess }: { income: any; onSuccess: () => void }) {
  const estimate = income.fee_estimate;
  const financingUnknown =
    !!income.fee_missing_rule ||
    !!income.card_plan?.needsReview ||
    (!estimate?.msi_priced &&
      (BigInt(income.clip_financing_cents ?? 0) > 0n ||
        Number(income.clip_financial_raw?.Installment ?? 1) > 1));
  const totalFee = estimate?.total_cents ?? estimate?.processing_cents;
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
            <dd>
              <Amount
                value={value}
                cents
                effect={label === "Total cobrado al cliente" ? "income" : "neutral"}
              />
            </dd>
          </div>
        ))}
      </dl>
      {income.channel === "clip" && (estimate ?? income.applied_fee_breakdown) && (
        <CommissionBreakdown income={income} quote={estimate ?? income.applied_fee_breakdown} />
      )}
      {income.fee_missing_rule && (
        <Notice tone="error">
          {income.card_plan?.needsReview
            ? "El plazo o tipo de financiamiento del reporte requiere revisión."
            : income.card_plan?.msi
              ? `Falta configurar la tarifa MSI de ${income.card_plan.installments ?? "plazo desconocido"} meses.`
              : "El financiamiento del reporte requiere revisión."}{" "}
          No se usa la tarifa de otro plazo.{" "}
          <Link to="/app/configuracion">Revisar reglas de comisión</Link>
        </Notice>
      )}
      {estimate && income.fee_applied && (
        <Notice>
          <strong>
            Comisión con IVA ya descontada de Clip:{" "}
            <Amount
              value={income.fee_applied_cents ?? estimate.processing_cents}
              cents
              effect="expense"
            />
            .
          </strong>{" "}
          Neto registrado de este cobro en Clip:{" "}
          <Amount value={income.fee_net_applied_cents ?? estimate.deposited_cents} cents />. Al
          conciliar solo se ajustará la diferencia con los cargos reales, sin descontar dos veces la
          comisión.
        </Notice>
      )}
      {estimate &&
        (income.fee_needs_apply ?? !income.fee_applied) &&
        income.import_collection_id &&
        !income.settled_at && (
          <Capture
            name="apply-card-fee"
            submit="Aplicar comisión a Clip"
            onSuccess={onSuccess}
            transform={() => ({ id: income.id })}
          >
            <Notice>
              Descontar el cargo pendiente de{" "}
              <Amount
                value={(BigInt(totalFee) - BigInt(income.fee_applied_cents ?? 0)).toString()}
                cents
                effect="expense"
              />{" "}
              de Clip mantendrá el total cobrado de la venta. No registra un depósito en Banco.
            </Notice>
          </Capture>
        )}
      {income.channel !== "clip" ? (
        <Notice>
          El cobro se registra en la cuenta elegida al importar: Efectivo o Banco para
          transferencias. No requiere liquidación de tarjeta Clip.
        </Notice>
      ) : income.settled_at ? (
        <>
          <Badge tone="success">Depósito conciliado</Badge>
          <h4>Comisiones reales conciliadas</h4>
          <dl className="detail-list">
            {[
              ["Procesamiento retenido, IVA incluido", income.processing_fee_cents],
              ["Financiamiento retenido, IVA incluido", income.financing_withheld_cents],
              [
                "Total de comisiones retenidas, IVA incluido",
                income.processing_fee_cents != null && income.financing_withheld_cents != null
                  ? (
                      BigInt(income.processing_fee_cents) + BigInt(income.financing_withheld_cents)
                    ).toString()
                  : null,
              ],
              [
                "IVA registrado de los cargos; acreditamiento sujeto a comprobación",
                income.fee_creditable_tax_cents,
              ],
              ["Cargos retenidos sin su IVA", income.fees_cents],
              ["Depósito registrado en Banco", income.deposited_cents],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>
                  <Amount
                    value={value}
                    cents
                    effect={
                      label.includes("cobrado") ||
                      label.startsWith("Base de cálculo") ||
                      label.includes("Neto") ||
                      label.includes("Depósito")
                        ? "neutral"
                        : "expense"
                    }
                  />
                </dd>
              </div>
            ))}
          </dl>
          <p>
            {shortDate(income.settlement_date)} · {income.settlement_reference}
          </p>
          <Notice>
            El depósito ya está en Efectivo → Banco. Los cargos ya se registraron en esta
            liquidación; registrarlos otra vez como gasto duplicaría su efecto.
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
                setDifference(
                  estimate?.deposited_cents != null && !financingUnknown ? "0.00" : null,
                );
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
                    <MoneyInput
                      name="processing_fee"
                      defaultValue={amount(estimate?.processing_cents)}
                      required
                    />
                  </Field>
                  <Field
                    label="Financiamiento retenido, IVA incluido"
                    hint="Escribe 0 si el estado de cuenta confirma que no se retuvo este cargo."
                  >
                    <MoneyInput
                      name="financing_withheld"
                      defaultValue={
                        estimate && !financingUnknown ? amount(estimate.financing_cents ?? "0") : ""
                      }
                      required
                    />
                  </Field>
                  <Field
                    label="IVA de los cargos"
                    hint="Se propone el IVA calculado del procesamiento. Verifica el importe real, incluido financiamiento si aplica. Para acreditarlo se requiere comprobarlo en Impuestos y costos."
                  >
                    <MoneyInput
                      name="creditable_tax"
                      defaultValue={amount(estimate?.tax_cents)}
                      required
                    />
                  </Field>
                  <Field label="Depósito neto de esta transacción">
                    <MoneyInput
                      name="deposited"
                      defaultValue={!financingUnknown ? amount(estimate?.deposited_cents) : ""}
                      required
                    />
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
