import { Amount } from "../components/Amount";
import { ClipSettlement } from "./clip-settlement";
import { NOTES_MAX_LENGTH } from "@tienda/shared";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, Download } from "lucide-react";
import { Link } from "react-router-dom";
import { Decimal } from "@tienda/domain";
import { api, download } from "../lib/api";
import { money, amount, today, shortDate, sourceLabel } from "../lib/format";
import {
  DataTable,
  Field,
  MoneyInput,
  Capture,
  Modal,
  Loading,
  Notice,
  Badge,
  type Column,
} from "../components/ui";
export const expenseCategories = [
  "Renta",
  "Electricidad",
  "Internet",
  "Publicidad",
  "Comisiones bancarias",
  "Empaques",
  "Bolsas y etiquetas",
  "Mantenimiento del local",
  "Limpieza",
  "Transporte",
  "Software y suscripciones",
  "Sueldos",
  "Servicios profesionales",
  "Otros gastos",
];
export function useRows(resource: string) {
  return useQuery<any[]>({ queryKey: [resource], queryFn: () => api("/" + resource) });
}
export function Select({
  name,
  rows,
  label = "name",
  optional = false,
  defaultValue = "",
  required = true,
}: {
  name: string;
  rows: any[];
  label?: string;
  optional?: boolean;
  defaultValue?: string;
  required?: boolean;
}) {
  return (
    <select name={name} required={required && !optional} defaultValue={defaultValue}>
      <option value="">{optional ? "Sin asignar" : "Seleccionar…"}</option>
      {rows.map((r) => (
        <option value={r.id} key={r.id}>
          {r[label]}
        </option>
      ))}
    </select>
  );
}
function InitialPayment() {
  const [paid, setPaid] = useState(false);
  return (
    <section>
      <label className="check">
        <input
          type="checkbox"
          name="register_paid"
          checked={paid}
          onChange={(e) => setPaid(e.target.checked)}
        />
        Registrar como pagado
      </label>
      {paid && (
        <>
          <div className="form-grid">
            <Field label="Cuenta de pago">
              <select name="payment_account" defaultValue="" required>
                <option value="">Seleccionar…</option>
                <option value="cash">Efectivo</option>
                <option value="bank">Banco</option>
              </select>
            </Field>
            <Field
              label="Fecha del pago (opcional)"
              hint="Si la dejas vacía se usa la fecha del documento."
            >
              <input name="payment_date" type="date" />
            </Field>
          </div>
          <Notice>
            Se registrará una salida por el total del documento, incluidos sus impuestos y cargos,
            en la cuenta elegida. Para pagos parciales, guarda sin marcar esta opción y regístralos
            en Efectivo.
          </Notice>
        </>
      )}
    </section>
  );
}
function DocumentPayment({
  document,
  resource,
  onSuccess,
}: {
  document: any;
  resource: string;
  onSuccess: () => void;
}) {
  const purchase = resource === "purchases";
  const total = purchase
    ? new Decimal(document.total_cents)
    : new Decimal(document.amount_cents).plus(document.tax_cents);
  const remaining = Decimal.max(total.minus(document.paid_cents ?? 0), 0);
  if (remaining.isZero()) return <Notice>Este documento está totalmente pagado.</Notice>;
  return (
    <section>
      <h3>{purchase ? "Registrar pago de compra" : "Registrar pago de gasto"}</h3>
      <p>
        Saldo pendiente: <strong>{money(remaining.toFixed(0))}</strong>. Puedes registrar el total
        pendiente o un pago parcial.
      </p>
      <Capture
        name="cash"
        submit={purchase ? "Guardar pago de compra" : "Guardar pago de gasto"}
        onSuccess={onSuccess}
        transform={(v) => ({
          ...v,
          kind: purchase ? "purchase" : "expense",
          [purchase ? "purchase_id" : "expense_id"]: document.id,
        })}
      >
        <div className="form-grid">
          <Field label="Fecha del pago">
            <input type="date" name="date" defaultValue={today()} min={document.date} required />
          </Field>
          <Field label="Cuenta de pago">
            <select name="account_id" defaultValue="" required>
              <option value="">Seleccionar…</option>
              <option value="cash">Efectivo</option>
              <option value="bank">Banco</option>
            </select>
          </Field>
          <Field label="Importe del pago">
            <MoneyInput name="amount" defaultValue={remaining.div(100).toFixed(2)} required />
          </Field>
        </div>
        <Field label="Referencia del pago y observaciones" hint="Hasta 20,000 caracteres.">
          <textarea
            name="notes"
            defaultValue={
              purchase
                ? "Pago de compra: " + (document.reference || "Sin referencia")
                : "Pago de gasto: " + document.concept
            }
            required
            maxLength={NOTES_MAX_LENGTH}
            rows={3}
          />
        </Field>
      </Capture>
    </section>
  );
}

