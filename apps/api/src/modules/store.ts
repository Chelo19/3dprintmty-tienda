import { effectiveNet } from "./tax-math";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError, NOTES_MAX_LENGTH, type Row } from "@tienda/shared";
import {
  cents,
  Decimal,
  allocate,
  lineCost,
  outflowCost,
  major,
  estimateCardFee,
  cardInstallmentPlan,
  type CardFeeRule,
  warrantyDetails,
  localDate,
} from "@tienda/domain";
import { type Query, audit, unlocked } from "../db/database";
import { date, money, quantity, uuid, incomeInput, initialPaymentInput } from "./validation";
export const id = () => randomUUID();
export async function ensureOpening(q: Query, day: string) {
  const s = (await q.query("select * from settings")).rows[0];
  if (!s?.opening_done)
    throw new AppError(
      "opening_required",
      "Registra la apertura en Configuración antes de capturar movimientos.",
    );
  if (day < s.opening_date)
    throw new AppError("before_opening", "La fecha es anterior a la apertura.");
  await unlocked(q, day);
}
export async function stock(q: Query, product: string) {
  return (
    await q.query(
      "select coalesce(sum(quantity),0)::text as quantity,coalesce(sum(value_cents),0)::text as value from inventory_movements where product_id=$1 and voided_at is null",
      [product],
    )
  ).rows[0]!;
}
export async function revalue(q: Query, product: string) {
  const rows = (
    await q.query(
      "select * from inventory_movements where product_id=$1 and voided_at is null order by date,created_at,id",
      [product],
    )
  ).rows;
  const returns = new Map<string, { quantity: Decimal; value: bigint }>();
  let units = new Decimal(0),
    value = 0n;
  for (const row of rows) {
    let v = BigInt(row.value_cents);
    const qty = new Decimal(row.quantity);
    if (row.refund_id) {
      const returned = (
        await q.query(
          "select r.*,i.cogs_cents as original_cost,i.quantity as original_quantity from income_refunds r join incomes i on i.id=r.income_id where r.id=$1",
          [row.refund_id],
        )
      ).rows[0]!;
      const previous = returns.get(returned.income_id) ?? { quantity: new Decimal(0), value: 0n };
      const returnedQuantity = previous.quantity.plus(returned.quantity);
      v = returnedQuantity.equals(returned.original_quantity)
        ? BigInt(returned.original_cost) - previous.value
        : BigInt(
            new Decimal(returned.original_cost)
              .times(returned.quantity)
              .div(returned.original_quantity)
              .toFixed(0),
          );
      returns.set(returned.income_id, { quantity: returnedQuantity, value: previous.value + v });
      if (v !== BigInt(row.value_cents))
        await q.query("update income_refunds set cogs_cents=$1 where id=$2", [
          v.toString(),
          row.refund_id,
        ]);
    }
    if (qty.lt(0) && row.kind !== "reversal") {
      try {
        v = -outflowCost(qty.abs().toFixed(), units.toFixed(), value);
      } catch (e) {
        throw new AppError("insufficient_stock", (e as Error).message);
      }
    }
    if (!qty.isZero() && units.plus(qty).lt(0))
      throw new AppError("insufficient_stock", "El ajuste deja existencias negativas.");
    if (v !== BigInt(row.value_cents)) {
      await q.query("update inventory_movements set value_cents=$1 where id=$2", [
        v.toString(),
        row.id,
      ]);
      await audit(
        q,
        "inventory",
        row.id,
        "revalue",
        { before: row.value_cents, after: v.toString() },
        "Revaluación por movimiento retroactivo",
      );
    }
    if (row.income_id)
      await q.query("update incomes set cogs_cents=$1 where id=$2", [
        (-v).toString(),
        row.income_id,
      ]);
    units = units.plus(qty);
    value += v;
    if (value < 0n) throw new AppError("invalid_inventory", "La valuación no puede ser negativa.");
  }
  return { quantity: units.toFixed(), value: value.toString() };
}
export async function overlap(
  q: Query,
  from: string,
  to: string,
  channel: string,
  source: "manual_summary" | "clip_api" | "clip_import",
  exclude?: string,
) {
  const rows = (
    await q.query(
      "select id,source,description from incomes where status='active' and channel=$1 and from_date<$3 and to_date>$2 and id<>$4 and (source='manual_summary' or $5='manual_summary')",
      [channel, from, to, exclude ?? "00000000-0000-0000-0000-000000000000", source],
    )
  ).rows;
  if (rows.length)
    throw new AppError(
      "coverage_conflict",
      "Este periodo y canal ya tiene ingresos. Reemplaza la cobertura existente antes de activar otra fuente.",
      409,
    );
}
// The caller's transaction includes document, optional template, payment and audit events.
async function payAtCreation(
  q: Query,
  kind: "purchase" | "expense",
  documentId: string,
  documentDate: string,
  total: bigint,
  payment: z.infer<typeof initialPaymentInput>,
) {
  if (!payment) return;
  await cash(q, {
    date: payment.date ?? documentDate,
    account_id: payment.account_id,
    kind,
    amount: major(total),
    [kind + "_id"]: documentId,
    notes:
      kind === "purchase"
        ? "Pago total al registrar la compra."
        : "Pago total al registrar el gasto.",
  });
}

