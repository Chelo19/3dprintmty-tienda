import { z } from "zod";
import { AppError } from "@tienda/shared";
import { audit, type Query } from "../db/database";
import { date, uuid } from "./validation";
import { id } from "./store";

const customer = {
  customer_name: z.string().trim().min(1).max(200),
  customer_phone: z.string().trim().min(7).max(40),
  customer_email: z.string().trim().max(254).email(),
};
const invoiceFolio = z.string().trim().min(1).max(120).nullable().optional();
const fields = z
  .object({
    equipment: z.string().trim().min(1).max(200),
    serial_number: z.string().trim().min(1).max(120),
    date,
    warranty_months: z.coerce.number().int().min(1).max(120),
    customer_name: customer.customer_name.optional(),
    customer_phone: customer.customer_phone.optional(),
    customer_email: customer.customer_email.optional(),
    sale_date: date.optional(),
    invoice_date: date.nullable().optional(),
    invoice_folio: invoiceFolio,
    will_invoice: z.boolean().optional(),
  })
  .strict();
function validateAssignment(data: any) {
  if (data.invoice_folio && !data.invoice_date)
    throw new AppError(
      "invoice_date_required",
      "Registra la fecha de factura para guardar su folio.",
    );
  if (data.will_invoice === false && data.invoice_date)
    throw new AppError(
      "billing_conflict",
      "Quita la fecha de factura antes de marcar que no se va a facturar.",
    );
  const count = Object.keys(customer).filter((key) => data[key] != null).length;
  if (count !== 0 && count !== 3)
    throw new AppError("incomplete_assignment", "Incluye nombre, teléfono y correo del cliente.");
  if (count === 3 && !data.sale_date)
    throw new AppError("sale_date_required", "Registra la fecha de venta al asignar al cliente.");
  if (count === 0 && (data.sale_date || data.invoice_date))
    throw new AppError(
      "customer_required",
      "Asigna al cliente antes de registrar venta o facturación.",
    );
}
const load = async (q: Query, recordId: string) => {
  const before = (await q.query("select * from serial_records where id=$1 for update", [recordId]))
    .rows[0];
  if (!before) throw new AppError("not_found", "No existe la impresora.", 404);
  return before;
};
export async function createSerialRecord(q: Query, raw: unknown) {
  const parsed = fields.parse(raw);
  const data = { ...parsed, will_invoice: parsed.will_invoice ?? true },
    recordId = id();
  validateAssignment(data);
  await q.query(
    "insert into serial_records(id,equipment,serial_number,customer_name,customer_phone,customer_email,date,warranty_months,sale_date,invoice_date,will_invoice,invoice_folio) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
    [
      recordId,
      data.equipment,
      data.serial_number,
      data.customer_name ?? null,
      data.customer_phone ?? null,
      data.customer_email ?? null,
      data.date,
      data.warranty_months,
      data.sale_date ?? null,
      data.invoice_date ?? null,
      data.will_invoice,
      data.invoice_folio ?? null,
    ],
  );
  await audit(q, "serial_record", recordId, "create", { after: data });
  return { id: recordId };
}
export async function updateSerialRecord(q: Query, raw: unknown) {
  const { id: recordId, ...data } = fields.extend({ id: uuid }).parse(raw);
  const before = await load(q, recordId);
  const after = {
    ...data,
    customer_name: data.customer_name ?? before.customer_name,
    customer_phone: data.customer_phone ?? before.customer_phone,
    customer_email: data.customer_email ?? before.customer_email,
    sale_date: data.sale_date ?? before.sale_date,
    invoice_date: Object.hasOwn(data, "invoice_date") ? data.invoice_date : before.invoice_date,
    invoice_folio: Object.hasOwn(data, "invoice_folio") ? data.invoice_folio : before.invoice_folio,
    will_invoice: data.will_invoice ?? before.will_invoice,
  };
  validateAssignment(after);
  await q.query(
    "update serial_records set equipment=$1,serial_number=$2,customer_name=$3,customer_phone=$4,customer_email=$5,date=$6,warranty_months=$7,sale_date=$8,invoice_date=$9,will_invoice=$10,invoice_folio=$11,updated_at=now() where id=$12",
    [
      after.equipment,
      after.serial_number,
      after.customer_name,
      after.customer_phone,
      after.customer_email,
      after.date,
      after.warranty_months,
      after.sale_date,
      after.invoice_date,
      after.will_invoice,
      after.invoice_folio,
      recordId,
    ],
  );
  await audit(q, "serial_record", recordId, "update", { before, after });
  return { id: recordId };
}
export async function assignSerialRecord(q: Query, raw: unknown) {
  const { id: recordId, ...data } = z
    .object({
      id: uuid,
      ...customer,
      sale_date: date,
      invoice_date: date.nullable().optional(),
      invoice_folio: invoiceFolio,
      will_invoice: z.boolean().optional(),
    })
    .strict()
    .parse(raw);
  const before = await load(q, recordId);
  const willInvoice = data.will_invoice ?? before.will_invoice;
  validateAssignment({ ...data, will_invoice: willInvoice });
  if (before.customer_name) {
    if (
      Object.entries({
        ...data,
        invoice_date: data.invoice_date ?? null,
        invoice_folio: data.invoice_folio ?? null,
        will_invoice: willInvoice,
      }).every(([key, value]) => before[key] === value)
    )
      return { id: recordId, already_assigned: true };
    throw new AppError(
      "already_assigned",
      "La impresora ya está asignada. Usa Ver / editar para corregir los datos.",
      409,
    );
  }
  if (before.warranty_months == null)
    throw new AppError(
      "warranty_required",
      "Define la vigencia en meses antes de asignar la impresora.",
    );
  await q.query(
    "update serial_records set customer_name=$1,customer_phone=$2,customer_email=$3,sale_date=$4,invoice_date=$5,will_invoice=$6,invoice_folio=$7,updated_at=now() where id=$8",
    [
      data.customer_name,
      data.customer_phone,
      data.customer_email,
      data.sale_date,
      data.invoice_date ?? null,
      willInvoice,
      data.invoice_folio ?? null,
      recordId,
    ],
  );
  await audit(q, "serial_record", recordId, "assign_customer", {
    before,
    after: { ...data, will_invoice: willInvoice },
  });
  return { id: recordId };
}
export async function invoiceSerialRecord(q: Query, raw: unknown) {
  const {
    id: recordId,
    invoice_date,
    invoice_folio,
  } = z.object({ id: uuid, invoice_date: date, invoice_folio: invoiceFolio }).strict().parse(raw);
  const before = await load(q, recordId);
  if (!before.will_invoice)
    throw new AppError(
      "invoice_not_planned",
      "Esta impresora está marcada como No se va a facturar. Cambia esa opción en Ver / editar antes de registrar una factura.",
      409,
    );
  if (!before.customer_name || !before.sale_date)
    throw new AppError(
      "customer_required",
      "Registra el cliente y la fecha de venta antes de facturar.",
    );
  if (
    before.invoice_date === invoice_date &&
    (invoice_folio === undefined || before.invoice_folio === invoice_folio)
  )
    return { id: recordId, already_recorded: true };
  if (before.invoice_date)
    throw new AppError(
      "already_invoiced",
      "La impresora ya tiene fecha de facturación. Usa Ver / editar para corregirla.",
      409,
    );
  await q.query(
    "update serial_records set invoice_date=$1,invoice_folio=$2,updated_at=now() where id=$3",
    [invoice_date, invoice_folio ?? null, recordId],
  );
  await audit(q, "serial_record", recordId, "record_customer_invoice", {
    before,
    after: { invoice_date, invoice_folio: invoice_folio ?? null },
  });
  return { id: recordId };
}
