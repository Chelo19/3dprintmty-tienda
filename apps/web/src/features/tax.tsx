import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { monthBounds } from "@tienda/domain";
import type { Report } from "@tienda/shared";
import { api } from "../lib/api";
import { amount, money, mxn, today } from "../lib/format";
import {
  Badge,
  Capture,
  DataTable,
  Field,
  Loading,
  Modal,
  MoneyInput,
  Notice,
} from "../components/ui";
export function FiscalCards({
  report,
  financialOnly = false,
}: {
  report: Report;
  financialOnly?: boolean;
}) {
  const f = report.fiscal;
  if (!f) return null;
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>Impuestos estimados · RESICO persona física</h2>
        <Link to="/app/impuestos">Comprobación fiscal</Link>
      </div>
      <div className="statement">
        {[
          ["IVA cobrado por esta tienda", f.vat_collected],
          ["IVA acreditable pagado y comprobado · tienda", f.vat_creditable],
          ["IVA estimado por pagar · tienda", f.vat_due],
          ["IVA a favor estimado · tienda", f.vat_favor],
          ["ISR estimado antes de retenciones · tienda", f.isr_estimate],
          ["ISR estimado por pagar · tienda", f.isr_due],
          ...(financialOnly
            ? []
            : [["Resultado después de ISR estimado · tienda", report.afterIsr]]),
        ].map(([label, m]: any) => (
          <div key={label}>
            <span>{label}</span>
            <Badge tone={m?.status === "completo" ? "success" : "warning"}>
              {m?.status ?? "pendiente"}
            </Badge>
            <strong>{mxn(m?.value)}</strong>
          </div>
        ))}
      </div>
      {f.monthly.map((m) => (
        <div key={m.month}>
          <p>
            <strong>{m.month}</strong>
            {m.rate ? ` · Tasa ISR: ${m.rate}%` : ""}
            {m.pending_documents
              ? ` · ${m.pending_documents} documentos pagados con IVA pendiente de comprobar`
              : ""}
          </p>
          {m.isr_withheld_excess && m.isr_withheld_excess !== "0.00" && (
            <Notice>
              Retenciones de ISR superiores a la estimación: {mxn(m.isr_withheld_excess)}. Revisa su
              aplicación en la declaración.
            </Notice>
          )}
          {m.pending_reason && <Notice>{m.pending_reason}</Notice>}
          {m.reason && <Notice>{m.reason}</Notice>}
        </div>
      ))}
      <p className="tiny muted">
        {f.notice} Los saldos a favor se muestran por mes; no se aplican automáticamente al mes
        siguiente.
      </p>
    </section>
  );
}
export function SourceCards({ report }: { report: Report }) {
  const s = report.sourceSummary;
  if (!s) return null;
  return (
    <section className="panel">
      <h2>Datos tomados automáticamente de tus registros</h2>
      <Notice>
        Las compras, gastos, pagos e IVA registrados se leen directamente de su documento original.
        No necesitas capturarlos otra vez aquí. Este resumen trabaja con importes totales y no
        requiere productos ni tickets del PDV.
      </Notice>
      <div className="statement">
        {[
          ["Compras de mercancía registradas, IVA incluido", s.purchases_total],
          ["Costo de adquisición registrado, con flete y cargos", s.acquisition_cost],
          ["Gastos operativos registrados, IVA incluido", s.expenses_total],
          ["Gasto operativo reconocido sin IVA recuperable", s.operating_expense],
          ["Activos adquiridos registrados", s.assets_total],
          ["Pagos de compras realizados en el periodo", s.purchases_paid],
          ["Pagos de gastos y activos realizados en el periodo", s.expenses_paid],
          ["Recuperaciones de compras y gastos", s.recoveries],
          ["IVA registrado en documentos del periodo", s.vat_recorded],
          ["IVA pagado pendiente de comprobación al cierre", s.vat_paid_pending],
          ["Flujo de caja disponible del periodo", report.cash],
        ].map(([label, m]: any) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{mxn(m.value)}</strong>
          </div>
        ))}
      </div>
      <p className="tiny muted">
        El flujo de caja muestra las entradas y salidas efectivas de Efectivo y Banco. Las tarjetas
        permanecen en Clip hasta su liquidación. Las adquisiciones registradas pueden incluir
        mercancía que aún no se ha vendido; su importe no se convierte automáticamente en costo
        vendido.
      </p>
    </section>
  );
}
function Proof({ row, onSuccess }: { row: any; onSuccess: () => void }) {
  const [status, setStatus] = useState(row.proof?.status ?? "pending");
  return (
    <Capture
      name="tax-document"
      submit="Guardar comprobación fiscal"
      onSuccess={onSuccess}
      transform={(v) => ({
        ...Object.fromEntries(Object.entries(v).filter(([, value]) => value !== "")),
        id: row.id,
        type: row.type,
        status,
      })}
    >
      <Notice>
        IVA registrado en el documento: {money(row.vat_cents)}. Para acreditarlo confirma que cumple
        los requisitos fiscales y captura el UUID del CFDI. El sistema reconoce únicamente la
        proporción efectivamente pagada. Si el CFDI cubre varios cargos, la suma asignada no puede
        superar su IVA total.
      </Notice>
      <Field label="Tratamiento fiscal">
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="pending">Pendiente de factura o revisión</option>
          <option value="creditable">Comprobado y acreditable</option>
          <option value="nonrecoverable">No recuperable</option>
        </select>
      </Field>
      {status === "creditable" && (
        <div className="form-grid">
          <Field label="UUID del CFDI">
            <input
              name="invoice_uuid"
              required
              defaultValue={row.proof?.invoice_uuid ?? row.invoice_uuid_suggestion ?? ""}
            />
          </Field>
          <Field label="IVA total del CFDI">
            <MoneyInput
              name="invoice_vat"
              required
              defaultValue={amount(row.proof?.invoice_vat_cents ?? row.vat_cents)}
            />
          </Field>
          <Field label="Fecha de comprobación fiscal">
            <input
              type="date"
              name="eligible_on"
              required
              min={row.date}
              defaultValue={row.proof?.eligible_on ?? today()}
            />
          </Field>
        </div>
      )}
      <Field label="Respaldo y observaciones fiscales">
        <textarea
          name="notes"
          minLength={5}
          maxLength={20000}
          required
          rows={3}
          defaultValue={row.proof?.notes ?? row.default_notes ?? ""}
        />
      </Field>
    </Capture>
  );
}
export function TaxPage({ from }: { from: string }) {
  const [month, setMonth] = useState(from.slice(0, 7)),
    [doc, setDoc] = useState<any>(null),
    [costOpen, setCostOpen] = useState(false),
    [saved, setSaved] = useState("");
  const data = useQuery<any>({ queryKey: ["tax-monthly"], queryFn: () => api("/tax/monthly") });
  const docs = useQuery<any[]>({
    queryKey: ["tax-documents"],
    queryFn: () => api("/tax/documents"),
  });
  const bounds = monthBounds(month);
  const report = useQuery<Report>({
    queryKey: ["report", bounds.from, bounds.to],
    queryFn: () => api(`/report?from=${bounds.from}&to=${bounds.to}`),
  });
  if (data.error || docs.error || report.error)
    return <Notice tone="error">{(data.error ?? docs.error ?? report.error)?.message}</Notice>;
  if (!data.data || !docs.data || !report.data) return <Loading />;
  const cost = data.data.costs.find((r: any) => r.month === month),
    inputs = data.data.inputs.find((r: any) => r.month === month);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Impuestos y costo mensual</h1>
          <p>Utilidad e impuestos estimados únicamente de esta tienda, con IVA incluido al 16%.</p>
        </div>
        <Field label="Mes de trabajo">
          <input
            type="month"
            value={month}
            required
            onChange={(e) => {
              if (e.target.value) {
                setMonth(e.target.value);
                setCostOpen(false);
                setSaved("");
              }
            }}
          />
        </Field>
      </div>
      {saved && <Notice tone="success">{saved}</Notice>}
      {!report.data.fiscal && (
        <section className="panel">
          <Notice>
            Activa el perfil cuando confirmes que tributas en RESICO persona física y todas tus
            ventas ordinarias incluyen IVA del 16%.
          </Notice>
          <Capture name="tax-profile" submit="Activar RESICO e IVA 16%" onSuccess={() => {}}>
            <input type="hidden" name="profile" value="resico_pf_16" />
          </Capture>
        </section>
      )}
      <SourceCards report={report.data} />
      <FiscalCards report={report.data} />
      <section className="panel">
        <h2>Para calcular utilidad contable: costo total vendido del mes</h2>
        <p>
          Importe confirmado:{" "}
          <strong>
            {cost?.active
              ? money(cost.amount_cents)
              : report.data.cogs.value !== null
                ? mxn(report.data.cogs.value)
                : "Pendiente de dato del PDV"}
          </strong>
        </p>
        <Notice>
          Si tu PDV proporciona el costo total de lo vendido, basta con ese importe mensual; no
          necesitas registrar aquí cada producto. Las compras y gastos ya están incluidos en el
          resumen automático. Para obtener utilidad contable falta conocer qué parte de la mercancía
          se vendió; mientras tanto puedes consultar el flujo de caja sin llenar este campo. El
          costo mensual sustituye al costo por venta y no se prorratea por días.
        </Notice>
        <button className="button" onClick={() => setCostOpen(!costOpen)}>
          {costOpen ? "Ocultar captura" : "Capturar o corregir costo mensual"}
        </button>
        {costOpen && (
          <Capture
            key={month + String(cost?.updated_at)}
            name="monthly-cost"
            submit="Guardar costo mensual"
            onSuccess={() => {
              setCostOpen(false);
              setSaved("Costo mensual guardado.");
            }}
            transform={(v) => ({ ...v, month, active: v.active === "true" })}
          >
            <Field label="Costo vendido del mes, sin IVA recuperable">
              <MoneyInput
                name="amount"
                defaultValue={cost ? amount(cost.amount_cents) : (report.data.cogs.value ?? "")}
                required
              />
            </Field>
            <Field label="Estado del costo">
              <select name="active" defaultValue={cost?.active === false ? "false" : "true"}>
                <option value="true">Confirmado con respaldo externo</option>
                <option value="false">Retirar costo y dejarlo pendiente</option>
              </select>
            </Field>
            <Field label="Fuente del costo y motivo">
              <textarea
                name="reference"
                required
                minLength={5}
                maxLength={20000}
                rows={3}
                defaultValue={cost?.reference ?? ""}
              />
            </Field>
          </Capture>
        )}
      </section>
      <section className="panel">
        <h2>Ajustes fiscales de esta tienda (opcionales)</h2>
        <Notice>
          La estimación funciona sin llenar este apartado. Úsalo solo si necesitas aplicar
          retenciones o un saldo anterior de IVA correspondientes a esta tienda. Estos importes no
          registran pagos ni modifican tus cuentas de dinero.
        </Notice>
        <Capture
          key={month + String(inputs?.updated_at)}
          name="monthly-tax"
          submit="Guardar ajustes fiscales de la tienda"
          onSuccess={() => setSaved("Ajustes fiscales de la tienda guardados.")}
          transform={(v) => ({ ...v, month })}
        >
          <div className="form-grid">
            {[
              ["isr_withheld", "ISR retenido de esta tienda", "isr_withheld_cents"],
              ["vat_withheld", "IVA retenido de esta tienda", "vat_withheld_cents"],
              ["vat_carry", "Saldo anterior de IVA de esta tienda a aplicar", "vat_carry_cents"],
            ].map(([name, label, key], i) => (
              <Field key={name} label={label!}>
                <MoneyInput
                  name={name!}
                  required
                  defaultValue={inputs ? amount(inputs[key!]) : "0"}
                />
              </Field>
            ))}
          </div>
          <Field label="Referencia y respaldo de los ajustes de la tienda">
            <textarea
              name="reference"
              required
              minLength={5}
              maxLength={20000}
              rows={3}
              defaultValue={inputs?.reference ?? ""}
            />
          </Field>
        </Capture>
      </section>
      <section className="panel">
        <h2>Comprobación del IVA de compras, gastos y comisiones</h2>
        <Notice>
          El IVA pagado queda pendiente hasta comprobar su CFDI. El IVA no recuperable y los
          importes sin desglose no se acreditan. La fecha de comprobación permite reconocer pagos
          anteriores cuando se obtiene el respaldo. Los meses cerrados conservan su protección.
        </Notice>
        <DataTable
          rows={docs.data}
          columns={[
            { key: "date", label: "Fecha" },
            {
              key: "type",
              label: "Documento",
              render: (r) =>
                (
                  ({ purchase: "Compra", expense: "Gasto", fee: "Comisiones Clip" }) as Record<
                    string,
                    string
                  >
                )[r.type],
            },
            { key: "label", label: "Referencia / concepto" },
            { key: "total_cents", label: "Total original", render: (r) => money(r.total_cents) },
            { key: "paid_cents", label: "Pagado", render: (r) => money(r.paid_cents) },
            { key: "vat_cents", label: "IVA registrado", render: (r) => money(r.vat_cents) },
            {
              key: "proof",
              label: "Tratamiento",
              render: (r) =>
                r.proof?.status === "creditable"
                  ? "Comprobado"
                  : r.proof?.status === "nonrecoverable"
                    ? r.automatic_treatment
                      ? "No recuperable · ya declarado en el gasto"
                      : "No recuperable"
                    : BigInt(r.vat_cents ?? 0) === 0n
                      ? "Sin IVA acreditable"
                      : "Pendiente de comprobación",
            },
          ]}
          onRow={(r) => setDoc(r)}
        />
      </section>
      {doc && (
        <Modal title="Comprobación fiscal del documento" onClose={() => setDoc(null)}>
          <Proof
            row={doc}
            onSuccess={() => {
              setDoc(null);
              setSaved("Comprobación fiscal guardada.");
            }}
          />
        </Modal>
      )}
    </>
  );
}