const initialPaymentFromForm = (v: any) =>
  v.register_paid === "on"
    ? { account_id: v.payment_account, ...(v.payment_date ? { date: v.payment_date } : {}) }
    : undefined;

export function Records({ resource, from, to }: { resource: string; from: string; to: string }) {
  const rows = useRows(resource),
    categories = useRows("categories"),
    suppliers = useRows("suppliers");
  const [modal, setModal] = useState<"new" | any>(null),
    [error, setError] = useState(""),
    [expenseTaxMode, setExpenseTaxMode] = useState("total_no_credit");
  const config: Record<
    string,
    { title: string; description: string; button: string; action: string; columns: Column[] }
  > = {
    suppliers: {
      title: "Proveedores",
      description: "Las personas y empresas que abastecen tu tienda.",
      button: "Nuevo proveedor",
      action: "supplier",
      columns: [
        { key: "name", label: "Proveedor" },
        { key: "email", label: "Correo" },
        { key: "reference", label: "Referencia fiscal" },
      ],
    },
    purchases: {
      title: "Compras de mercancía",
      description: "Registra tus adquisiciones por importe y su pago cuando ya estén liquidadas.",
      button: "Registrar compra",
      action: "purchase",
      columns: [
        { key: "date", label: "Fecha", render: (r) => shortDate(r.date) },
        { key: "reference", label: "Referencia", render: (r) => r.reference || "Sin referencia" },
        { key: "supplier", label: "Proveedor", filterable: true },
        {
          key: "total_cents",
          label: "Total",
          align: "right",
          render: (r) => <Amount value={r.total_cents} cents />,
        },
        {
          key: "paid_cents",
          label: "Pagado",
          align: "right",
          render: (r) => <Amount value={r.paid_cents} cents effect="expense" />,
        },
        {
          key: "status",
          label: "Estado",
          filterable: true,
          render: (r) => (
            <Badge
              tone={
                r.status === "cancelled"
                  ? "neutral"
                  : r.paid_cents === r.total_cents
                    ? "success"
                    : "warning"
              }
            >
              {r.status === "cancelled"
                ? "Cancelada"
                : r.paid_cents === r.total_cents
                  ? "Pagada"
                  : "Pago pendiente"}
            </Badge>
          ),
        },
      ],
    },
    expenses: {
      title: "Gastos operativos",
      description: "Registra los costos de operar la tienda y sus comprobaciones.",
      button: "Registrar gasto",
      action: "expense",
      columns: [
        { key: "date", label: "Fecha", render: (r) => shortDate(r.date) },
        { key: "concept", label: "Concepto" },
        { key: "category", label: "Categoría", filterable: true },
        {
          key: "amount_cents",
          label: "Importe del gasto",
          align: "right",
          render: (r) => <Amount value={r.amount_cents} cents effect="expense" />,
        },
        {
          key: "tax_cents",
          label: "IVA acreditable",
          align: "right",
          render: (r) => <Amount value={r.tax_cents} cents />,
        },
        {
          key: "tax_mode",
          label: "Captura",
          render: (r) =>
            r.tax_mode === "total_no_credit" ? "Total sin IVA acreditable" : "Con desglose",
        },
        {
          key: "paid_cents",
          label: "Pagado",
          align: "right",
          render: (r) => <Amount value={r.paid_cents} cents effect="expense" />,
        },
        {
          key: "payment_status",
          label: "Pago",
          render: (r) =>
            r.status === "cancelled" ? (
              "No aplica"
            ) : (
              <Badge
                tone={
                  new Decimal(r.paid_cents ?? 0).eq(new Decimal(r.amount_cents).plus(r.tax_cents))
                    ? "success"
                    : "warning"
                }
              >
                {new Decimal(r.paid_cents ?? 0).eq(new Decimal(r.amount_cents).plus(r.tax_cents))
                  ? "Pagado"
                  : new Decimal(r.paid_cents ?? 0).gt(0)
                    ? "Pago parcial"
                    : "Pago pendiente"}
              </Badge>
            ),
        },
        {
          key: "kind",
          label: "Tipo",
          render: (r) => <Badge>{r.kind === "asset" ? "Activo" : "Operativo"}</Badge>,
        },
        {
          key: "status",
          label: "Estado",
          filterable: true,
          render: (r) => <Badge>{r.status === "cancelled" ? "Cancelado" : "Activo"}</Badge>,
        },
      ],
    },
    incomes: {
      title: "Ingresos y rentabilidad",
      description: "Importa reportes de Clip y completa costos sin duplicar ventas.",
      button: "Captura consolidada",
      action: "income",
      columns: [
        {
          key: "from_date",
          label: "Periodo",
          render: (r) => (
            <div className="cell-title">
              {shortDate(r.from_date)}
              <small>
                Hasta {shortDate(new Date(Date.parse(r.to_date) - 86400000).toISOString())}
              </small>
            </div>
          ),
        },
        {
          key: "description",
          label: "Concepto",
          render: (r) => (
            <div className="cell-title">
              <strong>{r.description}</strong>
              <small>{r.category ?? "Sin clasificar"}</small>
            </div>
          ),
        },
        {
          key: "source",
          label: "Origen",
          filterable: true,
          render: (r) => <Badge tone="neutral">{sourceLabel(r.source)}</Badge>,
        },
        { key: "method", label: "Método de pago", filterable: true },
        {
          key: "channel",
          label: "Cuenta del cobro",
          render: (r) =>
            (
              ({ cash: "Efectivo", clip: "Clip por liquidar", transfer: "Banco" }) as Record<
                string,
                string
              >
            )[r.channel] ?? r.channel,
        },
        {
          key: "gross_cents",
          label: "Cobro",
          align: "right",
          render: (r) => <Amount value={r.gross_cents} cents effect="income" />,
        },
        {
          key: "clip_base_cents",
          label: "Base Clip",
          align: "right",
          render: (r) => <Amount value={r.clip_base_cents} cents />,
        },
        {
          key: "clip_financing_cents",
          label: "Cargo diferimiento",
          align: "right",
          render: (r) => <Amount value={r.clip_financing_cents} cents effect="expense" />,
        },
        {
          key: "deposited_cents",
          label: "Depósito real",
          align: "right",
          render: (r) => <Amount value={r.deposited_cents} cents effect="income" />,
        },
        {
          key: "card_plan",
          label: "Plazo de tarjeta",
          render: (r) =>
            r.card_plan?.msi
              ? `${r.card_plan.installments ?? "—"} MSI`
              : r.card_plan?.installments > 1
                ? `${r.card_plan.installments} pagos`
                : "Una exhibición",
        },
        {
          key: "settled_at",
          label: "Conciliación",
          render: (r) =>
            r.channel === "cash" || r.source === "manual_summary"
              ? "No aplica"
              : r.settled_at
                ? "Conciliado"
                : "Pendiente",
        },
        {
          key: "net_cents",
          label: "Sin IVA",
          align: "right",
          render: (r) => <Amount value={r.net_cents} cents effect="income" />,
        },
        {
          key: "cogs_cents",
          label: "Costo vendido",
          align: "right",
          render: (r) => <Amount value={r.cogs_cents} cents effect="expense" />,
        },
        {
          key: "fees_cents",
          label: "Comisión",
          align: "right",
          render: (r) =>
            r.fees_cents == null && r.fee_estimate ? (
              <>
                <Amount
                  value={r.fee_estimate.total_cents ?? r.fee_estimate.processing_cents}
                  cents
                  effect="expense"
                />{" "}
                <Badge tone="neutral">
                  {r.fee_needs_apply && r.fee_applied
                    ? "MSI pendiente de aplicar"
                    : r.fee_missing_rule
                      ? "MSI por revisar"
                      : r.fee_applied
                        ? "Aplicada en Clip"
                        : "Estimada"}
                </Badge>
              </>
            ) : (
              <Amount
                value={
                  r.settled_at && r.processing_fee_cents != null
                    ? (
                        BigInt(r.processing_fee_cents) + BigInt(r.financing_withheld_cents ?? 0)
                      ).toString()
                    : r.fees_cents
                }
                cents
                effect="expense"
              />
            ),
        },
        {
          key: "status",
          label: "Estado",
          filterable: true,
          render: (r) => (
            <Badge tone={r.status === "active" ? "success" : "neutral"}>
              {r.status === "active"
                ? "Activo"
                : r.status === "replaced"
                  ? "Reemplazado"
                  : "Cancelado"}
            </Badge>
          ),
        },
      ],
    },
  };
  const refunds = useRows("refunds");
  const c = config[resource]!;
  if (rows.isLoading) return <Loading />;
  const filtered = ["purchases", "expenses", "incomes"].includes(resource)
    ? (rows.data ?? []).filter(
        (r) => (r.date ?? r.from_date) >= from && (r.date ?? r.from_date) < to,
      )
    : (rows.data ?? []);
  const detail = modal && modal !== "new";
  const actionName = detail
    ? resource === "suppliers"
      ? "supplier-update"
      : "complement"
    : c.action;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONTROL FINANCIERO</div>
          <h1>{c.title}</h1>
          <p>{c.description}</p>
        </div>
        <div className="heading-actions">
          <button
            className="button"
            onClick={() => download(resource, from, to).catch((e) => setError(e.message))}
          >
            <Download size={16} /> Exportar
          </button>
          <button
            className="button primary"
            onClick={() => {
              setExpenseTaxMode("total_no_credit");
              setModal("new");
            }}
          >
            <Plus size={17} />
            {c.button}
          </button>
        </div>
      </div>
      {(error || rows.error) && <Notice tone="error">{error || rows.error?.message}</Notice>}
      {resource === "incomes" && (
        <Notice>
          El reporte de transacciones de Clip trae cobros, no detalle de productos.{" "}
          <Link to="/app/importaciones">Importar reporte</Link>. Los datos sin IVA, costo o comisión
          permanecen pendientes hasta documentarlos.
        </Notice>
      )}
      <DataTable
        rows={filtered}
        columns={c.columns}
        empty={
          "Aún no hay " +
          ({
            suppliers: "proveedores",
            purchases: "compras",
            expenses: "gastos",
            incomes: "ingresos",
          }[resource] ?? "registros")
        }
        onRow={
          ["suppliers", "incomes", "purchases", "expenses"].includes(resource)
            ? (r) => setModal(r)
            : undefined
        }
      />
      {resource === "incomes" && (
        <>
          <div className="section-top">
            <h2>Devoluciones registradas</h2>
          </div>
          <DataTable
            rows={(refunds.data ?? []).filter((r) => r.date >= from && r.date < to)}
            columns={[
              { key: "date", label: "Fecha" },
              { key: "description", label: "Venta original" },
              {
                key: "gross_cents",
                label: "Importe con IVA",
                render: (r) => <Amount value={r.gross_cents} cents effect="expense" />,
              },
              {
                key: "net_cents",
                label: "Sin IVA",
                render: (r) => <Amount value={r.net_cents} cents effect="expense" />,
              },
              {
                key: "cogs_cents",
                label: "Costo devuelto",
                render: (r) => <Amount value={r.cogs_cents} cents />,
              },
              { key: "reason", label: "Motivo" },
            ]}
          />
        </>
      )}
      {modal && (
        <Modal
          title={
            detail
              ? resource === "suppliers"
                ? "Editar proveedor"
                : resource === "incomes"
                  ? "Completar datos financieros"
                  : "Detalle del registro"
              : c.button
          }
          onClose={() => setModal(null)}
        >
          {detail && ["purchases", "expenses"].includes(resource) ? (
            <div className="capture">
              {resource === "purchases" && (
                <PurchaseDetail id={modal.id} summary={modal.summary_cost_cents != null} />
              )}
              <dl className="detail-list">
                {Object.entries(modal)
                  .filter(([k]) =>
                    [
                      "date",
                      "reference",
                      "supplier",
                      "concept",
                      "category",
                      "kind",
                      "total_cents",
                      "amount_cents",
                      "tax_cents",
                      "tax_mode",
                      "freight_cents",
                      "paid_cents",
                      "recovered_cents",
                      ...(modal.status === "cancelled" ? ["recoverable_cents"] : []),
                      "notes",
                    ].includes(k),
                  )
                  .map(([k, v]) => (
                    <div key={k}>
                      <dt>
                        {
                          {
                            date: "Fecha",
                            reference: "Referencia",
                            supplier: "Proveedor",
                            concept: "Concepto",
                            category: "Categoría",
                            kind: "Clasificación",
                            total_cents: "Total",
                            amount_cents:
                              modal.tax_mode === "total_no_credit"
                                ? "Total del gasto"
                                : "Importe sin IVA acreditable",
                            tax_mode: "Captura del gasto",
                            tax_cents: "IVA acreditable",
                            freight_cents: "Flete y otros costos",
                            paid_cents: "Pagado",
                            recovered_cents: "Recuperado",
                            recoverable_cents: "Pendiente de recuperar",
                            notes: "Observaciones",
                          }[k]
                        }
                      </dt>
                      <dd>
                        {k === "tax_mode" ? (
                          v === "total_no_credit" ? (
                            "Total sin IVA acreditable"
                          ) : (
                            "Con desglose"
                          )
                        ) : k.endsWith("_cents") ? (
                          <Amount
                            value={String(v)}
                            cents
                            effect={
                              k === "paid_cents"
                                ? "expense"
                                : k === "recovered_cents"
                                  ? "income"
                                  : "neutral"
                            }
                          />
                        ) : (
                          String(v ?? "—")
                        )}
                      </dd>
                    </div>
                  ))}
              </dl>
              {resource === "purchases" && (
                <Capture
                  name="purchase-notes"
                  submit="Guardar observaciones"
                  onSuccess={() => setModal(null)}
                  transform={(v) => ({ id: modal.id, notes: v.notes })}
                >
                  <Field
                    label="Observaciones"
                    hint="Hasta 20,000 caracteres. Los cambios quedan en el historial de auditoría."
                  >
                    <textarea
                      name="notes"
                      defaultValue={modal.notes ?? ""}
                      maxLength={NOTES_MAX_LENGTH}
                      rows={8}
                    />
                  </Field>
                </Capture>
              )}
              {resource === "purchases" && (
                <Capture
                  name="purchase-reference"
                  submit="Guardar referencia"
                  onSuccess={() => setModal(null)}
                  transform={(v) => ({ id: modal.id, reference: v.reference })}
                >
                  <Field
                    label="Factura o referencia única (opcional)"
                    hint="Puedes agregarla, corregirla o dejarla vacía. Los cambios quedan en el historial de auditoría."
                  >
                    <input name="reference" defaultValue={modal.reference ?? ""} maxLength={100} />
                  </Field>
                </Capture>
              )}
              {modal.status === "cancelled" ? (
                <>
                  <Notice>
                    Documento cancelado el {new Date(modal.cancelled_at).toLocaleString("es-MX")}.
                    Motivo: {modal.cancellation_reason}
                  </Notice>
                  {Number(modal.recoverable_cents) > 0 && (
                    <Link
                      className="button"
                      to={
                        "/app/efectivo?tipo=recovery&documento=" +
                        (resource === "purchases" ? "purchase" : "expense")
                      }
                      onClick={() => setModal(null)}
                    >
                      Registrar recuperación de pago
                    </Link>
                  )}
                </>
              ) : (
                <>
                  <DocumentPayment
                    document={modal}
                    resource={resource}
                    onSuccess={() => setModal(null)}
                  />
                  <section className="danger-zone">
                    <h3>{resource === "purchases" ? "Cancelar compra" : "Cancelar gasto"}</h3>
                    <Notice>
                      La cancelación corrige el documento original y se registra en auditoría. Los
                      pagos ya realizados se conservan; registra su recuperación en Efectivo cuando
                      recibas el dinero. Los meses afectados deben estar abiertos.
                    </Notice>
                    <Capture
                      name={resource === "purchases" ? "cancel-purchase" : "cancel-expense"}
                      submit={resource === "purchases" ? "Cancelar compra" : "Cancelar gasto"}
                      transform={(v) => ({ id: modal.id, reason: v.reason })}
                      onSuccess={() => setModal(null)}
                    >
                      <Field label="Motivo de la cancelación">
                        <textarea name="reason" minLength={8} maxLength={1000} required />
                      </Field>
                    </Capture>
                  </section>
                </>
              )}
            </div>
          ) : (
            <>
              {detail && resource === "incomes" && (
                <ClipSettlement income={modal} onSuccess={() => setModal(null)} />
              )}
              <Capture
                name={actionName}
                submit={detail && resource === "suppliers" ? "Guardar cambios" : "Guardar registro"}
                onSuccess={() => setModal(null)}
                transform={(v, form) => {
                  if (resource === "suppliers")
                    return { ...v, ...(detail ? { id: modal.id } : {}) };
                  if (resource === "purchases")
                    return {
                      date: v.date,
                      supplier_id: v.supplier_id,
                      reference: v.reference,
                      freight: v.freight,
                      tax: v.tax,
                      nonrecoverable_tax: v.nonrecoverable_tax,
                      notes: v.notes,
                      merchandise: v.merchandise,
                      lines: [],
                      initial_payment: initialPaymentFromForm(v),
                    };
                  if (resource === "expenses")
                    return {
                      ...v,
                      tax_mode: expenseTaxMode,
                      tax: expenseTaxMode === "total_no_credit" ? "0" : v.tax,
                      recurring: v.recurring === "on",
                      initial_payment: initialPaymentFromForm(v),
                    };
                  if (resource === "incomes") {
                    const b = {
                      ...v,
                      net: v.net || null,
                      cogs: v.cogs || null,
                      fees: v.fees || null,
                      category_id: v.category_id || null,
                    };
                    return detail
                      ? { ...b, id: modal.id }
                      : { ...b, product_id: null, quantity: null };
                  }
                  return v;
                }}
              >
                {resource === "suppliers" && (
                  <div className="form-grid">
                    <Field label="Nombre">
                      <input
                        name="name"
                        required
                        maxLength={150}
                        defaultValue={detail ? modal.name : ""}
                      />
                    </Field>
                    <Field label="Correo">
                      <input
                        name="email"
                        type="email"
                        maxLength={254}
                        defaultValue={detail ? (modal.email ?? "") : ""}
                      />
                    </Field>
                    <Field label="Referencia fiscal (opcional)">
                      <input
                        name="reference"
                        maxLength={100}
                        defaultValue={detail ? (modal.reference ?? "") : ""}
                      />
                    </Field>
                  </div>
                )}
                {resource === "purchases" && (
                  <>
                    <div className="form-grid">
                      <Field label="Fecha">
                        <input name="date" type="date" required defaultValue={today()} />
                      </Field>
                      <Field label="Proveedor">
                        <Select name="supplier_id" rows={suppliers.data ?? []} />
                      </Field>
                      <Field label="Factura o referencia única (opcional)">
                        <input name="reference" maxLength={100} />
                      </Field>
                    </div>
                    <Field
                      label="Importe de mercancía sin IVA recuperable"
                      hint="Total después de descuentos. No se registran existencias aquí."
                    >
                      <MoneyInput name="merchandise" required />
                    </Field>
                    <div className="form-grid">
                      <Field label="Flete sin IVA">
                        <MoneyInput name="freight" defaultValue="0" />
                      </Field>
                      <Field label="IVA acreditable (separado del costo)">
                        <MoneyInput name="tax" defaultValue="0" />
                      </Field>
                      <Field label="Impuestos no recuperables">
                        <MoneyInput name="nonrecoverable_tax" defaultValue="0" />
                      </Field>
                    </div>
                    <Notice>
                      El flete y los impuestos no recuperables forman parte del costo de
                      adquisición. La compra no se considera automáticamente costo vendido.
                    </Notice>
                    <Field label="Observaciones" hint="Hasta 20,000 caracteres.">
                      <textarea name="notes" maxLength={NOTES_MAX_LENGTH} rows={6} />
                    </Field>
                  </>
                )}
                {resource === "expenses" && (
                  <>
                    <Field label="Captura del gasto">
                      <select
                        value={expenseTaxMode}
                        onChange={(e) => setExpenseTaxMode(e.target.value)}
                      >
                        <option value="total_no_credit">Total sin IVA acreditable</option>
                        <option value="itemized">Importe e IVA acreditable por separado</option>
                      </select>
                    </Field>
                    {expenseTaxMode === "total_no_credit" && (
                      <Notice>
                        Captura el importe completo del comprobante, incluidos los impuestos no
                        recuperables. Todo se considera gasto y el IVA acreditable queda en cero.
                        Esto no significa que la operación esté exenta de IVA ni determina su
                        deducibilidad fiscal.
                      </Notice>
                    )}
                    <div className="form-grid">
                      <Field label="Fecha">
                        <input name="date" type="date" required defaultValue={today()} />
                      </Field>
                      <Field label="Categoría">
                        <select name="category">
                          {expenseCategories.map((x) => (
                            <option key={x}>{x}</option>
                          ))}
                        </select>
                      </Field>
                      <Field label="Concepto">
                        <input name="concept" required />
                      </Field>
                      <Field
                        label={
                          expenseTaxMode === "total_no_credit"
                            ? "Total del gasto"
                            : "Importe sin IVA acreditable"
                        }
                      >
                        <MoneyInput name="amount" required />
                      </Field>
                      {expenseTaxMode === "itemized" && (
                        <Field label="IVA acreditable">
                          <MoneyInput name="tax" defaultValue="0" />
                        </Field>
                      )}
                      <Field label="Clasificación">
                        <select name="kind">
                          <option value="operating">Gasto operativo</option>
                          <option value="asset">Activo (excluido de utilidad operativa)</option>
                        </select>
                      </Field>
                    </div>
                    <label className="check">
                      <input type="checkbox" name="recurring" /> Guardar plantilla de gasto mensual
                      recurrente
                    </label>
                    <Field label="Observaciones" hint="Hasta 20,000 caracteres.">
                      <textarea name="notes" maxLength={NOTES_MAX_LENGTH} rows={6} />
                    </Field>
                    <Notice>
                      Marca “Registrar como pagado” para guardar el pago total junto con el gasto.
                      Si queda pendiente o tiene pagos parciales, puedes registrarlos en Efectivo.
                    </Notice>
                  </>
                )}
                {!detail && ["purchases", "expenses"].includes(resource) && <InitialPayment />}
                {resource === "incomes" && (
                  <>
                    {!detail && (
                      <>
                        <div className="form-grid">
                          <Field label="Inicio del periodo">
                            <input name="from" type="date" defaultValue={from} required />
                          </Field>
                          <Field
                            label="Fin del periodo (exclusivo)"
                            hint="Para noviembre completo: 1 de diciembre."
                          >
                            <input name="to" type="date" defaultValue={to} required />
                          </Field>
                          <Field label="Canal">
                            <select name="channel">
                              <option value="clip">Clip</option>
                              <option value="cash">Efectivo</option>
                              <option value="transfer">Transferencia</option>
                              <option value="other">Otro</option>
                            </select>
                          </Field>
                          <Field label="Concepto">
                            <input name="description" required />
                          </Field>
                          <Field label="Importe cobrado con IVA">
                            <MoneyInput name="gross" required />
                          </Field>
                          <Field label="Método de pago">
                            <select name="method">
                              <option>Sin identificar</option>
                              <option>Efectivo</option>
                              <option>SPEI</option>
                              <option>Débito</option>
                              <option>Crédito</option>
                              <option>MSI</option>
                            </select>
                          </Field>
                        </div>
                      </>
                    )}
                    <div className="form-grid">
                      <Field
                        label="Ventas netas sin IVA"
                        hint="Importe fiscal documentado; Net Amount de Clip no equivale a venta sin IVA. Vacío significa desconocido."
                      >
                        <MoneyInput
                          name="net"
                          defaultValue={detail ? amount(modal.net_cents) : ""}
                        />
                      </Field>
                      <Field
                        label="Costo de mercancía vendida"
                        hint="Captura únicamente costos documentados de lo vendido."
                      >
                        <MoneyInput
                          name="cogs"
                          defaultValue={detail ? amount(modal.cogs_cents) : ""}
                        />
                      </Field>
                      {detail && modal.settled_at ? (
                        <Field label="Comisiones conciliadas (sin IVA acreditable)">
                          <input name="fees" value={amount(modal.fees_cents)} readOnly />
                        </Field>
                      ) : (
                        <Field
                          label="Comisión real sin IVA recuperable"
                          hint="Incluye cargos de procesamiento y financiamiento documentados. Vacío significa pendiente; 0 confirma que no hubo comisión."
                        >
                          <MoneyInput
                            name="fees"
                            defaultValue={detail ? amount(modal.fees_cents) : ""}
                          />
                        </Field>
                      )}
                      <Field label="Categoría">
                        <Select
                          name="category_id"
                          rows={categories.data ?? []}
                          optional
                          defaultValue={detail ? (modal.category_id ?? "") : ""}
                        />
                      </Field>
                    </div>
                    <Field label={detail ? "Motivo del complemento" : "Observaciones"}>
                      <textarea
                        name={detail ? "reason" : "notes"}
                        required={detail}
                        minLength={detail ? 5 : undefined}
                        maxLength={detail ? 1000 : NOTES_MAX_LENGTH}
                      />
                    </Field>
                    <Notice>
                      Captura el costo vendido solo cuando lo tengas documentado; no se obtiene del
                      importe de las compras. Un consolidado y los cobros de Clip no pueden
                      contabilizarse sobre la misma cobertura. Un costo desconocido permanece
                      pendiente.
                    </Notice>
                  </>
                )}
              </Capture>
              {detail && resource === "incomes" && modal.status === "active" && (
                <div className="danger-zone">
                  <h3>Registrar devolución de venta</h3>
                  <p>
                    Conserva la venta original y reconoce la devolución en su fecha efectiva. El
                    reembolso de efectivo se registra aparte.
                  </p>
                  <Capture
                    name="refund"
                    submit="Confirmar devolución"
                    onSuccess={() => setModal(null)}
                    transform={(v) => ({
                      ...v,
                      income_id: modal.id,
                      net: v.net || null,
                      cogs: v.cogs || null,
                      quantity: v.quantity || null,
                    })}
                  >
                    <div className="form-grid">
                      <Field label="Fecha de devolución">
                        <input name="date" type="date" required defaultValue={today()} />
                      </Field>
                      <Field label="Importe devuelto con IVA">
                        <MoneyInput name="gross" required />
                      </Field>
                      <Field label="Venta devuelta sin IVA">
                        <MoneyInput name="net" />
                      </Field>
                      <Field
                        label="Costo devuelto"
                        hint="Captura solo el costo documentado de la mercancía devuelta."
                      >
                        <MoneyInput name="cogs" />
                      </Field>
                      {modal.product_id && (
                        <Field label="Unidades que regresan">
                          <input
                            name="quantity"
                            type="number"
                            min="0.000001"
                            step="0.000001"
                            required
                          />
                        </Field>
                      )}
                    </div>
                    <Field label="Motivo documentado">
                      <textarea name="reason" minLength={8} required />
                    </Field>
                  </Capture>
                </div>
              )}
              {detail &&
                resource === "incomes" &&
                modal.source === "manual_summary" &&
                modal.status === "active" &&
                !modal.product_id && (
                  <div className="danger-zone">
                    <h3>Reemplazar por datos de Clip</h3>
                    <p>
                      Retira este consolidado de los totales antes de confirmar las transacciones
                      que cubren el mismo periodo. Conserva el historial.
                    </p>
                    <Capture
                      name="replace-summary"
                      submit="Retirar consolidado"
                      onSuccess={() => setModal(null)}
                      transform={(v) => ({ ...v, id: modal.id })}
                    >
                      <Field label="Motivo obligatorio">
                        <input name="reason" required minLength={8} />
                      </Field>
                    </Capture>
                  </div>
                )}
            </>
          )}
        </Modal>
      )}
    </>
  );
}

function PurchaseDetail({ id, summary }: { id: string; summary: boolean }) {
  const detail = useQuery<any[]>({
    queryKey: ["purchase-detail", id],
    queryFn: () => api("/detail/purchases/" + id),
  });
  if (summary)
    return (
      <Notice>
        Compra registrada por importe total. El costo de lo vendido se documenta por separado.
      </Notice>
    );
  return (
    <DataTable
      rows={detail.data ?? []}
      columns={[
        { key: "sku", label: "SKU" },
        { key: "name", label: "Producto" },
        { key: "quantity", label: "Unidades" },
        {
          key: "unit_cost",
          label: "Costo unitario",
          render: (r) => new Decimal(r.unit_cost).toFixed(6),
        },
        { key: "cost_cents", label: "Costo con prorrateo", render: (r) => money(r.cost_cents) },
      ]}
    />
  );
}
