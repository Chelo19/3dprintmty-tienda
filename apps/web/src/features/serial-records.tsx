import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { warrantyExpiry } from "@tienda/domain";
import { api } from "../lib/api";
import { shortDate, today } from "../lib/format";
import { Badge, Capture, DataTable, Field, Loading, Modal, Notice } from "../components/ui";

interface SerialRecord {
  id: string;
  equipment: string;
  serial_number: string;
  date: string;
  customer_name: string | null;
  customer_phone: string | null;
  customer_email: string | null;
  warranty_months: number | null;
  sale_date: string | null;
  invoice_date: string | null;
  invoice_folio: string | null;
  will_invoice: boolean;
  billing_status: string;
  warranty_end: string | null;
  warranty_status: string;
  days_remaining: number | null;
}
const customerFields = (row?: SerialRecord | null) => (
  <>
    <Field label="Nombre de cliente">
      <input
        name="customer_name"
        defaultValue={row?.customer_name ?? ""}
        maxLength={200}
        required
      />
    </Field>
    <Field label="Teléfono de cliente">
      <input
        name="customer_phone"
        type="tel"
        defaultValue={row?.customer_phone ?? ""}
        minLength={7}
        maxLength={40}
        required
      />
    </Field>
    <Field label="Correo de cliente">
      <input
        name="customer_email"
        type="email"
        defaultValue={row?.customer_email ?? ""}
        maxLength={254}
        required
      />
    </Field>
  </>
);
function WarrantyPreview({
  invoice,
  months,
  willInvoice = true,
  saleDate = "",
}: {
  invoice: string;
  months: number | null;
  willInvoice?: boolean;
  saleDate?: string;
}) {
  const start = willInvoice ? invoice : saleDate;
  let end: string | null = null;
  if (start && months) {
    try {
      end = warrantyExpiry(start, months);
    } catch {
      /* Incomplete dates remain pending. */
    }
  }
  return (
    <Notice>
      {!start ? (
        willInvoice ? (
          "Pendiente de facturar: la garantía todavía no inicia."
        ) : (
          "Completa la fecha de venta para iniciar la garantía."
        )
      ) : (
        <>
          Vencimiento:{" "}
          <strong>{end ? shortDate(end) : "Define la vigencia y una fecha válida."}</strong>.
          {willInvoice
            ? " Calculado desde la factura emitida al cliente"
            : " No se va a facturar: calculado desde la fecha de venta"}
          ; la cobertura incluye esa fecha.
        </>
      )}
    </Notice>
  );
}
function InvoiceDate({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <Field
      label="Fecha de facturación al cliente"
      hint="Opcional hasta emitir la factura. Esta fecha inicia la garantía."
    >
      <input
        name="invoice_date"
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}
function InvoiceFolio({ value }: { value?: string | null }) {
  return (
    <Field label="Folio de factura" hint="Opcional. Hasta 120 caracteres.">
      <input name="invoice_folio" defaultValue={value ?? ""} maxLength={120} />
    </Field>
  );
}
function InvoicePolicy({
  willInvoice,
  onChange,
  invoice,
}: {
  willInvoice: boolean;
  onChange: (value: boolean) => void;
  invoice: string;
}) {
  return (
    <div>
      <label className="check">
        <input
          type="checkbox"
          checked={!willInvoice}
          disabled={!!invoice}
          onChange={(e) => onChange(!e.target.checked)}
        />
        No se va a facturar
      </label>
      <p className="tiny muted">
        {invoice
          ? "Para cambiar esta opción, primero quita la fecha de facturación en este formulario."
          : "Marca esta opción para que no aparezca como facturación pendiente."}
      </p>
    </div>
  );
}
function WarrantyForm({ row, onSuccess }: { row: SerialRecord | null; onSuccess: () => void }) {
  const [assign, setAssign] = useState(!!row?.customer_name),
    [serialNumber, setSerialNumber] = useState(row?.serial_number ?? ""),
    [months, setMonths] = useState(String(row?.warranty_months ?? "")),
    [invoice, setInvoice] = useState(row?.invoice_date ?? ""),
    [willInvoice, setWillInvoice] = useState(row?.will_invoice ?? true),
    [sale, setSale] = useState(row?.sale_date ?? today());
  return (
    <Capture
      name={row ? "serial-record-update" : "serial-record"}
      submit={row ? "Guardar cambios" : "Guardar impresora"}
      onSuccess={onSuccess}
      transform={(v) => ({
        equipment: v.equipment,
        serial_number: v.serial_number,
        date: v.date,
        warranty_months: Number(v.warranty_months),
        will_invoice: willInvoice,
        ...(row ? { id: row.id } : {}),
        ...(assign
          ? {
              customer_name: v.customer_name,
              customer_phone: v.customer_phone,
              customer_email: v.customer_email,
              sale_date: v.sale_date,
              invoice_date: willInvoice ? v.invoice_date || null : null,
              invoice_folio: willInvoice && v.invoice_date ? v.invoice_folio?.trim() || null : null,
            }
          : {}),
      })}
    >
      <div className="form-grid">
        <Field label="Equipo">
          <input name="equipment" defaultValue={row?.equipment ?? ""} maxLength={200} required />
        </Field>
        <Field
          label="Número de serie"
          hint={`${serialNumber.length}/120 caracteres. No puede repetirse.`}
        >
          <input
            name="serial_number"
            value={serialNumber}
            onChange={(e) => setSerialNumber(e.target.value)}
            maxLength={120}
            autoCapitalize="off"
            spellCheck={false}
            required
          />
        </Field>
        <Field label="Vigencia de garantía (meses)">
          <input
            name="warranty_months"
            type="number"
            min="1"
            max="120"
            step="1"
            value={months}
            onChange={(e) => setMonths(e.target.value)}
            required
          />
        </Field>
        <Field label="Fecha de registro (llegada a tienda)">
          <input
            name="date"
            type="date"
            defaultValue={row?.date?.slice(0, 10) ?? today()}
            required
          />
        </Field>
      </div>
      <InvoicePolicy willInvoice={willInvoice} onChange={setWillInvoice} invoice={invoice} />
      {!row?.customer_name && (
        <label className="check">
          <input type="checkbox" checked={assign} onChange={(e) => setAssign(e.target.checked)} />
          Asignar a un cliente ahora
        </label>
      )}
      {assign ? (
        <>
          <div className="form-grid">
            {customerFields(row)}
            <Field label="Fecha de venta">
              <input
                name="sale_date"
                type="date"
                value={sale}
                onChange={(e) => setSale(e.target.value)}
                required
              />
            </Field>
            {willInvoice && <InvoiceDate value={invoice} onChange={setInvoice} />}
            {willInvoice && invoice && <InvoiceFolio value={row?.invoice_folio} />}
          </div>
          <WarrantyPreview
            invoice={invoice}
            months={Number(months) || null}
            willInvoice={willInvoice}
            saleDate={sale}
          />
        </>
      ) : (
        <Notice>
          La impresora quedará sin asignar. Después registra el cliente y la venta; la garantía
          empezará desde la factura al cliente o desde la venta si eliges No se va a facturar.
        </Notice>
      )}
    </Capture>
  );
}
function AssignmentForm({ row, onSuccess }: { row: SerialRecord; onSuccess: () => void }) {
  const [invoice, setInvoice] = useState(""),
    [willInvoice, setWillInvoice] = useState(row.will_invoice ?? true),
    [sale, setSale] = useState(today());
  return (
    <Capture
      name="serial-record-assign"
      submit="Asignar cliente y registrar venta"
      onSuccess={onSuccess}
      transform={(v) => ({
        ...v,
        id: row.id,
        invoice_date: willInvoice ? v.invoice_date || null : null,
        invoice_folio: willInvoice && v.invoice_date ? v.invoice_folio?.trim() || null : null,
        will_invoice: willInvoice,
      })}
    >
      <Notice>
        <strong>
          {row.equipment} · {row.serial_number}
        </strong>
        . Vigencia: {row.warranty_months} meses.{" "}
        {willInvoice
          ? "Inicia con la factura al cliente."
          : "Al no facturarse, inicia en la fecha de venta."}
      </Notice>
      <InvoicePolicy willInvoice={willInvoice} onChange={setWillInvoice} invoice={invoice} />
      <div className="form-grid">
        {customerFields()}
        <Field label="Fecha de venta">
          <input
            name="sale_date"
            type="date"
            value={sale}
            onChange={(e) => setSale(e.target.value)}
            required
          />
        </Field>
        {willInvoice && <InvoiceDate value={invoice} onChange={setInvoice} />}
        {willInvoice && invoice && <InvoiceFolio value={row?.invoice_folio} />}
      </div>
      <WarrantyPreview
        invoice={invoice}
        months={row.warranty_months}
        willInvoice={willInvoice}
        saleDate={sale}
      />
    </Capture>
  );
}
function InvoiceForm({ row, onSuccess }: { row: SerialRecord; onSuccess: () => void }) {
  const [invoice, setInvoice] = useState(today());
  return (
    <Capture
      name="serial-record-invoice"
      submit="Guardar facturación e iniciar garantía"
      onSuccess={onSuccess}
      transform={(v) => ({ ...v, id: row.id, invoice_folio: v.invoice_folio?.trim() || null })}
    >
      <Notice>
        {row.equipment} · {row.serial_number} · {row.customer_name}. Fecha de venta:{" "}
        {row.sale_date ? shortDate(row.sale_date) : "Por definir"}.
      </Notice>
      <Field label="Fecha de facturación al cliente">
        <input
          name="invoice_date"
          type="date"
          value={invoice}
          onChange={(e) => setInvoice(e.target.value)}
          required
        />
      </Field>
      <InvoiceFolio />
      <WarrantyPreview invoice={invoice} months={row.warranty_months} />
    </Capture>
  );
}
const statusTone = (status: string) =>
  status === "Vigente"
    ? "success"
    : status === "Vencida"
      ? "danger"
      : status === "Por vencer"
        ? "warning"
        : status === "Por iniciar"
          ? "blue"
          : "neutral";
export function SerialRecords() {
  const records = useQuery({
    queryKey: ["serial-records"],
    queryFn: () => api<SerialRecord[]>("/serial-records"),
  });
  const [editing, setEditing] = useState<SerialRecord | null | undefined>(undefined),
    [assigning, setAssigning] = useState<SerialRecord | null>(null),
    [invoicing, setInvoicing] = useState<SerialRecord | null>(null);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">REGISTRO DE NÚMEROS DE SERIE</div>
          <h1>Impresoras y garantías</h1>
          <p>Registra las impresoras, asígnalas después a un cliente y consulta su cobertura.</p>
        </div>
        <button className="button primary" onClick={() => setEditing(null)}>
          <Plus size={16} />
          Registrar impresora
        </button>
      </div>
      {records.data && (
        <div className="tags">
          {[
            "Sin asignar",
            "Pendiente de facturar",
            "Vigente",
            "Por vencer",
            "Vencida",
            "Vigencia por definir",
          ].map((status) => (
            <Badge key={status} tone={statusTone(status)}>
              {status}: {records.data.filter((r) => r.warranty_status === status).length}
            </Badge>
          ))}
        </div>
      )}
      {records.error ? (
        <Notice tone="error">
          {records.error.message}{" "}
          <button className="text-button" onClick={() => void records.refetch()}>
            Reintentar
          </button>
        </Notice>
      ) : !records.data ? (
        <Loading />
      ) : (
        <DataTable
          rows={records.data}
          empty="Aún no hay impresoras registradas"
          columns={[
            { key: "equipment", label: "Equipo" },
            { key: "serial_number", label: "Número de serie" },
            {
              key: "warranty_status",
              label: "Garantía",
              filterable: true,
              render: (r) => (
                <Badge tone={statusTone(r.warranty_status)}>{r.warranty_status}</Badge>
              ),
            },
            {
              key: "warranty_months",
              label: "Vigencia",
              render: (r) => (r.warranty_months ? `${r.warranty_months} meses` : "Por definir"),
            },
            {
              key: "customer_name",
              label: "Cliente",
              render: (r) => r.customer_name ?? "Sin asignar",
            },
            { key: "customer_phone", label: "Teléfono" },
            { key: "customer_email", label: "Correo" },
            {
              key: "sale_date",
              label: "Venta",
              render: (r) => (r.sale_date ? shortDate(r.sale_date) : "Sin venta"),
            },
            {
              key: "billing_status",
              label: "Facturación al cliente",
              filterable: true,
              render: (r) =>
                r.will_invoice === false
                  ? "No se facturará"
                  : r.invoice_date
                    ? shortDate(r.invoice_date)
                    : "Pendiente",
            },
            {
              key: "invoice_folio",
              label: "Folio de factura",
              render: (r) => r.invoice_folio ?? "—",
            },
            {
              key: "warranty_end",
              label: "Vencimiento",
              render: (r) =>
                r.warranty_end ? (
                  <>
                    {shortDate(r.warranty_end)}{" "}
                    <span className="tiny muted">
                      · desde {r.will_invoice === false ? "venta" : "factura"}
                    </span>
                  </>
                ) : r.invoice_date || (r.will_invoice === false && r.sale_date) ? (
                  "Por definir"
                ) : (
                  "Sin iniciar"
                ),
            },
            {
              key: "days_remaining",
              label: "Días restantes",
              render: (r) =>
                r.days_remaining == null
                  ? "—"
                  : r.warranty_status === "Vencida"
                    ? "Vencida"
                    : r.warranty_status === "Por iniciar"
                      ? "Aún no inicia"
                      : `${r.days_remaining} días`,
            },
            { key: "date", label: "Llegada a tienda", render: (r) => shortDate(r.date) },
            {
              key: "assignment",
              label: "Asignación",
              render: (r) =>
                !r.customer_name ? (
                  <button
                    className="text-button"
                    disabled={!r.warranty_months}
                    onClick={() => setAssigning(r as SerialRecord)}
                  >
                    Asignar cliente
                  </button>
                ) : r.will_invoice === false ? (
                  "No se facturará"
                ) : !r.invoice_date ? (
                  <button className="text-button" onClick={() => setInvoicing(r as SerialRecord)}>
                    Registrar factura
                  </button>
                ) : (
                  "Facturada"
                ),
            },
          ]}
          onRow={(r) => setEditing(r as SerialRecord)}
        />
      )}
      {editing !== undefined && (
        <Modal
          title={editing ? "Editar impresora y garantía" : "Registrar impresora con garantía"}
          onClose={() => setEditing(undefined)}
        >
          <WarrantyForm row={editing} onSuccess={() => setEditing(undefined)} />
        </Modal>
      )}
      {invoicing && (
        <Modal title="Registrar facturación al cliente" onClose={() => setInvoicing(null)}>
          <InvoiceForm row={invoicing} onSuccess={() => setInvoicing(null)} />
        </Modal>
      )}
      {assigning && (
        <Modal title="Asignar impresora a cliente" onClose={() => setAssigning(null)}>
          <AssignmentForm row={assigning} onSuccess={() => setAssigning(null)} />
        </Modal>
      )}
    </>
  );
}
