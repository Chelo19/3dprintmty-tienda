import { Amount, MoneyLegend } from "../components/Amount";
import { FiscalCards } from "./tax";
import { FeeRuleFields } from "./fee-rule-fields";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Download, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import { NOTES_MAX_LENGTH, type Report } from "@tienda/shared";
import { monthBounds, Decimal, defaultCardFeeRule } from "@tienda/domain";
import { api, download } from "../lib/api";
import { money, today, shortDate } from "../lib/format";
import { useRows, Select } from "./records";
import {
  Notice,
  Field,
  Capture,
  MoneyInput,
  DataTable,
  Modal,
  Badge,
  Loading,
} from "../components/ui";
export function Cash({ from, to }: { from: string; to: string }) {
  const [params] = useSearchParams();
  const accounts = useRows("accounts"),
    rows = useRows("cash"),
    purchases = useRows("purchases"),
    expenses = useRows("expenses"),
    incomes = useRows("incomes");
  const [open, setOpen] = useState(params.get("tipo") === "recovery"),
    [kind, setKind] = useState(params.get("tipo") === "recovery" ? "recovery" : "purchase"),
    [recoveryType, setRecoveryType] = useState(
      params.get("documento") === "expense" ? "expense" : "purchase",
    ),
    [error, setError] = useState("");
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ENTRADAS Y SALIDAS REALES</div>
          <h1>Efectivo y cuentas</h1>
          <p>Cobrar, pagar y liquidar son movimientos distintos de reconocer ingresos y gastos.</p>
        </div>
        <div className="heading-actions">
          <button
            className="button"
            onClick={() => download("cash", from, to).catch((e) => setError(e.message))}
          >
            <Download size={16} /> Exportar
          </button>
          <button className="button primary" onClick={() => setOpen(true)}>
            <Plus size={16} /> Registrar movimiento
          </button>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <MoneyLegend />
      <div className="kpi-grid three">
        {accounts.data?.map((a) => (
          <article className="kpi" key={a.id}>
            <div className="kpi-label">
              {a.name}
              <Wallet size={18} />
            </div>
            <strong>
              <Amount value={a.balance_cents} cents />
            </strong>
            <small>
              {a.kind === "pending"
                ? "Saldo en Clip · comisiones calculadas según tarifa"
                : "Saldo disponible actual"}
            </small>
          </article>
        ))}
      </div>
      <Notice>
        Las nuevas ventas importadas registran su cobro automáticamente: Efectivo en Efectivo,
        Tarjeta en Clip por liquidar, descontando por separado su comisión configurada con IVA, y
        Transferencia en Banco. Las existentes se omiten al reimportar. Cuando retires dinero de
        Clip por SPEI, registra una Transferencia entre cuentas / SPEI con origen Clip y destino
        Banco, por el importe y fecha reales. Puede incluir varias ventas y no genera un ingreso ni
        otra comisión. No necesitas conciliar cada cobro; compara los saldos al cierre del mes.
      </Notice>
      <DataTable
        rows={(rows.data ?? []).filter((r) => r.date >= from && r.date < to)}
        columns={[
          { key: "date", label: "Fecha", render: (r) => shortDate(r.date) },
          { key: "account", label: "Cuenta", filterable: true },
          {
            key: "kind",
            label: "Movimiento",
            render: (r) =>
              (
                ({
                  recovery: "Recuperación de pago",
                  collection: "Cobro",
                  transfer: "Transferencia",
                  clip_fee: "Cargos retenidos Clip",
                  clip_fee_estimate: "Comisión de tarjeta aplicada",
                  clip_msi_fee_estimate: "Comisión MSI aplicada",
                  clip_fee_adjustment: "Ajuste de comisión Clip",
                }) as Record<string, string>
              )[r.kind] ?? r.kind,
          },
          { key: "notes", label: "Referencia / concepto" },
          {
            key: "amount_cents",
            label: "Importe",
            align: "right",
            render: (r) => <Amount value={r.amount_cents} cents effect="signed" showSign />,
          },
        ]}
      />
      {open && (
        <Modal title="Registrar movimiento de efectivo" onClose={() => setOpen(false)}>
          <Capture
            name="cash"
            onSuccess={() => setOpen(false)}
            transform={(v) => Object.fromEntries(Object.entries(v).filter(([, val]) => val !== ""))}
          >
            <div className="form-grid">
              <Field label="Fecha efectiva">
                <input type="date" name="date" defaultValue={today()} required />
              </Field>
              <Field label="Tipo">
                <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)}>
                  <option value="purchase">Pago a proveedor</option>
                  <option value="expense">Pago de gasto / activo</option>
                  <option value="collection">Cobro de ingreso</option>
                  <option value="transfer">Transferencia entre cuentas / SPEI</option>
                  <option value="refund">Devolución de efectivo a cliente</option>
                  <option value="recovery">Recuperación de compra / gasto cancelado</option>
                  <option value="contribution">Aporte de capital</option>
                  <option value="withdrawal">Retiro de capital</option>
                </select>
              </Field>
              <Field label="Cuenta origen / receptora">
                <Select name="account_id" rows={accounts.data ?? []} />
              </Field>
              <Field label="Importe">
                <MoneyInput name="amount" required />
              </Field>
              {kind === "recovery" && (
                <Field label="Documento cancelado">
                  <select value={recoveryType} onChange={(e) => setRecoveryType(e.target.value)}>
                    <option value="purchase">Compra</option>
                    <option value="expense">Gasto</option>
                  </select>
                </Field>
              )}
              {kind === "transfer" && (
                <Field label="Cuenta destino">
                  <Select name="destination" rows={accounts.data ?? []} />
                </Field>
              )}
              {(kind === "purchase" || (kind === "recovery" && recoveryType === "purchase")) && (
                <Field label="Compra">
                  <Select
                    name="purchase_id"
                    rows={(purchases.data ?? [])
                      .filter((p) =>
                        kind === "recovery"
                          ? p.status === "cancelled" && Number(p.recoverable_cents) > 0
                          : p.status !== "cancelled",
                      )
                      .map((p) => ({
                        ...p,
                        name: `${p.reference} · ${p.supplier} · ${money(p.total_cents)} total`,
                      }))}
                  />
                </Field>
              )}
              {(kind === "expense" || (kind === "recovery" && recoveryType === "expense")) && (
                <Field label="Gasto">
                  <Select
                    name="expense_id"
                    rows={(expenses.data ?? [])
                      .filter((p) =>
                        kind === "recovery"
                          ? p.status === "cancelled" && Number(p.recoverable_cents) > 0
                          : p.status !== "cancelled",
                      )
                      .map((p) => ({
                        ...p,
                        name: p.concept + " · " + money(p.amount_cents),
                      }))}
                  />
                </Field>
              )}
              {["collection", "refund"].includes(kind) && (
                <Field label="Ingreso relacionado">
                  <Select
                    name="income_id"
                    rows={(incomes.data ?? [])
                      .filter((i) =>
                        kind === "refund"
                          ? i.status !== "replaced"
                          : i.status === "active" && !i.import_collection_id && !i.settled_at,
                      )
                      .map((p) => ({ ...p, name: p.description + " · " + money(p.gross_cents) }))}
                    optional={kind === "refund"}
                  />
                </Field>
              )}
            </div>
            {kind === "recovery" && (
              <Notice>
                Registra la entrada de dinero únicamente cuando se haya recibido el reembolso. No
                crea ventas ni vuelve a modificar el gasto o la compra cancelados.
              </Notice>
            )}
            <Field label="Referencia y observaciones" hint="Hasta 20,000 caracteres.">
              <textarea name="notes" required maxLength={NOTES_MAX_LENGTH} rows={6} />
            </Field>
          </Capture>
        </Modal>
      )}
    </>
  );
}
export function Reports({ from, to }: { from: string; to: string }) {
  const report = useQuery({
    queryKey: ["report", from, to],
    queryFn: () => api<Report>(`/report?from=${from}&to=${to}`),
  });
  const [error, setError] = useState("");
  if (!report.data)
    return report.error ? <Notice tone="error">{report.error.message}</Notice> : <Loading />;
  const r = report.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">LISTO PARA CONSOLIDAR EN EXCEL</div>
          <h1>Reportes financieros</h1>
          <p>Datos de la tienda, con columnas estables y cobertura visible.</p>
        </div>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      <Notice>
        Las compras no equivalen al costo de lo vendido. Si faltan costos documentados, la utilidad
        queda pendiente. Las existencias se administran fuera de este sistema.
      </Notice>
      <section className="panel">
        <div className="panel-heading">
          <h2>Estado de resultados</h2>
          <div className="heading-actions">
            {["xlsx", "csv"].map((f) => (
              <button
                key={f}
                className="button"
                onClick={() => download("monthly", from, to, f).catch((e) => setError(e.message))}
              >
                <Download size={16} />
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
        <div className="statement">
          {[
            ["Ventas netas", r.sales],
            ["Costo vendido", r.cogs],
            ["Utilidad bruta", r.gross],
            ["Comisiones", r.fees],
            ["Margen de contribución", r.contribution],
            ["Gastos operativos", r.expenses],
            ["Resultado operativo", r.operating],
            ["Flujo de efectivo disponible", r.cash],
          ].map(([name, m]: any) => (
            <div key={name}>
              <span>{name}</span>
              <Badge tone={m.status === "completo" ? "success" : "warning"}>{m.status}</Badge>
              <strong>
                <Amount
                  value={m.value}
                  effect={
                    ["Costo vendido", "Comisiones", "Gastos operativos"].includes(name)
                      ? "expense"
                      : name === "Ventas netas"
                        ? "income"
                        : "signed"
                  }
                />
              </strong>
            </div>
          ))}
        </div>
      </section>
      <FiscalCards report={r} />
      <div className="section-top">
        <h2>Exportar detalle</h2>
      </div>
      <div className="export-grid">
        {[
          ["categories", "Ventas por categoría"],
          ["purchases", "Compras"],
          ["expenses", "Gastos"],
          ["incomes", "Ingresos y costos"],
          ["cash", "Flujo de efectivo"],
        ].map(([key, label]) => (
          <section className="panel" key={key}>
            <FileLabel />
            <h3>{label}</h3>
            <div className="heading-actions">
              {["xlsx", "csv"].map((f) => (
                <button
                  key={f}
                  className="button"
                  onClick={() => download(key!, from, to, f).catch((e) => setError(e.message))}
                >
                  {f.toUpperCase()}
                  <Download size={14} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <Notice>
        Los datos desconocidos se exportan vacíos, con estado y observaciones. Los reportes no
        consolidan otros negocios ni sustituyen contabilidad fiscal.
      </Notice>
    </>
  );
}
function FileLabel() {
  return <div className="eyebrow">REPORTE EXPORTABLE</div>;
}
const legacyChecks = [
  "Ventas registradas o importadas",
  "Devoluciones y cancelaciones revisadas",
  "Comisiones verificadas",
  "Compras de mercancía completas",
  "Costo vendido documentado",
  "Costos de ventas contrastados con documentos externos",
  "Gastos operativos completos",
  "Pagos pendientes revisados",
  "Cobros y depósitos conciliados",
  "Diferencias resueltas",
];
export function Closes() {
  const [month, setMonth] = useState(today().slice(0, 7)),
    [selected, setSelected] = useState<any>(null);
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api("/settings") });
  const financial = settings.data?.inventory_mode === "external";
  const checks = financial
    ? [
        "Ingresos, compras, gastos y SPEI del mes registrados",
        "Saldos de Efectivo, Clip y Banco comparados con los saldos reales",
        "Diferencias revisadas y pendientes fiscales identificados",
      ]
    : legacyChecks;
  const rows = useRows("closes");
  const audit = useRows("audit");
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CIERRA CON INFORMACIÓN CONFIABLE</div>
          <h1>Cierre mensual</h1>
          <p>Revisa el mes, conserva su resultado y registra cualquier reapertura.</p>
        </div>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Revisión del periodo</h2>
          <input
            aria-label="Mes de cierre"
            type="month"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          />
        </div>
        <Capture
          name="close"
          onSuccess={() => setSelected({ done: true })}
          transform={(_v, form) => ({
            month,
            checklist: checks.map(
              (_c, i) => (form.elements.namedItem("check" + i) as HTMLInputElement).checked,
            ),
          })}
          submit="Confirmar cierre mensual"
        >
          <div className="checklist">
            {checks.map((c, i) => (
              <label className="check" key={c}>
                <input type="checkbox" name={"check" + i} required />
                <span>
                  <small>{String(i + 1).padStart(2, "0")}</small>
                  {c}
                </span>
              </label>
            ))}
          </div>
          <Notice>
            {financial
              ? "El cierre revisa movimientos y saldos. No exige costo vendido ni conciliar cada venta. Los impuestos conservan sus pendientes de comprobación."
              : "El cierre se bloquea si los cálculos tienen datos financieros faltantes."}{" "}
            Una vez cerrado, se debe reabrir el mes para modificarlo.
          </Notice>
        </Capture>
        {selected?.done && <Notice tone="success">Cierre mensual guardado.</Notice>}
      </section>
      <DataTable
        rows={rows.data ?? []}
        columns={[
          { key: "month", label: "Mes" },
          {
            key: "status",
            label: "Estado",
            render: (r) => (
              <Badge tone={r.status === "closed" ? "success" : "warning"}>
                {r.status === "closed" ? "Cerrado" : "Reabierto"}
              </Badge>
            ),
          },
          { key: "version", label: "Versión" },
          {
            key: "created_at",
            label: "Fecha",
            render: (r) => new Date(r.created_at).toLocaleString("es-MX"),
          },
        ]}
        onRow={(r) => setSelected(r)}
      />
      <div className="section-top">
        <h2>Historial de ajustes y acciones</h2>
      </div>
      <DataTable
        rows={audit.data ?? []}
        columns={[
          {
            key: "created_at",
            label: "Fecha",
            render: (r) => new Date(r.created_at).toLocaleString("es-MX"),
          },
          { key: "actor", label: "Autor" },
          { key: "entity", label: "Entidad" },
          { key: "action", label: "Acción" },
          { key: "reason", label: "Motivo" },
        ]}
      />
      {selected?.month && (
        <Modal title={"Cierre " + selected.month} onClose={() => setSelected(null)}>
          <div className="capture">
            <div className="section-top">
              <h3>Resultado guardado · versión {selected.version}</h3>
              <Badge>{selected.month}</Badge>
            </div>
            <div className="statement">
              {(selected.snapshot.inventoryMode === "external"
                ? [
                    ["Cobros registrados", selected.snapshot.collected],
                    ["Compras pagadas", selected.snapshot.sourceSummary?.purchases_paid],
                    ["Gastos y activos pagados", selected.snapshot.sourceSummary?.expenses_paid],
                    ["Flujo disponible", selected.snapshot.cash],
                  ]
                : [
                    ["Ventas netas", selected.snapshot.sales],
                    ["Costo vendido", selected.snapshot.cogs],
                    ["Utilidad bruta", selected.snapshot.gross],
                    ["Comisiones", selected.snapshot.fees],
                    ["Gastos operativos", selected.snapshot.expenses],
                    ["Resultado operativo", selected.snapshot.operating],
                    ["Flujo disponible", selected.snapshot.cash],
                  ]
              ).map(([label, m]: any) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>
                    <Amount
                      value={m?.value}
                      effect={
                        [
                          "Costo vendido",
                          "Comisiones",
                          "Gastos operativos",
                          "Compras pagadas",
                          "Gastos y activos pagados",
                        ].includes(label)
                          ? "expense"
                          : label === "Ventas netas" || label === "Cobros registrados"
                            ? "income"
                            : "signed"
                      }
                    />
                  </strong>
                </div>
              ))}
            </div>
            {selected.status === "closed" && (
              <Capture
                name="reopen"
                onSuccess={() => setSelected(null)}
                transform={(v) => ({ ...v, month: selected.month })}
                submit="Reabrir mes"
              >
                <Field label="Motivo de reapertura">
                  <textarea name="reason" required minLength={8} />
                </Field>
              </Capture>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
export function Settings() {
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api("/settings") }),
    categories = useRows("categories"),
    fees = useRows("fee-rules"),
    templates = useRows("templates");
  const [open, setOpen] = useState(""),
    [saved, setSaved] = useState(false);
  const [feeEditor, setFeeEditor] = useState<{ method: string; installments?: number | null }>();
  const s = settings.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">BASES DE TU OPERACIÓN</div>
          <h1>Configuración de la tienda</h1>
          <p>Una tienda, un propietario y tus reglas financieras.</p>
        </div>
      </div>
      <div className="dashboard-columns">
        <section className="panel">
          <div className="panel-heading">
            <h2>Acceso e integración</h2>
            <ShieldCheck size={20} />
          </div>
          <dl className="detail-list">
            <div>
              <dt>Propietario</dt>
              <dd>{s?.owner_email}</dd>
            </div>
            <div>
              <dt>Base de datos</dt>
              <dd>{s?.database === "pglite" ? "PGlite local" : "PostgreSQL / Supabase"}</dd>
            </div>
            <div>
              <dt>Zona horaria</dt>
              <dd>America/Monterrey · MXN</dd>
            </div>
          </dl>
          <p className="muted tiny">
            Las credenciales se configuran en el servidor. Nunca se muestran en esta pantalla.
          </p>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Saldos de apertura</h2>
            <Wallet size={20} />
          </div>
          <p>
            {s?.opening_done
              ? `Apertura registrada: ${shortDate(s.opening_date)}.`
              : "Establece la fecha de inicio y tus saldos de efectivo, banco y Clip."}
          </p>
          {s?.opening_done ? (
            <>
              <Badge tone="success">Apertura registrada</Badge>
            </>
          ) : (
            <button className="button primary" onClick={() => setOpen("opening")}>
              Registrar apertura <Plus size={16} />
            </button>
          )}
          <p className="tiny muted">
            Los saldos iniciales no se reconocen como ingresos ni gastos del periodo.
          </p>
        </section>
      </div>
      <section className="panel">
        <div className="panel-heading">
          <h2>Categorías financieras</h2>
          <button className="button" onClick={() => setOpen("category")}>
            <Plus size={16} /> Agregar
          </button>
        </div>
        <div className="tags">
          {categories.data?.map((c) => (
            <Badge key={c.id}>{c.name}</Badge>
          ))}
        </div>
      </section>
      <div className="section-top">
        <h2>Reglas de comisión por método</h2>
        <button
          className="button"
          onClick={() => {
            setFeeEditor(undefined);
            setOpen("fee-rule");
          }}
        >
          <Plus size={16} /> Configurar
        </button>
      </div>
      <DataTable
        rows={fees.data ?? []}
        columns={[
          {
            key: "method",
            label: "Método",
            render: (r) => (
              <>
                {r.method}{" "}
                {defaultCardFeeRule(fees.data ?? [])?.method === r.method && (
                  <Badge tone="neutral">Predeterminada para tarjetas</Badge>
                )}
              </>
            ),
          },
          { key: "percent", label: "Comisión %" },
          { key: "fixed_cents", label: "Fija", render: (r) => money(r.fixed_cents) },
          { key: "tax_percent", label: "IVA comisión %" },
          { key: "msi_percent", label: "Adicional MSI %" },
          {
            key: "installments",
            label: "Plazo",
            render: (r) =>
              r.method === "MSI"
                ? r.installments
                  ? `${r.installments} meses`
                  : "Sin plazo · revisar"
                : "—",
          },
          {
            key: "edit_fee",
            label: "",
            render: (r) => (
              <button
                className="text-button"
                onClick={() => {
                  setFeeEditor({ method: r.method, installments: r.installments });
                  setOpen("fee-rule");
                }}
              >
                Editar tarifa{r.installments ? ` MSI ${r.installments} meses` : ""}
              </button>
            ),
          },
        ]}
      />
      <Notice>
        La tarifa Tarjeta se aplica por defecto a débito y crédito. Si solo hay una tarifa de Débito
        o Crédito, se usa para ambas. Se calculan la comisión y su IVA según la tarifa configurada,
        sin conciliación por venta. Al importar se descuenta la comisión con IVA de Clip,
        conservando el cobro bruto. En MSI se agrega el recargo del plazo exacto indicado en el CSV.
        Si no está configurado, queda pendiente para revisión. El depósito a Banco se confirma por
        separado.
      </Notice>
      <div className="section-top">
        <h2>Gastos recurrentes</h2>
        <button className="button" onClick={() => setOpen("recurring")}>
          Generar gasto del mes
        </button>
      </div>
      <DataTable
        rows={templates.data ?? []}
        columns={[
          { key: "concept", label: "Concepto" },
          { key: "category", label: "Categoría" },
          { key: "amount_cents", label: "Importe del gasto", render: (r) => money(r.amount_cents) },
          {
            key: "tax_mode",
            label: "Captura",
            render: (r) =>
              r.tax_mode === "total_no_credit" ? "Total sin IVA acreditable" : "Con desglose",
          },
        ]}
      />
      {saved && <Notice tone="success">Configuración guardada.</Notice>}
      {open && (
        <Modal
          title={
            {
              opening: "Apertura de la tienda",
              category: "Nueva categoría",
              "fee-rule": "Regla de comisión",
              recurring: "Generar gasto recurrente",
            }[open] ?? ""
          }
          onClose={() => setOpen("")}
        >
          <Capture
            name={open}
            onSuccess={() => {
              setOpen("");
              setSaved(true);
            }}
            transform={(v) =>
              open === "opening"
                ? {
                    date: v.date,
                    cash: v.cash,
                    bank: v.bank,
                    clip: v.clip,
                    inventory_mode: "external",
                    lines: [],
                  }
                : open === "category"
                  ? { ...v, parent_id: v.parent_id || null }
                  : v
            }
          >
            {open === "opening" && (
              <>
                <div className="form-grid">
                  <Field label="Fecha de inicio">
                    <input name="date" type="date" defaultValue={today()} required />
                  </Field>
                  <Field label="Saldo en efectivo">
                    <MoneyInput name="cash" defaultValue="0" required />
                  </Field>
                  <Field label="Saldo en banco">
                    <MoneyInput name="bank" defaultValue="0" required />
                  </Field>
                  <Field label="Clip por liquidar">
                    <MoneyInput name="clip" defaultValue="0" required />
                  </Field>
                </div>
                <Notice>
                  Las existencias se administran fuera de este sistema. No necesitas registrar
                  productos ni inventario inicial.
                </Notice>
              </>
            )}
            {open === "category" && (
              <>
                <Field label="Nombre">
                  <input name="name" required />
                </Field>
                <Field label="Categoría superior (opcional)">
                  <Select name="parent_id" rows={categories.data ?? []} optional />
                </Field>
              </>
            )}
            {open === "fee-rule" && <FeeRuleFields rules={fees.data ?? []} initial={feeEditor} />}
            {open === "recurring" && (
              <>
                <Field label="Plantilla">
                  <Select name="template_id" rows={templates.data ?? []} label="concept" />
                </Field>
                <Field label="Fecha de devengo">
                  <input name="date" type="date" defaultValue={today()} required />
                </Field>
                <Notice>
                  Se genera un gasto por plantilla y mes. Generarlo no significa pagarlo.
                </Notice>
              </>
            )}
          </Capture>
        </Modal>
      )}
    </>
  );
}
