import { Amount } from "../components/Amount";
import { inferImportPaymentType, type ImportPaymentType } from "@tienda/shared";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet, ArrowRight, CheckCircle2, Upload, XCircle } from "lucide-react";
import { api, action } from "../lib/api";
import { mxn, sourceLabel } from "../lib/format";
import { useRows } from "./records";
import { Badge, DataTable, Notice, Field } from "../components/ui";
const importStatus = (status: string) =>
  ({ preview: "Sin confirmar", confirmed: "Confirmado", rejected: "Rechazado" })[status] ?? status;
export function Imports() {
  const client = useQueryClient();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api("/settings") });
  const history = useRows("imports");
  const [file, setFile] = useState<any>(null),
    [paymentTypes, setPaymentTypes] = useState<Record<string, ImportPaymentType>>({}),
    [statusDecisions, setStatusDecisions] = useState<Record<string, string>>({}),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [batch, setBatch] = useState<any>(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [success, setSuccess] = useState(""),
    [assumePaid, setAssumePaid] = useState(false),
    [rejectionReason, setRejectionReason] = useState("");
  const work = async (name: string, fn: () => Promise<any>) => {
    setBusy(name);
    if (["file", "preview", "load"].includes(name)) setPaymentTypes({});
    if (name !== "reject") setRejectionReason("");
    setError("");
    setSuccess("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  const fields = [
    ["external_id", "ID de transacción *"],
    ["date", "Fecha YYYY-MM-DD *"],
    ["gross", "Importe cobrado con IVA *"],
    ["net", "Venta sin IVA"],
    ["cogs", "Costo vendido"],
    ["fees", "Comisión real sin IVA"],
    ["method", "Método de pago"],
    ["status", "Estado"],
    ["description", "Concepto"],
  ];
  const auto = (headers: string[]) =>
    Object.fromEntries(
      fields.map(([key]) => [
        key!,
        headers.find((h) =>
          (
            ({
              external_id: ["receipt_no", "id", "id_transaccion"],
              date: ["fecha", "date"],
              gross: ["importe", "amount", "total", "cobro"],
              net: ["venta_sin_iva", "net"],
              cogs: ["costo", "cogs"],
              fees: ["comision", "fees"],
              method: ["metodo", "payment_method"],
              status: ["estado", "status"],
              description: ["concepto", "description"],
            })[key!] ?? []
          ).includes(h.toLowerCase()),
        ) ?? "",
      ]),
    );
  const statusGroups =
    file?.profile === "clip_report"
      ? Array.from(
          new Set<string>(
            file.rows.map((r: any) =>
              String(r["Payment Status"] ?? "")
                .trim()
                .toLowerCase(),
            ),
          ),
        )
          .filter((status) => status !== "approved")
          .map((status) => {
            const rows = file.rows.filter(
              (r: any) =>
                String(r["Payment Status"] ?? "")
                  .trim()
                  .toLowerCase() === status,
            );
            return {
              status,
              count: rows.length,
              total: rows.reduce((sum: number, r: any) => sum + (Number(r["Paid Amount"]) || 0), 0),
            };
          })
      : [];
  const unresolvedStatuses = statusGroups.some(
    ({ status }) => !Object.hasOwn(statusDecisions, status) || !statusDecisions[status],
  );
  const selectedType = (row: any) =>
    Object.hasOwn(paymentTypes, row.external_id)
      ? paymentTypes[row.external_id]
      : (row.payment_type ?? inferImportPaymentType(row.method ?? ""));
  const missingPaymentType = batch?.rows.some((r: any) => !r.duplicate && !selectedType(r));
  const confirmBlock = busy
    ? "Espera a que termine la operación en curso."
    : settings.isError
      ? "No se pudo consultar la apertura. Vuelve a cargar la página para intentarlo de nuevo."
      : !settings.data
        ? "Consultando los saldos de apertura…"
        : !settings.data.opening_done
          ? "Para confirmar el lote, registra primero la fecha de inicio y los saldos en Configuración → Saldos de apertura."
          : batch?.errors.length
            ? "Corrige los errores del lote antes de confirmar."
            : batch && !batch.rows.length
              ? "El lote no tiene transacciones para confirmar."
              : missingPaymentType
                ? "Selecciona el tipo de pago de cada transacción nueva antes de confirmar."
                : "";
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONECTA TU INFORMACIÓN</div>
          <h1>Datos de Clip</h1>
          <p>Importa el reporte de Clip con todas tus ventas en efectivo y tarjeta.</p>
        </div>
        <Badge tone="blue">Efectivo y tarjeta</Badge>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {success && <Notice tone="success">{success}</Notice>}
      {settings.data && !settings.data.opening_done && (
        <Notice>
          Puedes cargar archivos y revisar los datos antes de registrar la apertura. Para confirmar
          ingresos, registra primero la fecha de inicio, los saldos en{" "}
          <Link to="/app/configuracion">Configuración → Saldos de apertura</Link>.
        </Notice>
      )}
      <div className="import-upload">
        <section className="panel integration-card">
          <div className="integration-logo secondary">
            <FileSpreadsheet size={28} />
          </div>
          <Badge>FUENTE PRINCIPAL</Badge>
          <h2>Importar CSV o Excel</h2>
          <p>
            El reporte de Clip se reconoce automáticamente. Los folios y los IDs de pago y
            transacción evitan duplicados entre archivos.
          </p>
          <label className="upload-box">
            <Upload size={20} />
            <span>{file?.filename ?? "Seleccionar archivo .csv o .xlsx"}</span>
            <small>Hasta 3 MB · 10,000 filas · valores sin fórmulas</small>
            <input
              aria-label="Seleccionar archivo CSV o Excel"
              type="file"
              accept=".csv,.xlsx"
              disabled={!!busy}
              onChange={(e) => {
                const chosen = e.target.files?.[0];
                setBatch(null);
                setStatusDecisions({});
                setFile(null);
                if (chosen)
                  void work("file", async () => {
                    const form = new FormData();
                    form.append("file", chosen);
                    const result = await api("/imports/read", { method: "POST", body: form });
                    setFile(result);
                    setMapping(auto(result.headers));
                    setBatch(null);
                  });
              }}
            />
          </label>
        </section>
      </div>
      <Notice>
        Los cobros no incluyen artículos vendidos ni costos. Se conserva el desglose de importe
        base, propina y cargo por diferimiento. Paid Amount es el total cobrado; Net Amount no es
        venta sin IVA ni depósito confirmado. Con el perfil fiscal confirmado, las ventas ordinarias
        se desglosan al 16% de IVA incluido. Los cobros con propinas o diferimiento adicional
        requieren comprobación fiscal. No se infieren márgenes a partir del total cobrado.
      </Notice>
      {file && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>
                {file.profile === "clip_report"
                  ? "Reporte de Clip reconocido"
                  : "Relacionar columnas"}
              </h2>
              <p>
                {file.filename} · {file.rows.length} filas
              </p>
            </div>
          </div>
          {file.profile === "clip_report" ? (
            <Notice>
              Se leerán las fechas en hora de Monterrey, el importe pagado, el método y el estado de
              cada transacción. No necesitas relacionar columnas. Los cobros con devoluciones
              requieren conciliación antes de importarse.
            </Notice>
          ) : (
            <>
              <div className="form-grid three">
                {fields.map(([key, label]) => (
                  <Field key={key} label={label!}>
                    <select
                      value={mapping[key!] ?? ""}
                      onChange={(e) => setMapping({ ...mapping, [key!]: e.target.value })}
                    >
                      <option value="">Sin columna</option>
                      {file.headers.map((h: string) => (
                        <option key={h}>{h}</option>
                      ))}
                    </select>
                  </Field>
                ))}
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={assumePaid}
                  onChange={(e) => setAssumePaid(e.target.checked)}
                />{" "}
                Confirmo que las filas sin estado corresponden a cobros pagados.
              </label>
            </>
          )}
          {statusGroups.length > 0 && (
            <div>
              <h3>Revisar estatus distintos de approved</h3>
              <Notice>
                Approved se incluye automáticamente. Decide qué hacer con cada estatus restante.
                Incluir un estatus lo considera un cobro activo, excepto cancelled y canceled, que
                se registran como cancelados y no suman ingresos. Excluir conserva los registros que
                ya existan en el sistema. Los cobros con devoluciones siguen requiriendo
                conciliación.
              </Notice>
              {statusGroups.map(({ status, count, total }) => (
                <Field
                  key={status}
                  label={`${status || "Sin estatus"} · ${count} transacciones · ${mxn(total)}`}
                >
                  <select
                    aria-label={`Decisión para ${status || "Sin estatus"}`}
                    value={Object.hasOwn(statusDecisions, status) ? statusDecisions[status] : ""}
                    disabled={!!busy}
                    onChange={(e) => {
                      setStatusDecisions({ ...statusDecisions, [status]: e.target.value });
                      setBatch(null);
                    }}
                  >
                    <option value="">Selecciona una decisión</option>
                    <option value="include">
                      {["cancelled", "canceled"].includes(status)
                        ? "Incluir como cancelados"
                        : "Incluir como cobros activos"}
                    </option>
                    <option value="exclude">Excluir del lote</option>
                  </select>
                </Field>
              ))}
            </div>
          )}
          <div className="action-row">
            <button
              className="button primary"
              disabled={
                !!busy ||
                unresolvedStatuses ||
                (file.profile !== "clip_report" &&
                  (!mapping.external_id || !mapping.date || !mapping.gross))
              }
              onClick={() =>
                work("preview", async () =>
                  setBatch(
                    await api("/imports/preview", {
                      method: "POST",
                      body: JSON.stringify({
                        ...file,
                        mapping,
                        assume_paid: assumePaid,
                        status_decisions: statusDecisions,
                      }),
                    }),
                  ),
                )
              }
            >
              Validar y previsualizar <ArrowRight size={16} />
            </button>
          </div>
        </section>
      )}
      {batch && (
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Vista previa del lote</h2>
              <p>
                {batch.filename} · {sourceLabel(batch.source)}
              </p>
            </div>
            <Badge tone={batch.status === "confirmed" ? "success" : "warning"}>
              {importStatus(batch.status)}
            </Badge>
          </div>
          {batch.status === "rejected" && (
            <Notice>
              Este lote fue rechazado
              {batch.rejected_at
                ? " el " + new Date(batch.rejected_at).toLocaleString("es-MX")
                : ""}
              . No se aplicaron sus datos.{" "}
              {batch.rejection_reason && <>Motivo: {batch.rejection_reason}. </>}Puedes cargar de
              nuevo el archivo para revisarlo en otro lote.
            </Notice>
          )}
          <div className="preview-summary">
            <div>
              <span>Transacciones</span>
              <strong>{batch.rows.length}</strong>
            </div>
            <div>
              <span>Existentes (no se duplican)</span>
              <strong>{batch.duplicates}</strong>
            </div>
            <div>
              <span>Errores</span>
              <strong>{batch.errors.length}</strong>
            </div>
            <div>
              <span>Importe de ventas nuevas activas</span>
              <strong>
                <Amount value={batch.total} effect="income" />
              </strong>
            </div>
          </div>
          <p className="tiny muted">
            Nuevas: {batch.new_count} · Existentes que se omiten: {batch.duplicates}.<br />
            Las ventas existentes y sus movimientos son inmutables al reimportar, aunque el CSV
            cambie sus importes, estado o tipo de pago. El importe mostrado corresponde únicamente a
            ventas nuevas. Las canceladas no generan cobros.
          </p>
          {batch.errors.length > 0 && (
            <Notice tone="error">
              {batch.errors.slice(0, 12).map((e: any) => (
                <div key={e.row}>
                  Fila {e.row}: {e.message}
                </div>
              ))}
            </Notice>
          )}
          {batch.status === "preview" && (
            <Notice>
              Revisa el tipo de pago de cada venta nueva. El valor inicial viene del CSV; puedes
              corregir Efectivo, Tarjeta o Transferencia antes de confirmar. El cobro se registra
              una sola vez en su cuenta.
            </Notice>
          )}
          <DataTable
            rows={batch.rows}
            columns={[
              { key: "external_id", label: "ID" },
              { key: "date", label: "Fecha" },
              {
                key: "gross",
                label: "Total cobrado",
                render: (r) => <Amount value={r.gross} effect="income" />,
              },
              {
                key: "clip_base",
                label: "Base Clip",
                render: (r) => <Amount value={r.clip_base} />,
              },
              {
                key: "clip_tip",
                label: "Propina",
                render: (r) => <Amount value={r.clip_tip} effect="income" />,
              },
              {
                key: "clip_financing",
                label: "Cargo diferimiento",
                render: (r) => <Amount value={r.clip_financing} effect="expense" />,
              },
              {
                key: "fees",
                label: "Comisión real",
                render: (r) => <Amount value={r.fees} effect="expense" />,
              },
              {
                key: "installment_plan",
                label: "Plazo del reporte",
                render: (r) =>
                  r.clip_financial_raw?.["Installment Type"]
                    ? `${r.clip_financial_raw.Installment ?? "—"} · ${r.clip_financial_raw["Installment Type"]}`
                    : "Una exhibición",
              },
              {
                key: "method",
                label: "Método",
                render: (r) =>
                  r.method === "cash" ? "Efectivo" : r.method === "card" ? "Tarjeta" : r.method,
              },
              {
                key: "payment_type",
                label: "Tipo de pago / cuenta",
                render: (r) =>
                  batch.status === "preview" && !r.duplicate ? (
                    <select
                      aria-label={`Tipo de pago para ${r.external_id}`}
                      value={selectedType(r) ?? ""}
                      disabled={!!busy}
                      onChange={(e) =>
                        setPaymentTypes({
                          ...paymentTypes,
                          [r.external_id]: e.target.value as ImportPaymentType,
                        })
                      }
                    >
                      <option value="" disabled>
                        Selecciona tipo de pago
                      </option>
                      <option value="cash">Efectivo → Efectivo</option>
                      <option value="card">Tarjeta → Clip</option>
                      <option value="transfer">Transferencia → Banco</option>
                    </select>
                  ) : (
                    ({
                      cash: "Efectivo",
                      card: "Tarjeta / Clip",
                      transfer: "Transferencia / Banco",
                    }[selectedType(r) as ImportPaymentType] ?? "Sin identificar")
                  ),
              },
              {
                key: "net",
                label: "Sin IVA",
                render: (r) => <Amount value={r.net} effect="income" />,
              },
              { key: "clip_status", label: "Estatus de Clip" },
              { key: "status", label: "Estado" },
              {
                key: "duplicate",
                label: "Validación",
                render: (r) => (
                  <Badge tone={r.duplicate ? "neutral" : "success"}>
                    {r.recorded_in_batch
                      ? "Registrada en este lote"
                      : r.duplicate
                        ? "Existente"
                        : "Nuevo"}
                  </Badge>
                ),
              },
            ]}
          />
          {batch.status === "preview" && (
            <div>
              {confirmBlock && (
                <Notice>
                  <span id="confirm-import-block">{confirmBlock}</span>{" "}
                  {settings.data && !settings.data.opening_done && (
                    <Link to="/app/configuracion">Ir a Configuración</Link>
                  )}
                </Notice>
              )}
              <Field label="Motivo del rechazo (opcional)">
                <input
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  maxLength={1000}
                  disabled={!!busy}
                />
              </Field>
              <div className="action-row">
                <button
                  className="button primary"
                  disabled={!!confirmBlock}
                  aria-describedby={confirmBlock ? "confirm-import-block" : undefined}
                  onClick={() =>
                    work("confirm", async () => {
                      await action("confirm-import", { id: batch.id, payment_types: paymentTypes });
                      setBatch(await api("/imports/" + batch.id));
                      setSuccess(
                        "Lote confirmado. Los cobros nuevos se registraron en sus cuentas; las ventas existentes se omitieron. Concilia las tarjetas al recibir el depósito de Clip.",
                      );
                      void client.invalidateQueries();
                    })
                  }
                >
                  <CheckCircle2 size={16} /> Confirmar lote
                </button>
                <button
                  className="button"
                  disabled={!!busy}
                  onClick={() =>
                    work("reject", async () => {
                      await action("reject-import", { id: batch.id, reason: rejectionReason });
                      setBatch(await api("/imports/" + batch.id));
                      setRejectionReason("");
                      setSuccess("Lote rechazado. Los ingresos existentes se conservan.");
                      void client.invalidateQueries();
                    })
                  }
                >
                  <XCircle size={16} /> Rechazar lote
                </button>
              </div>
            </div>
          )}
        </section>
      )}
      <section>
        <div className="section-top">
          <h2>Historial de importaciones</h2>
        </div>
        <DataTable
          rows={history.data ?? []}
          columns={[
            { key: "filename", label: "Origen" },
            { key: "source", label: "Fuente", render: (r) => sourceLabel(r.source) },
            { key: "row_count", label: "Filas" },
            { key: "status", label: "Estado", render: (r) => importStatus(r.status) },
            {
              key: "created_at",
              label: "Registro",
              render: (r) => new Date(r.created_at).toLocaleString("es-MX"),
            },
          ]}
          onRow={(r) => work("load", async () => setBatch(await api("/imports/" + r.id)))}
        />
      </section>
    </>
  );
}