export async function purchase(q: Query, raw: unknown) {
  const b = z
    .object({
      date,
      supplier_id: uuid,
      reference: z.string().trim().max(100).default(""),
      initial_payment: initialPaymentInput,
      freight: money.default("0"),
      tax: money.default("0"),
      nonrecoverable_tax: money.default("0"),
      notes: z
        .string()
        .max(NOTES_MAX_LENGTH, "Las observaciones admiten hasta 20,000 caracteres.")
        .default(""),
      merchandise: money.optional(),
      lines: z
        .array(
          z.object({
            product_id: uuid,
            quantity,
            unit_cost: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/),
            discount: money.default("0"),
          }),
        )
        .max(100)
        .default([]),
    })
    .parse(raw);
  await ensureOpening(q, b.date);
  const mode = (await q.query("select inventory_mode from settings")).rows[0]?.inventory_mode;
  if (mode === "summary" || mode === "external") {
    if (b.lines.length || b.merchandise === undefined)
      throw new AppError(
        "purchase_mode",
        "Captura el importe de mercancía sin seleccionar productos.",
      );
    const cost = cents(b.merchandise) + cents(b.freight) + cents(b.nonrecoverable_tax);
    const pid = id(),
      total = cost + cents(b.tax);
    await q.query(
      "insert into purchases(id,date,supplier_id,reference,freight_cents,tax_cents,total_cents,notes,summary_cost_cents) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [
        pid,
        b.date,
        b.supplier_id,
        b.reference,
        (cents(b.freight) + cents(b.nonrecoverable_tax)).toString(),
        cents(b.tax).toString(),
        total.toString(),
        b.notes,
        cost.toString(),
      ],
    );
    await audit(q, "purchase", pid, "create", b);
    await payAtCreation(q, "purchase", pid, b.date, total, b.initial_payment);
    return { id: pid, total_cents: total.toString() };
  }
  if (!b.lines.length || b.merchandise !== undefined)
    throw new AppError("purchase_mode", "En el modo detallado incluye los productos de la compra.");
  const pid = id();
  let weights: bigint[];
  try {
    weights = b.lines.map((l) => lineCost(l.quantity, l.unit_cost, l.discount));
  } catch (e) {
    throw new AppError("invalid_cost", (e as Error).message);
  }
  const extras = cents(b.freight) + cents(b.nonrecoverable_tax);
  let distributed: bigint[];
  try {
    distributed = allocate(extras, weights);
  } catch (e) {
    throw new AppError("allocation_error", (e as Error).message);
  }
  const costs = weights.map((w, i) => w + (distributed[i] ?? 0n));
  const total = costs.reduce((a, v) => a + v, 0n) + cents(b.tax);
  await q.query(
    "insert into purchases(id,date,supplier_id,reference,freight_cents,tax_cents,total_cents,notes) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      pid,
      b.date,
      b.supplier_id,
      b.reference,
      extras.toString(),
      cents(b.tax).toString(),
      total.toString(),
      b.notes,
    ],
  );
  for (const [i, l] of b.lines.entries()) {
    const lid = id();
    await q.query("insert into purchase_lines values ($1,$2,$3,$4,$5,$6)", [
      lid,
      pid,
      l.product_id,
      l.quantity,
      l.unit_cost,
      costs[i]!.toString(),
    ]);
    await q.query(
      "insert into inventory_movements(id,product_id,date,quantity,value_cents,kind,purchase_line_id,reason) values ($1,$2,$3,$4,$5,'purchase',$6,$7)",
      [id(), l.product_id, b.date, l.quantity, costs[i]!.toString(), lid, "Compra " + b.reference],
    );
  }
  for (const p of new Set(b.lines.map((l) => l.product_id))) await revalue(q, p);
  await audit(q, "purchase", pid, "create", b);
  await payAtCreation(q, "purchase", pid, b.date, total, b.initial_payment);
  return { id: pid, total_cents: total.toString() };
}
/** Reference corrections are descriptive: retain financial values and closed periods. */
export async function purchaseReference(q: Query, raw: unknown) {
  const b = z.object({ id: uuid, reference: z.string().trim().max(100).default("") }).parse(raw);
  const before = (await q.query("select * from purchases where id=$1 for update", [b.id])).rows[0];
  if (!before) throw new AppError("not_found", "No existe la compra.", 404);
  if (before.reference === b.reference) return { id: b.id, reference: b.reference };
  await q.query("update purchases set reference=$1 where id=$2", [b.reference, b.id]);
  await audit(q, "purchase", b.id, "update_reference", {
    before: { reference: before.reference },
    after: { reference: b.reference },
  });
  return { id: b.id, reference: b.reference };
}

