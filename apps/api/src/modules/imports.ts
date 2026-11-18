import { effectiveNet } from "./tax-math";
import { applyCardFees } from "./card-fees";
import { clipAmounts } from "./import-income";
import ExcelJS from "exceljs";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { z } from "zod";
import { AppError, inferImportPaymentType, type ImportPaymentType, type Row } from "@tienda/shared";
import { cents, major } from "@tienda/domain";
import { type Query, audit } from "../db/database";
import { date, money } from "./validation";
import { type NormalizedIncome } from "./import-income";
import { id, ensureOpening } from "./store";
const hash = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
export async function fileRows(
  buffer: Buffer,
  name: string,
): Promise<{ headers: string[]; rows: Row[] }> {
  const workbook = new ExcelJS.Workbook();
  let sheet: ExcelJS.Worksheet | undefined;
  try {
    if (name.toLowerCase().endsWith(".xlsx")) {
      await workbook.xlsx.load(buffer as any);
      sheet = workbook.worksheets[0];
    } else if (name.toLowerCase().endsWith(".csv"))
      sheet = await workbook.csv.read(Readable.from(buffer), {
        map: (value) => value,
        parserOptions: { maxRows: 10002 },
      });
    else throw new Error();
  } catch {
    throw new AppError(
      "invalid_file",
      "No se pudo leer el CSV/XLSX. Comprueba su formato y tamaño.",
    );
  }
  if (!sheet || sheet.rowCount < 2 || sheet.rowCount > 10001 || sheet.columnCount > 80)
    throw new AppError(
      "invalid_file",
      "El archivo debe tener encabezados y entre 1 y 10,000 filas, con hasta 80 columnas.",
    );
  const cell = (v: any) => {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if (v === null || v === undefined) return "";
    if (typeof v === "object")
      throw new AppError(
        "invalid_cell",
        "No se aceptan fórmulas ni celdas complejas en la importación. Exporta valores.",
      );
    return String(v).trim();
  };
  const headers = (sheet.getRow(1).values as any[]).slice(1).map(cell);
  if (headers.some((h) => !h) || new Set(headers).size !== headers.length)
    throw new AppError("invalid_headers", "Los encabezados deben ser únicos y no vacíos.");
  const rows: Row[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const r: Row = {};
    for (const [n, h] of headers.entries()) r[h] = cell(sheet.getRow(i).getCell(n + 1).value);
    if (Object.values(r).some(Boolean)) rows.push(r);
  }
  return { headers, rows };
}
export function mapRows(
  raw: Row[],
  mapping: Row,
  assumePaid = false,
): { rows: NormalizedIncome[]; errors: Row[] } {
  const schema = z.object({
    external_id: z.string().min(1),
    date,
    gross: money,
    net: money.nullable(),
    cogs: money.nullable(),
    fees: money.nullable(),
    method: z.string(),
    status: z.enum(["active", "cancelled"]),
    description: z.string(),
  });
  const rows: NormalizedIncome[] = [],
    errors: Row[] = [];
  const seen = new Set<string>();
  for (const [index, r] of raw.entries()) {
    try {
      const get = (key: string) => (mapping[key] ? String(r[mapping[key]] ?? "").trim() : "");
      const s = get("status").toLowerCase();
      if (!s && !assumePaid)
        throw new Error(
          "Falta el estado. Asigna una columna o confirma que el reporte contiene solo cobros pagados.",
        );
      if (s && !["active", "paid", "approved", "cancelled", "pagado", "cancelado"].includes(s))
        throw new Error("Estado no reconocido. No se interpretan automáticamente devoluciones.");
      const record = schema.parse({
        external_id: get("external_id") ? "clip:" + get("external_id").replace(/^clip:/, "") : "",
        date: get("date"),
        gross: get("gross"),
        net: get("net") || null,
        cogs: get("cogs") || null,
        fees: get("fees") || null,
        method: get("method") || "Sin identificar",
        status: ["cancelled", "cancelado"].includes(s) ? "cancelled" : "active",
        description: get("description") || "Clip · " + get("external_id"),
      });
      if (record.net !== null && cents(record.net) > cents(record.gross))
        throw new Error("La venta sin IVA excede al cobro.");
      if (seen.has(record.external_id)) throw new Error("ID duplicado dentro del archivo.");
      seen.add(record.external_id);
      rows.push(record);
    } catch (e) {
      errors.push({
        row: index + 2,
        message:
          e instanceof z.ZodError ? "ID, fecha ISO o importes inválidos." : (e as Error).message,
      });
    }
  }
  return { rows, errors };
}
const identityKeys = (r: NormalizedIncome): string[] => [
  r.external_id,
  ...[r.clip_transaction_id, r.clip_payment_id, r.clip_receipt_no]
    .filter(Boolean)
    .map((v) => "clip:" + v),
];
const paymentType = (r: NormalizedIncome) => r.payment_type ?? inferImportPaymentType(r.method);
const channel = (r: NormalizedIncome) => {
  const type = paymentType(r);
  return type === "card"
    ? "clip"
    : type === "transfer"
      ? "transfer"
      : type === "cash"
        ? "cash"
        : undefined;
};
async function findExisting(q: Query, rows: NormalizedIncome[]) {
  return (
    await q.query(
      `select * from incomes where external_id=any($1::text[])
    or clip_transaction_id=any($2::text[]) or clip_payment_id=any($3::text[]) or clip_receipt_no=any($4::text[])`,
      [
        rows.flatMap(identityKeys),
        rows.map((r) => r.clip_transaction_id).filter(Boolean),
        rows.map((r) => r.clip_payment_id).filter(Boolean),
        rows.map((r) => r.clip_receipt_no).filter(Boolean),
      ],
    )
  ).rows;
}
function indexExisting(existing: Row[]) {
  const index = new Map<string, Row[]>();
  for (const row of existing) {
    const keys = new Set([
      row.external_id,
      ...[row.clip_transaction_id, row.clip_payment_id, row.clip_receipt_no]
        .filter(Boolean)
        .map((v) => "clip:" + v),
    ]);
    for (const key of keys) index.set(key, [...(index.get(key) ?? []), row]);
  }
  return index;
}
function matches(r: NormalizedIncome, index: Map<string, Row[]>) {
  return [
    ...new Map(
      identityKeys(r)
        .flatMap((k) => index.get(k) ?? [])
        .map((row) => [row.id, row]),
    ).values(),
  ];
}
export async function stage(
  q: Query,
  name: string,
  source: "clip_import",
  rows: NormalizedIncome[],
  errors: Row[],
  fileHash: string,
) {
  // Coalesce exact repetitions, but never choose arbitrarily between conflicting rows.
  const unique: NormalizedIncome[] = [],
    seen = new Map<string, NormalizedIncome>();
  errors = [...errors];
  for (const [i, row] of rows.entries()) {
    const previous = identityKeys(row)
      .map((k) => seen.get(k))
      .filter(Boolean);
    if (previous.length) {
      if (previous.some((p) => JSON.stringify(p) !== JSON.stringify(row)))
        errors.push({
          row: i + 2,
          message: "Identificadores repetidos con datos diferentes. Revisa el reporte.",
        });
      continue;
    }
    unique.push(row);
    for (const k of identityKeys(row)) seen.set(k, row);
  }
  rows = unique.map((r) => ({ ...r, payment_type: paymentType(r) }));
  const contentHash = hash(
    JSON.stringify({
      version: "immutable_receipts_v1",
      source,
      rows,
      errors,
      fileHash,
    }),
  );
  const existing = (
    await q.query("select id from imports where payload_hash=$1 and status <> 'rejected'", [
      contentHash,
    ])
  ).rows[0];
  if (existing) return preview(q, existing.id);
  const iid = id();
  await q.query(
    "insert into imports(id,filename,file_hash,payload_hash,rows,errors,source) values ($1,$2,$3,$4,$5,$6,$7)",
    [iid, name, fileHash, contentHash, JSON.stringify(rows), JSON.stringify(errors), source],
  );
  return preview(q, iid);
}
export async function preview(q: Query, iid: string): Promise<Row> {
  const item = (await q.query("select * from imports where id=$1", [iid])).rows[0];
  if (!item) throw new AppError("not_found", "No existe el lote.", 404);
  const rows: Row[] = [];
  const fiscalProfile =
    (await q.query("select fiscal_profile from settings")).rows[0]?.fiscal_profile ===
    "resico_pf_16";
  let total = 0n;
  const found = await findExisting(q, item.rows);
  const identities = indexExisting(found);
  const errors = [...item.errors];
  const matchedIds = new Set<string>();
  for (const [index, r] of item.rows.entries()) {
    const candidates = matches(r, identities);
    const existing = candidates[0];
    if (candidates.length > 1 || (existing && matchedIds.has(existing.id)))
      errors.push({
        row: index + 2,
        message:
          "Identificadores en conflicto: corresponden a más de un registro. Concilia antes de importar.",
      });
    if (existing) matchedIds.add(existing.id);
    if (
      existing &&
      ["clip_transaction_id", "clip_payment_id", "clip_receipt_no"].some(
        (k) => r[k] && existing[k] && r[k] !== existing[k],
      )
    )
      errors.push({
        row: index + 2,
        message: "El identificador de Clip contradice un registro existente.",
      });
    const computed =
      fiscalProfile && !existing && r.net === null
        ? effectiveNet({
            gross_cents: cents(r.gross).toString(),
            clip_tip_cents: r.clip_tip == null ? null : cents(r.clip_tip).toString(),
            clip_financing_cents:
              r.clip_financing == null ? null : cents(r.clip_financing).toString(),
          })
        : null;
    rows.push({
      ...r,
      net: r.net ?? (computed === null ? null : major(computed)),
      net_calculated: computed !== null,
      fees_calculated:
        fiscalProfile &&
        !existing &&
        r.fees === null &&
        channel(r) !== undefined &&
        channel(r) !== "clip",
      fees:
        fiscalProfile &&
        !existing &&
        r.fees === null &&
        channel(r) !== undefined &&
        channel(r) !== "clip"
          ? "0.00"
          : r.fees,
      payment_type: existing
        ? existing.channel === "cash"
          ? "cash"
          : existing.channel === "transfer"
            ? "transfer"
            : "card"
        : paymentType(r),
      csv_method: r.method,
      existing_id: existing?.id,
      duplicate: !!existing,
      recorded_in_batch: item.status === "confirmed" && existing?.import_id === iid,
      changed: existing
        ? existing.status !== r.status ||
          existing.channel !== channel(r) ||
          (r.method !== "Sin identificar" && existing.method !== r.method) ||
          existing.from_date !== r.date ||
          existing.gross_cents !== cents(r.gross).toString() ||
          clipAmounts.some(
            (k) => r[k] != null && cents(r[k]!).toString() !== existing[k + "_cents"],
          ) ||
          ["net", "cogs", "fees"].some(
            (k) => r[k] !== null && cents(r[k]).toString() !== existing[k + "_cents"],
          )
        : false,
    });
    if (
      (!existing || (item.status === "confirmed" && existing.import_id === iid)) &&
      r.status === "active"
    )
      total += cents(r.gross);
  }
  return {
    ...item,
    rows,
    errors,
    new_count: rows.filter((r) => !r.duplicate || r.recorded_in_batch).length,
    changed_count: rows.filter((r) => r.changed).length,
    unchanged_count: rows.filter((r) => r.duplicate && !r.changed).length,
    cash_count: rows.filter((r) => channel(r as NormalizedIncome) === "cash").length,
    total: major(total),
    duplicates: rows.filter((r) => r.duplicate && !r.recorded_in_batch).length,
  };
}
export async function confirm(
  q: Query,
  iid: string,
  rawChoices: Record<string, ImportPaymentType> = {},
) {
  const choices = z.record(z.enum(["cash", "card", "transfer"])).parse(rawChoices);
  const batch = await preview(q, iid);
  if (batch.status === "confirmed") return { id: iid, already_confirmed: true };
  if (batch.status === "rejected")
    throw new AppError(
      "import_rejected",
      "El lote fue rechazado. Carga de nuevo el archivo para crear otra vista previa.",
      409,
    );
  if (batch.errors.length)
    throw new AppError("import_errors", "Corrige todos los errores antes de confirmar.");
  if (!batch.rows.length) throw new AppError("empty_import", "El lote no tiene transacciones.");
  const batchKeys = new Set(batch.rows.map((r: Row) => r.external_id));
  if (Object.keys(choices).some((key) => !batchKeys.has(key)))
    throw new AppError(
      "invalid_selection",
      "La selección de pago contiene una transacción ajena al lote.",
    );
  // Re-resolve identities within the serialized transaction. Existing sales are never updated,
  // even if another overlapping batch was confirmed after the preview was displayed.
  const fresh = (batch.rows as (NormalizedIncome & Row)[])
    .filter((r) => !r.duplicate)
    .map((r) => {
      const selected = Object.hasOwn(choices, r.external_id)
        ? choices[r.external_id]
        : paymentType(r);
      if (!selected)
        throw new AppError(
          "payment_type_required",
          "Selecciona Efectivo, Tarjeta o Transferencia para " + r.external_id + ".",
        );
      return {
        ...r,
        payment_type: selected,
        fees: r.fees_calculated ? (selected === "card" ? null : "0.00") : r.fees,
        method: selected === inferImportPaymentType(r.method) ? r.method : selected,
      };
    });
  const manual = (
    await q.query(
      "select from_date,to_date,channel from incomes where source='manual_summary' and status='active'",
    )
  ).rows;
  for (const value of new Set(fresh.map((r) => r.date))) await ensureOpening(q, value);
  const prepared: Row[] = [];
  for (const r of fresh) {
    const to = new Date(Date.parse(r.date) + 86400000).toISOString().slice(0, 10);
    if (
      r.status === "active" &&
      manual.some(
        (m) =>
          (m.channel === channel(r) || m.channel === "clip") &&
          m.from_date < to &&
          m.to_date > r.date,
      )
    )
      throw new AppError(
        "coverage_conflict",
        "Este periodo ya tiene ingresos consolidados de Clip. Retira la cobertura anterior antes de confirmar el lote.",
        409,
      );
    prepared.push({
      id: id(),
      from_date: r.date,
      to_date: to,
      source: batch.source,
      external_id: r.external_id,
      channel: channel(r),
      clip_transaction_id: r.clip_transaction_id ?? null,
      clip_payment_id: r.clip_payment_id ?? null,
      clip_receipt_no: r.clip_receipt_no ?? null,
      ...Object.fromEntries(
        clipAmounts.map((k) => [k + "_cents", r[k] == null ? null : cents(r[k]!).toString()]),
      ),
      clip_financial_raw: r.clip_financial_raw ?? null,
      import_id: iid,
      description: r.description,
      gross_cents: cents(r.gross).toString(),
      net_cents: r.net === null ? null : cents(r.net).toString(),
      cogs_cents: r.cogs === null ? null : cents(r.cogs).toString(),
      fees_cents: r.fees === null ? null : cents(r.fees).toString(),
      method: r.method,
      status: r.status,
    });
  }
  if (prepared.length)
    await q.query(
      `insert into incomes(id,from_date,to_date,channel,source,external_id,import_id,description,gross_cents,net_cents,cogs_cents,fees_cents,method,status,clip_transaction_id,clip_payment_id,clip_receipt_no,clip_base_cents,clip_tip_cents,clip_financing_cents,clip_report_net_cents,clip_financial_raw)
    select id,from_date,to_date,channel,source,external_id,import_id,description,gross_cents,net_cents,cogs_cents,fees_cents,method,status,clip_transaction_id,clip_payment_id,clip_receipt_no,clip_base_cents,clip_tip_cents,clip_financing_cents,clip_report_net_cents,clip_financial_raw
    from jsonb_to_recordset($1::jsonb) as x(id uuid,from_date date,to_date date,channel text,source text,external_id text,import_id uuid,description text,gross_cents bigint,net_cents bigint,cogs_cents bigint,fees_cents bigint,method text,status text,clip_transaction_id text,clip_payment_id text,clip_receipt_no text,clip_base_cents bigint,clip_tip_cents bigint,clip_financing_cents bigint,clip_report_net_cents bigint,clip_financial_raw jsonb)`,
      [JSON.stringify(prepared)],
    );
  const receipts = prepared
    .filter((r) => r.status === "active" && BigInt(r.gross_cents) > 0n)
    .map((r) => ({
      id: id(),
      income_id: r.id,
      date: r.from_date,
      account_id: r.channel === "cash" ? "cash" : r.channel === "transfer" ? "bank" : "clip",
      amount_cents: r.gross_cents,
      notes: "Cobro de importación · " + r.external_id,
    }));
  if (receipts.length) {
    await q.query(
      `insert into cash_movements(id,income_id,date,account_id,amount_cents,kind,notes)
      select id,income_id,date,account_id,amount_cents,'collection',notes from jsonb_to_recordset($1::jsonb)
      as x(id uuid,income_id uuid,date date,account_id text,amount_cents bigint,notes text)`,
      [JSON.stringify(receipts)],
    );
    await q.query(
      `update incomes i set import_collection_id=x.id from jsonb_to_recordset($1::jsonb) as x(id uuid,income_id uuid) where i.id=x.income_id`,
      [JSON.stringify(receipts)],
    );
  }
  // Preserve the chosen payment types in the confirmed batch for review and audit.
  const cardFees = await applyCardFees(
    q,
    receipts.filter((r) => r.account_id === "clip").map((r) => r.income_id),
  );
  const chosenById = new Map(fresh.map((r) => [r.external_id, r]));
  await q.query("update imports set status='confirmed',rows=$2 where id=$1", [
    iid,
    JSON.stringify(
      batch.rows.map((r: Row) => {
        const chosen = chosenById.get(r.external_id);
        return chosen ? { ...r, payment_type: chosen.payment_type, method: chosen.method } : r;
      }),
    ),
  ]);
  await audit(q, "import", iid, "confirm", {
    source: batch.source,
    new_count: prepared.length,
    skipped_count: batch.duplicates,
    after: prepared,
    receipts,
    card_fees: cardFees,
  });
  return {
    id: iid,
    confirmed: prepared.length,
    new_count: prepared.length,
    skipped_count: batch.duplicates,
    unchanged_count: batch.duplicates,
    changed_count: 0,
  };
}
export async function reject(q: Query, iid: string, reason = "") {
  const batch = (await q.query("select id,status from imports where id=$1 for update", [iid]))
    .rows[0];
  if (!batch) throw new AppError("not_found", "No existe el lote.", 404);
  if (batch.status === "rejected") return { id: iid, already_rejected: true };
  if (batch.status === "confirmed")
    throw new AppError(
      "import_confirmed",
      "El lote ya fue confirmado; no puede rechazarse ni deshacer ingresos desde esta opción.",
      409,
    );
  await q.query(
    "update imports set status='rejected',rejected_at=now(),rejection_reason=$1 where id=$2",
    [reason, iid],
  );
  await audit(q, "import", iid, "reject", { before: "preview", after: "rejected" }, reason);
  return { id: iid, rejected: true };
}
export { hash };