/** Descriptive corrections do not change amounts, payments or closed-period calculations. */
export async function purchaseNotes(q: Query, raw: unknown) {
  const b = z
    .object({ id: uuid, notes: z.string().max(NOTES_MAX_LENGTH) })
    .strict()
    .parse(raw);
  const before = (await q.query("select notes from purchases where id=$1 for update", [b.id]))
    .rows[0];
  if (!before) throw new AppError("not_found", "No existe la compra.", 404);
  if (before.notes !== b.notes) {
    await q.query("update purchases set notes=$1 where id=$2", [b.notes, b.id]);
    await audit(q, "purchase", b.id, "update_notes", {
      before: { notes: before.notes },
      after: { notes: b.notes },
    });
  }
  return { id: b.id, notes: b.notes };
}

export async function expense(q: Query, raw: unknown) {
  const b = z
    .object({
      date,
      category: z.string().min(1).max(100),
      concept: z.string().min(1).max(200),
      amount: money,
      tax: money.default("0"),
      tax_mode: z.enum(["itemized", "total_no_credit"]).default("itemized"),
      kind: z.enum(["operating", "asset"]).default("operating"),
      notes: z
        .string()
        .max(NOTES_MAX_LENGTH, "Las observaciones admiten hasta 20,000 caracteres.")
        .default(""),
      recurring: z.boolean().default(false),
      initial_payment: initialPaymentInput,
    })
    .parse(raw);
  if (b.tax_mode === "total_no_credit" && cents(b.tax) !== 0n)
    throw new AppError(
      "invalid_tax",
      "Un gasto por total sin IVA acreditable debe tener IVA acreditable en cero.",
    );
  await ensureOpening(q, b.date);
  const eid = id(),
    tid = b.recurring ? id() : null;
  if (tid)
    await q.query(
      "insert into expense_templates(id,category,concept,amount_cents,tax_cents,tax_mode) values ($1,$2,$3,$4,$5,$6)",
      [tid, b.category, b.concept, cents(b.amount).toString(), cents(b.tax).toString(), b.tax_mode],
    );
  await q.query(
    "insert into expenses(id,date,category,concept,amount_cents,tax_cents,kind,notes,template_id,tax_mode) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      eid,
      b.date,
      b.category,
      b.concept,
      cents(b.amount).toString(),
      cents(b.tax).toString(),
      b.kind,
      b.notes,
      tid,
      b.tax_mode,
    ],
  );
  await audit(q, "expense", eid, "create", b);
  await payAtCreation(q, "expense", eid, b.date, cents(b.amount) + cents(b.tax), b.initial_payment);
  return { id: eid };
}
export async function income(q: Query, raw: unknown) {
  const b = incomeInput.parse(raw);
  await ensureOpening(q, b.from);
  if (
    b.product_id &&
    (await q.query("select inventory_mode from settings")).rows[0]?.inventory_mode !== "detailed"
  )
    throw new AppError(
      "inventory_mode",
      "En el control por totales registra ingresos sin producto; el costo se determina con los cortes del periodo.",
    );
  await overlap(q, b.from, b.to, b.channel, "manual_summary");
  if (b.product_id && !b.quantity)
    throw new AppError("quantity_required", "Captura las unidades vendidas.");
  if (b.quantity && !b.product_id)
    throw new AppError("product_required", "Selecciona un producto para las unidades vendidas.");
  const gross = cents(b.gross),
    net = b.net === null ? null : cents(b.net);
  if (net !== null && net > gross)
    throw new AppError("invalid_net", "La venta sin IVA no puede exceder al importe cobrado.");
  const iid = id();
  let cost = b.cogs === null ? null : cents(b.cogs);
  await q.query(
    "insert into incomes(id,from_date,to_date,channel,source,description,category_id,product_id,quantity,gross_cents,net_cents,cogs_cents,fees_cents,method,notes) values ($1,$2,$3,$4,'manual_summary',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)",
    [
      iid,
      b.from,
      b.to,
      b.channel,
      b.description,
      b.category_id ?? null,
      b.product_id ?? null,
      b.quantity ?? null,
      gross.toString(),
      net?.toString() ?? null,
      cost?.toString() ?? null,
      b.fees === null ? null : cents(b.fees).toString(),
      b.method,
      b.notes,
    ],
  );
  if (b.product_id) {
    const day = new Date(new Date(b.to + "T12:00:00Z").getTime() - 86400000)
      .toISOString()
      .slice(0, 10);
    await q.query(
      "insert into inventory_movements(id,product_id,date,quantity,value_cents,kind,income_id,reason) values ($1,$2,$3,$4,0,'sale',$5,$6)",
      [id(), b.product_id, day, new Decimal(b.quantity!).neg().toFixed(), iid, b.description],
    );
    await revalue(q, b.product_id);
  }
  await audit(q, "income", iid, "create", b);
  return { id: iid };
}
export async function opening(q: Query, raw: unknown) {
  const b = z
    .object({
      date,
      inventory_mode: z.enum(["summary", "detailed", "external"]).optional(),
      inventory_value: money.optional(),
      cash: money,
      bank: money,
      clip: money,
      lines: z
        .array(
          z.object({
            product_id: uuid,
            quantity,
            unit_cost: z.string().regex(/^\d{1,12}(\.\d{1,6})?$/),
          }),
        )
        .max(500)
        .default([]),
    })
    .parse(raw);
  const settings = (await q.query("select * from settings")).rows[0];
  if (settings?.opening_done)
    throw new AppError(
      "already_open",
      "La apertura ya fue registrada. Usa ajustes documentados.",
      409,
    );
  const mode = b.inventory_mode ?? (b.lines.length ? "detailed" : "summary");
  if (mode === "summary" && (b.lines.length || b.inventory_value === undefined))
    throw new AppError(
      "opening_inventory",
      "Registra el valor total del inventario inicial; usa cero solo si no tienes mercancía.",
    );
  if (mode === "detailed" && b.inventory_value !== undefined)
    throw new AppError(
      "opening_inventory",
      "No mezcles el valor total con existencias por producto.",
    );
  if (mode === "external" && (b.lines.length || b.inventory_value !== undefined))
    throw new AppError("inventory_disabled", "No se registra inventario en este sistema.");
  for (const l of b.lines)
    await q.query(
      "insert into inventory_movements(id,product_id,date,quantity,value_cents,kind,reason) values ($1,$2,$3,$4,$5,'opening','Inventario inicial')",
      [id(), l.product_id, b.date, l.quantity, lineCost(l.quantity, l.unit_cost).toString()],
    );
  for (const account of ["cash", "bank", "clip"] as const)
    if (cents(b[account]))
      await q.query(
        "insert into cash_movements(id,date,account_id,amount_cents,kind,notes) values ($1,$2,$3,$4,'opening','Saldo inicial')",
        [id(), b.date, account, cents(b[account]).toString()],
      );
  await q.query(
    "update settings set opening_date=$1,opening_done=true,inventory_mode=$2,opening_inventory_cents=$3 where id=1",
    [b.date, mode, mode === "summary" ? cents(b.inventory_value!).toString() : null],
  );
  await audit(q, "opening", "1", "create", b);
  return { ok: true };
}
export async function adjustment(q: Query, raw: unknown) {
  const b = z
    .object({
      date,
      product_id: uuid,
      quantity: z
        .string()
        .regex(/^-?\d{1,10}(\.\d{1,6})?$/)
        .refine((v) => Number(v) !== 0),
      unit_cost: money,
      reason: z.string().trim().min(8).max(1000),
    })
    .parse(raw);
  await ensureOpening(q, b.date);
  if ((await q.query("select inventory_mode from settings")).rows[0]?.inventory_mode !== "detailed")
    throw new AppError(
      "inventory_mode",
      "En el control por totales utiliza cortes del inventario, sin ajustes por producto.",
    );
  const v = new Decimal(b.quantity).isPositive() ? lineCost(b.quantity, b.unit_cost) : 0n;
  await q.query(
    "insert into inventory_movements(id,product_id,date,quantity,value_cents,kind,reason) values ($1,$2,$3,$4,$5,'adjustment',$6)",
    [id(), b.product_id, b.date, b.quantity, v.toString(), b.reason],
  );
  await revalue(q, b.product_id);
  await audit(q, "inventory", b.product_id, "adjust", b, b.reason);
  return { ok: true };
}
export async function cash(q: Query, raw: unknown) {
  const b = z
    .object({
      date,
      account_id: z.enum(["cash", "bank", "clip"]),
      destination: z.enum(["cash", "bank", "clip"]).optional(),
      kind: z.enum([
        "collection",
        "purchase",
        "expense",
        "refund",
        "transfer",
        "contribution",
        "withdrawal",
        "recovery",
      ]),
      amount: money,
      purchase_id: uuid.optional(),
      expense_id: uuid.optional(),
      income_id: uuid.optional(),
      notes: z
        .string()
        .trim()
        .min(1)
        .max(NOTES_MAX_LENGTH, "Las observaciones admiten hasta 20,000 caracteres."),
    })
    .parse(raw);
  await ensureOpening(q, b.date);
  const amount = cents(b.amount);
  if (!amount) throw new AppError("zero_amount", "El importe debe ser mayor a cero.");
  if (
    b.kind === "collection" &&
    b.income_id &&
    (
      await q.query(
        "select id from incomes where id=$1 and (settled_at is not null or import_collection_id is not null)",
        [b.income_id],
      )
    ).rows.length
  )
    throw new AppError(
      "already_settled",
      "El cobro de esta transacción ya se registró al importar o conciliar. No se puede cobrar otra vez.",
      409,
    );
  const refs = [b.purchase_id, b.expense_id, b.income_id].filter(Boolean);
  if (refs.length > 1) throw new AppError("invalid_reference", "Selecciona un solo documento.");
  if (
    (b.kind === "purchase" && !b.purchase_id) ||
    (b.kind === "expense" && !b.expense_id) ||
    (b.kind === "collection" && !b.income_id) ||
    (b.kind === "recovery" && !(b.purchase_id || b.expense_id))
  )
    throw new AppError("reference_required", "Este movimiento requiere un documento.");
  if (
    (b.purchase_id && !["purchase", "recovery"].includes(b.kind)) ||
    (b.expense_id && !["expense", "recovery"].includes(b.kind)) ||
    (b.income_id && !["collection", "refund"].includes(b.kind))
  )
    throw new AppError("invalid_reference", "El documento no corresponde al tipo de movimiento.");
  for (const [field, table, total] of [
    ["purchase_id", "purchases", "total_cents"],
    ["expense_id", "expenses", "amount_cents+tax_cents"],
    ["income_id", "incomes", "gross_cents"],
  ] as const) {
    const ref = b[field];
    if (!ref) continue;
    const documentDate = table === "incomes" ? "from_date" : "date";
    const states =
      table === "incomes" && b.kind === "refund"
        ? ["active", "cancelled"]
        : [b.kind === "recovery" ? "cancelled" : "active"];
    const doc = (
      await q.query(
        `select ${documentDate}::text as date,${total} as total from ${table} where id=$1 and status=any($2::text[])`,
        [ref, states],
      )
    ).rows[0];
    if (!doc) throw new AppError("not_found", "El documento no está disponible.", 404);
    if (b.date < doc.date)
      throw new AppError("invalid_payment_date", "El pago no puede ser anterior al documento.");
    if (b.kind === "recovery") {
      const balance = (
        await q.query(
          `select coalesce(-sum(amount_cents),0)::text as total,coalesce(-sum(amount_cents) filter(where date <= $2),0)::text as at_date from cash_movements where ${field}=$1`,
          [ref, b.date],
        )
      ).rows[0]!;
      if (amount > BigInt(balance.total) || amount > BigInt(balance.at_date))
        throw new AppError(
          "over_recovery",
          "La recuperación excede lo pagado pendiente de recuperar a esa fecha.",
        );
      continue;
    }
    const paid = BigInt(
      (
        await q.query(
          `select coalesce(sum(abs(amount_cents)),0)::text as paid from cash_movements where ${field}=$1 and kind=$2`,
          [ref, b.kind],
        )
      ).rows[0]!.paid,
    );
    if (amount + paid > BigInt(doc.total))
      throw new AppError("overpayment", "El importe excede el saldo del documento.");
  }
  const negative = ["purchase", "expense", "refund", "transfer", "withdrawal"].includes(b.kind),
    value = negative ? -amount : amount;
  const tid = b.kind === "transfer" ? id() : null;
  if (tid && (!b.destination || b.destination === b.account_id))
    throw new AppError("invalid_transfer", "Selecciona una cuenta destino diferente.");
  await q.query(
    "insert into cash_movements(id,date,account_id,amount_cents,kind,purchase_id,expense_id,income_id,transfer_id,notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      id(),
      b.date,
      b.account_id,
      value.toString(),
      b.kind,
      b.purchase_id ?? null,
      b.expense_id ?? null,
      b.income_id ?? null,
      tid,
      b.notes,
    ],
  );
  if (tid)
    await q.query(
      "insert into cash_movements(id,date,account_id,amount_cents,kind,transfer_id,notes) values ($1,$2,$3,$4,'transfer',$5,$6)",
      [id(), b.date, b.destination, amount.toString(), tid, b.notes],
    );
  await audit(q, "cash", tid ?? id(), "create", b);
  return { ok: true };
}
export async function list(q: Query, resource: string): Promise<Row[]> {
  if (
    ["products", "inventory", "inventory-counts", "reconciliations"].includes(resource) &&
    (await q.query("select inventory_mode from settings")).rows[0]?.inventory_mode === "external"
  )
    throw new AppError("not_found", "Este módulo fue retirado.", 404);
  switch (resource) {
    case "serial-records":
      return (
        await q.query("select * from serial_records order by date desc,created_at desc,id")
      ).rows.map((r) => ({
        ...r,
        billing_status: !r.will_invoice
          ? "No se facturará"
          : r.invoice_date
            ? "Facturada"
            : "Pendiente de facturar",
        ...warrantyDetails(
          r.invoice_date,
          r.warranty_months,
          !!r.customer_name,
          localDate(new Date().toISOString()),
          r.will_invoice,
          r.sale_date,
        ),
      }));
    case "products":
      return (
        await q.query(
          "select p.*,c.name as category,coalesce(s.quantity,0)::text as stock,coalesce(s.value,0)::text as value_cents from products p left join categories c on c.id=p.category_id left join (select product_id,sum(quantity) quantity,sum(value_cents) value from inventory_movements where voided_at is null group by product_id) s on s.product_id=p.id order by p.name",
        )
      ).rows;
    case "suppliers":
      return (await q.query("select * from suppliers order by name")).rows;
    case "categories":
      return (await q.query("select * from categories order by name")).rows;
    case "purchases":
      return (
        await q.query(
          "select p.*,s.name as supplier,coalesce(c.paid,0)::text as paid_cents,coalesce(c.recovered,0)::text as recovered_cents,greatest(coalesce(c.paid,0)-coalesce(c.recovered,0),0)::text as recoverable_cents from purchases p left join suppliers s on s.id=p.supplier_id left join (select purchase_id,sum(-amount_cents) filter(where kind='purchase') paid,sum(amount_cents) filter(where kind='recovery') recovered from cash_movements where purchase_id is not null group by purchase_id) c on c.purchase_id=p.id order by p.date desc,p.created_at desc",
        )
      ).rows;
    case "expenses":
      return (
        await q.query(
          "select e.*,coalesce(c.paid,0)::text as paid_cents,coalesce(c.recovered,0)::text as recovered_cents,greatest(coalesce(c.paid,0)-coalesce(c.recovered,0),0)::text as recoverable_cents from expenses e left join (select expense_id,sum(-amount_cents) filter(where kind='expense') paid,sum(amount_cents) filter(where kind='recovery') recovered from cash_movements where expense_id is not null group by expense_id) c on c.expense_id=e.id order by date desc,created_at desc",
        )
      ).rows;
    case "incomes": {
      const rows = (
        await q.query(
          "select i.*,c.name as category,p.name as product from incomes i left join categories c on c.id=i.category_id left join products p on p.id=i.product_id order by i.from_date desc,i.created_at desc",
        )
      ).rows;
      const enabled =
        (await q.query("select fiscal_profile from settings")).rows[0]?.fiscal_profile ===
        "resico_pf_16";
      const rules = (
        await q.query(
          "select method,percent,fixed_cents,tax_percent,msi_percent,installments from fee_rules",
        )
      ).rows as CardFeeRule[];
      const appliedFees = new Map(
        (await q.query("select * from income_card_fee_estimates")).rows.map((r) => [
          r.income_id,
          r,
        ]),
      );
      const appliedMsiFees = new Map(
        (await q.query("select * from income_msi_fee_estimates")).rows.map((r) => [r.income_id, r]),
      );
      return rows.map((r) => {
        const appliedFee = appliedFees.get(r.id);
        const msiFee = appliedMsiFees.get(r.id),
          plan = cardInstallmentPlan(r.clip_financial_raw);
        const pendingCard =
          r.status === "active" &&
          BigInt(r.gross_cents) > 0n &&
          r.channel === "clip" &&
          r.source !== "manual_summary" &&
          !r.settled_at &&
          r.fees_cents === null;
        const proposed = pendingCard
          ? estimateCardFee(String(r.gross_cents), rules, r.clip_financial_raw)
          : null;
        let fee_estimate: Row | null = proposed;
        const charged =
          BigInt(appliedFee?.processing_cents ?? 0) + BigInt(msiFee?.financing_cents ?? 0);
        if (pendingCard && appliedFee) {
          const financing = BigInt(msiFee?.financing_cents ?? proposed?.financing_cents ?? 0),
            financingTax = BigInt(msiFee?.tax_cents ?? proposed?.financing_tax_cents ?? 0);
          const total = BigInt(appliedFee.processing_cents) + financing;
          fee_estimate = {
            ...appliedFee.rule_snapshot,
            msi: plan.msi,
            installments: plan.installments,
            msi_priced: !!msiFee || !!proposed?.msi,
            msi_percent: msiFee?.rule_snapshot.msi_percent ?? proposed?.msi_percent ?? "0",
            processing_cents: appliedFee.processing_cents,
            processing_tax_cents: appliedFee.tax_cents,
            financing_cents: financing.toString(),
            financing_tax_cents: financingTax.toString(),
            financing_tax_percent:
              msiFee?.rule_snapshot.tax_percent ?? proposed?.tax_percent ?? null,
            tax_cents: (BigInt(appliedFee.tax_cents) + financingTax).toString(),
            total_cents: total.toString(),
            deposited_cents:
              total <= BigInt(r.gross_cents) ? (BigInt(r.gross_cents) - total).toString() : null,
          };
        } else if (fee_estimate) fee_estimate = { ...fee_estimate, msi_priced: !!fee_estimate.msi };
        const feeFields = {
          fee_estimate,
          applied_fee_breakdown: appliedFee
            ? {
                ...appliedFee.rule_snapshot,
                processing_cents: appliedFee.processing_cents,
                processing_tax_cents: appliedFee.tax_cents,
                financing_cents: msiFee?.financing_cents ?? "0",
                financing_tax_cents: msiFee?.tax_cents ?? "0",
                financing_tax_percent: msiFee?.rule_snapshot.tax_percent ?? null,
                tax_cents: (
                  BigInt(appliedFee.tax_cents) + BigInt(msiFee?.tax_cents ?? 0)
                ).toString(),
                total_cents: charged.toString(),
                deposited_cents: (BigInt(r.gross_cents) - charged).toString(),
                msi: !!msiFee,
                installments: msiFee?.installments ?? 1,
                msi_percent: msiFee?.rule_snapshot.msi_percent ?? "0",
              }
            : null,
          fee_applied: !!appliedFee,
          msi_fee_applied: !!msiFee,
          fee_applied_cents: charged.toString(),
          fee_net_applied_cents: (BigInt(r.gross_cents) - charged).toString(),
          card_plan: plan,
          fee_missing_rule: pendingCard && !proposed && !msiFee && (plan.msi || plan.needsReview),
          fee_needs_apply:
            pendingCard && !!fee_estimate && (!appliedFee || (plan.msi && !msiFee && !!proposed)),
        };
        if (!enabled) return { ...r, ...feeFields };
        const net = effectiveNet(r);
        return {
          ...r,
          ...feeFields,
          net_calculated: r.net_cents === null && net !== null,
          net_cents: net,
          vat_cents: net === null ? null : (BigInt(r.gross_cents) - BigInt(net)).toString(),
          fees_cents:
            r.fees_cents === null && r.source === "clip_import" && r.channel !== "clip"
              ? "0"
              : r.fees_cents,
        };
      });
    }
    case "inventory":
      return (
        await q.query(
          "select m.*,p.name as product,p.sku from inventory_movements m join products p on p.id=m.product_id order by date desc,created_at desc",
        )
      ).rows;
    case "cash":
      return (
        await q.query(
          "select m.*,a.name as account from cash_movements m join cash_accounts a on a.id=m.account_id order by date desc,created_at desc",
        )
      ).rows;
    case "accounts":
      return (
        await q.query(
          "select a.*,coalesce(sum(m.amount_cents),0)::text as balance_cents from cash_accounts a left join cash_movements m on m.account_id=a.id group by a.id order by a.id",
        )
      ).rows;
    case "imports":
      return (
        await q.query(
          "select id,filename,source,status,created_at,rejected_at,rejection_reason,jsonb_array_length(rows) as row_count from imports order by created_at desc",
        )
      ).rows;
    case "closes":
      return (await q.query("select * from monthly_closes order by month desc")).rows;
    case "audit":
      return (await q.query("select * from audit_events order by created_at desc limit 200")).rows;
    case "fee-rules":
      return (await q.query("select * from fee_rules order by method")).rows;
    case "inventory-counts":
      return (await q.query("select * from inventory_counts order by date desc")).rows;
    case "reconciliations":
      return (
        await q.query("select * from inventory_reconciliations order by date desc,created_at desc")
      ).rows;
    case "refunds":
      return (
        await q.query(
          "select r.*,i.description from income_refunds r join incomes i on i.id=r.income_id order by date desc",
        )
      ).rows;
    case "templates":
      return (await q.query("select * from expense_templates order by concept")).rows;
    default:
      throw new AppError("not_found", "No existe ese recurso.", 404);
  }
}
export async function reconciliation(q: Query, raw: unknown) {
  const b = z
    .object({
      date,
      reason: z.string().trim().min(8).max(1000),
      lines: z
        .array(
          z.object({
            product_id: uuid,
            clip_quantity: z.string().regex(/^\d{1,10}(\.\d{1,6})?$/),
            unit_cost: money,
          }),
        )
        .max(1000),
    })
    .parse(raw);
  await ensureOpening(q, b.date);
  if ((await q.query("select inventory_mode from settings")).rows[0]?.inventory_mode !== "detailed")
    throw new AppError(
      "inventory_mode",
      "En el control por totales utiliza cortes del inventario, sin ajustes por producto.",
    );
  const products = (await q.query("select id from products")).rows;
  const received = new Set(b.lines.map((l) => l.product_id));
  if (
    received.size !== b.lines.length ||
    products.length !== received.size ||
    products.some((p) => !received.has(p.id))
  )
    throw new AppError(
      "full_reconciliation_required",
      "Incluye una vez cada producto del catálogo para conciliar el inventario completo.",
    );
  const cutoff = new Date(new Date(b.date + "T12:00:00Z").getTime() + 86400000)
    .toISOString()
    .slice(0, 10);
  const snapshot: Row[] = [];
  for (const l of b.lines) {
    const before = (
      await q.query(
        "select coalesce(sum(quantity),0)::text as quantity,coalesce(sum(value_cents),0)::text as value from inventory_movements where product_id=$1 and date<$2 and voided_at is null",
        [l.product_id, cutoff],
      )
    ).rows[0]!;
    const diff = new Decimal(l.clip_quantity).minus(before.quantity);
    snapshot.push({ ...l, financial_quantity: before.quantity, difference: diff.toFixed() });
    if (!diff.isZero()) {
      await q.query(
        "insert into inventory_movements(id,product_id,date,quantity,value_cents,kind,reason) values ($1,$2,$3,$4,$5,'adjustment',$6)",
        [
          id(),
          l.product_id,
          b.date,
          diff.toFixed(),
          diff.gt(0) ? lineCost(diff.toFixed(), l.unit_cost).toString() : "0",
          "Conciliación Clip: " + b.reason,
        ],
      );
      await revalue(q, l.product_id);
    }
  }
  const rid = id();
  await q.query(
    "insert into inventory_reconciliations(id,date,reason,snapshot) values ($1,$2,$3,$4)",
    [rid, b.date, b.reason, JSON.stringify(snapshot)],
  );
  await audit(q, "inventory", rid, "reconcile", snapshot, b.reason);
  return { id: rid, differences: snapshot };
}
export async function refund(q: Query, raw: unknown) {
  const b = z
    .object({
      income_id: uuid,
      date,
      gross: money,
      net: money.nullable(),
      cogs: money.nullable(),
      quantity: quantity.nullable().optional(),
      reason: z.string().trim().min(8).max(1000),
    })
    .parse(raw);
  await ensureOpening(q, b.date);
  const original = (
    await q.query("select * from incomes where id=$1 and status='active'", [b.income_id])
  ).rows[0];
  if (!original) throw new AppError("not_found", "Ingreso no disponible.", 404);
  if (b.date < new Date(Date.parse(original.to_date) - 86400000).toISOString().slice(0, 10))
    throw new AppError("invalid_date", "La devolución no puede preceder al ingreso.");
  const prev = (
    await q.query(
      "select coalesce(sum(gross_cents),0)::text as gross,coalesce(sum(net_cents),0)::text as net,coalesce(sum(cogs_cents),0)::text as cogs,coalesce(sum(quantity),0)::text as quantity from income_refunds where income_id=$1",
      [b.income_id],
    )
  ).rows[0]!;
  const gross = cents(b.gross);
  if (!gross || gross + BigInt(prev.gross) > BigInt(original.gross_cents))
    throw new AppError("refund_exceeds", "La devolución excede el importe disponible del ingreso.");
  let cost = b.cogs === null ? null : cents(b.cogs);
  const net = b.net === null ? null : cents(b.net);
  if (
    net !== null &&
    (net > gross ||
      (original.net_cents !== null && net + BigInt(prev.net) > BigInt(original.net_cents)))
  )
    throw new AppError("refund_exceeds", "La devolución sin IVA excede la venta documentada.");
  if (original.product_id) {
    if (!b.quantity)
      throw new AppError("quantity_required", "Indica las unidades que regresan al inventario.");
    if (new Decimal(prev.quantity).plus(b.quantity).gt(original.quantity))
      throw new AppError("refund_quantity", "Se devuelven más unidades de las vendidas.");
    cost = new Decimal(prev.quantity).plus(b.quantity).equals(original.quantity)
      ? BigInt(original.cogs_cents) - BigInt(prev.cogs)
      : BigInt(
          new Decimal(original.cogs_cents).times(b.quantity).div(original.quantity).toFixed(0),
        );
  }
  if (
    cost !== null &&
    original.cogs_cents !== null &&
    cost + BigInt(prev.cogs) > BigInt(original.cogs_cents)
  )
    throw new AppError("refund_exceeds", "El costo devuelto excede el costo de la venta.");
  const rid = id();
  await q.query(
    "insert into income_refunds(id,income_id,date,gross_cents,net_cents,cogs_cents,quantity,reason) values ($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      rid,
      b.income_id,
      b.date,
      gross.toString(),
      net?.toString() ?? null,
      cost?.toString() ?? null,
      b.quantity ?? null,
      b.reason,
    ],
  );
  if (original.product_id) {
    await q.query(
      "insert into inventory_movements(id,product_id,date,quantity,value_cents,kind,refund_id,reason) values ($1,$2,$3,$4,$5,'return',$6,$7)",
      [id(), original.product_id, b.date, b.quantity, cost!.toString(), rid, b.reason],
    );
    await revalue(q, original.product_id);
  }
  await audit(q, "refund", rid, "create", b, b.reason);
  return { id: rid };
}
