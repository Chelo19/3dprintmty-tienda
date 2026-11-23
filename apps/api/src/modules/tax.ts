import { createHash } from "node:crypto";
import { roundRatio, effectiveNet, resicoTax } from "./tax-math";
import { z } from "zod";
import { AppError, type Row, type Metric } from "@tienda/shared";
import { cents, major, monthBounds } from "@tienda/domain";
import { type Query, audit, unlocked } from "../db/database";
import { date, money, uuid } from "./validation";
import { id, ensureOpening } from "./store";
const monthInput = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const reference = z.string().trim().min(5).max(20000);
async function costSignature(q: Query, month: string) {
  const b = monthBounds(month);
  const incomes = (
    await q.query(
      "select id,gross_cents,status from incomes where from_date>=$1 and to_date<=$2 order by id",
      [b.from, b.to],
    )
  ).rows;
  const refunds = (
    await q.query(
      "select id,income_id,gross_cents from income_refunds where date>=$1 and date<$2 order by id",
      [b.from, b.to],
    )
  ).rows;
  return createHash("sha256").update(JSON.stringify({ incomes, refunds })).digest("hex");
}
export async function saveMonthlyCost(q: Query, raw: unknown) {
  const b = z
    .object({ month: monthInput, amount: money, reference, active: z.boolean().default(true) })
    .parse(raw);
  const bounds = monthBounds(b.month),
    settings = (await q.query("select * from settings")).rows[0];
  if (!settings) throw new AppError("opening_required", "Registra la apertura primero.");
  await ensureOpening(
    q,
    bounds.to > settings?.opening_date
      ? bounds.from < settings.opening_date
        ? settings.opening_date
        : bounds.from
      : bounds.from,
  );
  if (settings.inventory_mode !== "external")
    throw new AppError("cost_mode", "El costo mensual requiere el control externo de mercancía.");
  const before = (await q.query("select * from monthly_cogs where month=$1 for update", [b.month]))
    .rows[0];
  await q.query(
    "insert into monthly_cogs(month,amount_cents,reference,active,source_signature) values ($1,$2,$3,$4,$5) on conflict(month) do update set amount_cents=excluded.amount_cents,reference=excluded.reference,active=excluded.active,source_signature=excluded.source_signature,updated_at=now()",
    [b.month, cents(b.amount).toString(), b.reference, b.active, await costSignature(q, b.month)],
  );
  await audit(q, "monthly_cost", b.month, "save", { before, after: b }, b.reference);
  return { month: b.month };
}
export async function saveTaxInputs(q: Query, raw: unknown) {
  const b = z
    .object({
      month: monthInput,
      isr_withheld: money.default("0"),
      vat_withheld: money.default("0"),
      vat_carry: money.default("0"),
      reference,
    })
    .strict()
    .parse(raw);
  await unlocked(q, b.month + "-01");
  const before = (
    await q.query("select * from monthly_tax_inputs where month=$1 for update", [b.month])
  ).rows[0];
  await q.query(
    `insert into monthly_tax_inputs(month,scope,other_income_cents,other_vat_collected_cents,other_vat_creditable_cents,isr_withheld_cents,vat_withheld_cents,vat_carry_cents,reference) values ($1,'store',0,0,0,$2,$3,$4,$5)
    on conflict(month) do update set scope='store',isr_withheld_cents=excluded.isr_withheld_cents,vat_withheld_cents=excluded.vat_withheld_cents,vat_carry_cents=excluded.vat_carry_cents,reference=excluded.reference,updated_at=now()`,
    [
      b.month,
      ...[b.isr_withheld, b.vat_withheld, b.vat_carry].map((v) => cents(v).toString()),
      b.reference,
    ],
  );
  await audit(q, "monthly_tax", b.month, "save", { before, after: b }, b.reference);
  return { month: b.month };
}
export async function taxSources(q: Query): Promise<Row[]> {
  return (
    await q.query(`select p.id,'purchase' as type,p.date,
    coalesce(s.name,'Proveedor sin asignar') || ' · ' || coalesce(nullif(p.reference,''),'Sin referencia') as label,
    p.total_cents,p.tax_cents as vat_cents,p.status,coalesce(p.summary_cost_cents,p.total_cents-p.tax_cents) as cost_cents,
    'merchandise' as kind,null::text as tax_mode,p.reference,false as fee_calculated
    from purchases p left join suppliers s on s.id=p.supplier_id
    union all select e.id,'expense',e.date,e.concept,(e.amount_cents+e.tax_cents),e.tax_cents,e.status,e.amount_cents,e.kind,e.tax_mode,'',false from expenses e
    union all select i.id,'fee',i.settlement_date,i.description,(i.processing_fee_cents+i.financing_withheld_cents),i.fee_creditable_tax_cents,i.status,i.fees_cents,'operating',null::text,i.settlement_reference,false from incomes i where i.settled_at is not null
    union all select i.id,'fee',greatest(b.date,coalesce(m.date,b.date)),i.description,
      b.processing_cents+coalesce(m.financing_cents,0),b.tax_cents+coalesce(m.tax_cents,0),i.status,
      b.processing_cents+coalesce(m.financing_cents,0)-b.tax_cents-coalesce(m.tax_cents,0),'operating',null::text,'Comisión calculada según tarifa',true
      from incomes i join income_card_fee_estimates b on b.income_id=i.id left join income_msi_fee_estimates m on m.income_id=i.id where i.settled_at is null
    order by date desc`)
  ).rows;
}
export async function taxDocuments(q: Query, until?: string, payments?: Row[]): Promise<Row[]> {
  const docs = (await q.query("select * from tax_documents")).rows;
  const byId = new Map(docs.map((d) => [d.purchase_id ?? d.expense_id ?? d.income_id, d]));
  const cash =
    payments ??
    (
      await q.query("select * from cash_movements where ($1::date is null or date<$1)", [
        until ?? null,
      ])
    ).rows;
  const grouped = new Map<string, Row[]>();
  for (const p of cash) {
    const key = p.purchase_id
      ? "purchase:" + p.purchase_id
      : p.expense_id
        ? "expense:" + p.expense_id
        : null;
    if (key) {
      const list = grouped.get(key) ?? [];
      list.push(p);
      grouped.set(key, list);
    }
  }
  return (await taxSources(q)).map((s) => {
    const explicit = byId.get(s.id);
    const automaticNoCredit = s.type === "expense" && s.tax_mode === "total_no_credit";
    const proof =
      explicit ??
      (automaticNoCredit
        ? {
            status: "nonrecoverable",
            notes: "Tratamiento ya declarado al registrar el gasto como total sin IVA acreditable.",
            automatic: true,
          }
        : null);
    const payments = grouped.get(s.type + ":" + s.id) ?? [];
    let paid =
      s.type === "fee"
        ? !until || s.date < until
          ? BigInt(s.total_cents)
          : 0n
        : payments.reduce((v, p) => v - BigInt(p.amount_cents), 0n);
    const total = BigInt(s.total_cents);
    paid = paid < 0n ? 0n : paid > total ? total : paid;
    const suggestedUuid = uuid.safeParse(String(s.reference ?? "").trim());
    return {
      ...s,
      proof,
      automatic_treatment: !explicit && automaticNoCredit,
      paid_cents: paid.toString(),
      pending_cents: (total - paid).toString(),
      vat_paid_cents: roundRatio(BigInt(s.vat_cents ?? 0), paid, total).toString(),
      invoice_uuid_suggestion: suggestedUuid.success ? suggestedUuid.data : null,
      cost_cents: (
        BigInt(s.cost_cents ?? 0) +
        (proof?.status === "nonrecoverable" ? BigInt(s.vat_cents ?? 0) : 0n)
      ).toString(),
      default_notes:
        "Comprobación de " +
        { purchase: "compra", expense: "gasto", fee: "comisiones" }[
          s.type as "purchase" | "expense" | "fee"
        ] +
        " · " +
        s.label +
        " · " +
        s.date,
    };
  });
}
export async function sourceSummary(q: Query, from: string, to: string) {
  const payments = (await q.query("select * from cash_movements where date<$1", [to])).rows;
  const docs = await taxDocuments(q, to, payments);
  const current = docs.filter((d) => d.status === "active" && d.date >= from && d.date < to);
  const purchases = current.filter((d) => d.type === "purchase"),
    expenses = current.filter((d) => d.type === "expense" && d.kind === "operating");
  const assets = current.filter((d) => d.type === "expense" && d.kind === "asset");
  const sum = (rows: Row[], key: string) => rows.reduce((v, r) => v + BigInt(r[key] ?? 0), 0n);
  const inPeriod = payments.filter((p) => p.date >= from);
  const paid = (kind: string) =>
    -sum(
      inPeriod.filter((p) => p.kind === kind),
      "amount_cents",
    );
  const pending = docs.filter(
    (d) =>
      d.status === "active" &&
      BigInt(d.vat_cents ?? 0) > 0n &&
      d.proof?.status !== "nonrecoverable" &&
      (d.proof?.status !== "creditable" || d.proof.eligible_on >= to),
  );
  return {
    purchase_count: purchases.length,
    expense_count: expenses.length,
    purchases_total: asMetric(sum(purchases, "total_cents")),
    acquisition_cost: asMetric(sum(purchases, "cost_cents")),
    expenses_total: asMetric(sum(expenses, "total_cents")),
    operating_expense: asMetric(sum(expenses, "cost_cents")),
    assets_total: asMetric(sum(assets, "total_cents")),
    purchases_paid: asMetric(paid("purchase")),
    expenses_paid: asMetric(paid("expense")),
    recoveries: asMetric(
      sum(
        inPeriod.filter((p) => p.kind === "recovery"),
        "amount_cents",
      ),
    ),
    vat_recorded: asMetric(sum(current, "vat_cents")),
    vat_paid_pending: asMetric(sum(pending, "vat_paid_cents")),
  };
}
export async function saveTaxDocument(q: Query, raw: unknown) {
  const b = z
    .object({
      id: uuid,
      type: z.enum(["purchase", "expense", "fee"]),
      status: z.enum(["pending", "creditable", "nonrecoverable"]),
      invoice_uuid: uuid.optional(),
      invoice_vat: money.optional(),
      eligible_on: date.optional(),
      notes: reference,
    })
    .parse(raw);
  const sources = await taxSources(q);
  const source = sources.find((s) => s.id === b.id && s.type === b.type);
  if (!source) throw new AppError("not_found", "Documento fiscal no disponible.", 404);
  await unlocked(q, source.date);
  const key =
    b.type === "purchase" ? "purchase_id" : b.type === "expense" ? "expense_id" : "income_id";
  const before = (await q.query(`select * from tax_documents where ${key}=$1 for update`, [b.id]))
    .rows[0];
  if (before?.eligible_on) await unlocked(q, before.eligible_on);
  if (b.status === "creditable") {
    if (!b.invoice_uuid || !b.invoice_vat || !b.eligible_on)
      throw new AppError(
        "invoice_required",
        "Captura UUID, IVA total del CFDI y fecha de comprobación.",
      );
    if (source.status !== "active" || BigInt(source.vat_cents) <= 0n)
      throw new AppError(
        "invalid_vat",
        "El documento no tiene IVA acreditable registrado o está cancelado.",
      );
    if (b.eligible_on < source.date)
      throw new AppError(
        "invalid_date",
        "La comprobación no puede ser anterior al documento o liquidación.",
      );
    await unlocked(q, b.eligible_on);
    const same = (
      await q.query(
        `select * from tax_documents where status='creditable' and invoice_uuid=$1 and id<>$2`,
        [b.invoice_uuid, before?.id ?? id()],
      )
    ).rows;
    const limit = cents(b.invoice_vat);
    if (
      same.some((s) => BigInt(s.invoice_vat_cents) !== limit) ||
      same.reduce(
        (v, s) =>
          v +
          BigInt(
            sources.find((source) => source.id === (s.purchase_id ?? s.expense_id ?? s.income_id))
              ?.vat_cents ?? 0,
          ),
        BigInt(source.vat_cents),
      ) > limit
    )
      throw new AppError(
        "invoice_overallocated",
        "El IVA asignado excede el total del CFDI o contradice su importe registrado.",
      );
  }
  await q.query(
    `insert into tax_documents(id,${key},status,invoice_uuid,invoice_vat_cents,eligible_on,notes) values ($1,$2,$3,$4,$5,$6,$7) on conflict(${key}) do update set status=excluded.status,invoice_uuid=excluded.invoice_uuid,invoice_vat_cents=excluded.invoice_vat_cents,eligible_on=excluded.eligible_on,notes=excluded.notes,updated_at=now()`,
    [
      before?.id ?? id(),
      b.id,
      b.status,
      b.status === "creditable" ? b.invoice_uuid : null,
      b.status === "creditable" ? cents(b.invoice_vat!).toString() : null,
      b.status === "creditable" ? b.eligible_on : null,
      b.notes,
    ],
  );
  await audit(q, "tax_document", b.id, "save", { before, after: b }, b.notes);
  return { id: b.id };
}
const asMetric = (v: bigint | null, reason?: string): Metric => ({
  value: v === null ? null : major(v),
  status: v === null ? "no_disponible" : reason ? "parcial" : "completo",
  ...(reason ? { reason } : {}),
});
export async function externalCost(q: Query, from: string, to: string, openingDate: string | null) {
  const months: string[] = [];
  let cursor = from.slice(0, 7);
  while (monthBounds(cursor).from < to) {
    if (!openingDate || monthBounds(cursor).to > openingDate) months.push(cursor);
    cursor = monthBounds(cursor).to.slice(0, 7);
  }
  const saved = (await q.query("select * from monthly_cogs where month=any($1::text[])", [months]))
    .rows;
  if (!saved.length)
    return {
      value: null,
      usesMonthly: false,
      reason: "Captura el costo vendido mensual con respaldo externo.",
    };
  let total = 0n;
  for (const month of months) {
    const b = monthBounds(month),
      start = openingDate && openingDate > b.from ? openingDate : b.from;
    const r = saved.find((r) => r.month === month);
    if (r?.active && r.source_signature !== (await costSignature(q, month)))
      return {
        value: null,
        usesMonthly: true,
        reason:
          "Hay ventas o devoluciones nuevas desde el cálculo del costo mensual. Revisa y confirma de nuevo su importe.",
      };
    if (!r?.active)
      return {
        value: null,
        usesMonthly: true,
        reason: "Falta confirmar el costo vendido mensual de " + month + ".",
      };
    if (from > start || to < b.to)
      return {
        value: null,
        usesMonthly: true,
        reason:
          "El costo mensual se aplica solo a periodos completos de operación; no se prorratea por días.",
      };
    total += BigInt(r.amount_cents);
  }
  return { value: total, usesMonthly: true, reason: undefined };
}
export async function fiscalSummary(q: Query, from: string, to: string) {
  const settings = (await q.query("select * from settings")).rows[0];
  if (settings?.fiscal_profile !== "resico_pf_16") return undefined;
  const payments = (
    await q.query("select * from cash_movements where date<$1 order by date,id", [to])
  ).rows;
  const sources = await taxDocuments(q, to, payments);
  const incomes = (
    await q.query("select * from incomes where status='active' and from_date<$1", [to])
  ).rows;
  const receiptsByIncome = new Map<string, Row[]>(),
    paidByPurchase = new Map<string, Row[]>(),
    paidByExpense = new Map<string, Row[]>();
  for (const p of payments) {
    const add = (map: Map<string, Row[]>, key: string) => {
      const rows = map.get(key) ?? [];
      rows.push(p);
      map.set(key, rows);
    };
    if (p.income_id && p.kind === "collection") add(receiptsByIncome, p.income_id);
    if (p.purchase_id) add(paidByPurchase, p.purchase_id);
    if (p.expense_id) add(paidByExpense, p.expense_id);
  }

  const taxInputs = (
    await q.query(
      "select month,isr_withheld_cents,vat_withheld_cents,vat_carry_cents from monthly_tax_inputs where scope='store'",
    )
  ).rows;
  const refundCount = (
    await q.query("select count(*)::int as n from income_refunds where date>=$1 and date<$2", [
      from,
      to,
    ])
  ).rows[0]!.n;
  const monthly: Row[] = [];
  let cursor = from.slice(0, 7);
  while (monthBounds(cursor).from < to) {
    const b = monthBounds(cursor),
      start = from > b.from ? from : b.from,
      end = to < b.to ? to : b.to;
    let base = 0n,
      vat = 0n,
      credits = 0n,
      unknown = 0,
      pending = 0;
    for (const income of incomes) {
      const collected = receiptsByIncome.get(income.id) ?? [];
      const paidBefore = collected
        .filter((p) => p.date < start)
        .reduce((v, p) => v + BigInt(p.amount_cents), 0n);
      const paidEnd = collected
        .filter((p) => p.date < end)
        .reduce((v, p) => v + BigInt(p.amount_cents), 0n);
      if (
        !collected.length &&
        income.source !== "manual_summary" &&
        BigInt(income.gross_cents) > 0n &&
        income.from_date >= start &&
        income.from_date < end
      ) {
        unknown++;
        continue;
      }
      if (paidEnd === paidBefore) continue;
      const net = effectiveNet(income),
        gross = BigInt(income.gross_cents);
      if (net === null) {
        unknown++;
        continue;
      }
      const clamp = (v: bigint) => (v > gross ? gross : v);
      const netPaid =
        roundRatio(BigInt(net), clamp(paidEnd), gross) -
        roundRatio(BigInt(net), clamp(paidBefore), gross);
      base += netPaid;
      vat += clamp(paidEnd) - clamp(paidBefore) - netPaid;
    }
    for (const s of sources) {
      if (BigInt(s.vat_cents ?? 0) === 0n) continue;
      const proof = s.proof;
      const docPaid = (before: string) =>
        s.type === "fee"
          ? s.date < before
            ? BigInt(s.total_cents)
            : 0n
          : ((s.type === "purchase" ? paidByPurchase : paidByExpense).get(s.id) ?? [])
              .filter((p) => p.date < before)
              .reduce((v, p) => v - BigInt(p.amount_cents), 0n);
      const endPaid = docPaid(end);
      if (endPaid <= 0n) continue;
      if (proof?.status === "nonrecoverable") continue;
      if (s.status !== "active" || proof?.status !== "creditable" || proof.eligible_on >= end) {
        pending++;
        continue;
      }
      const beforePaid = proof.eligible_on >= start ? 0n : docPaid(start);
      const total = BigInt(s.total_cents),
        v = BigInt(s.vat_cents);
      const allocated = (p: bigint) => roundRatio(v, p < 0n ? 0n : p > total ? total : p, total);
      credits += allocated(endPaid) - allocated(beforePaid);
    }
    const extra = taxInputs.find((r) => r.month === cursor),
      complete =
        start <=
          (settings.opening_date && settings.opening_date > b.from
            ? settings.opening_date
            : b.from) && end >= b.to;
    const unresolved = unknown > 0 || refundCount > 0;
    const yearStart = cursor.slice(0, 4) + "-01-01";
    let knownAnnual = 0n;
    for (const income of incomes) {
      const n = effectiveNet(income);
      if (n === null) continue;
      const g = BigInt(income.gross_cents);
      const receipts = receiptsByIncome.get(income.id) ?? [];
      const at = (d: string) => {
        const v = receipts
          .filter((p) => p.date < d)
          .reduce((v, p) => v + BigInt(p.amount_cents), 0n);
        return v > g ? g : v;
      };
      knownAnnual += roundRatio(BigInt(n), at(b.to), g) - roundRatio(BigInt(n), at(yearStart), g);
    }
    const annualLimitExceeded = knownAnnual > 350000000n;
    const tax = !unresolved && complete && !annualLimitExceeded ? resicoTax(base) : null;
    const isrDue = tax ? tax.tax - BigInt(extra?.isr_withheld_cents ?? 0) : null;
    const vatBalance =
      !unresolved && complete
        ? vat -
          credits -
          BigInt(extra?.vat_withheld_cents ?? 0) -
          BigInt(extra?.vat_carry_cents ?? 0)
        : null;
    const reason = !complete
      ? "Periodo parcial: estimación al corte, no impuesto mensual definitivo."
      : undefined;
    monthly.push({
      month: cursor,
      known_annual_income: major(knownAnnual),
      annual_limit_exceeded: annualLimitExceeded,
      store_base: major(base),
      store_vat: unresolved ? null : major(vat),
      creditable_vat: major(credits),
      pending_documents: pending,
      unknown_sales: unknown,
      rate: tax?.rate ?? null,
      isr_estimate: tax ? major(tax.tax) : null,
      isr_due: isrDue === null ? null : major(isrDue < 0n ? 0n : isrDue),
      isr_withheld_excess: isrDue !== null && isrDue < 0n ? major(-isrDue) : "0.00",
      vat_due: vatBalance === null ? null : major(vatBalance > 0n ? vatBalance : 0n),
      vat_favor: vatBalance === null ? null : major(vatBalance < 0n ? -vatBalance : 0n),
      adjustments: extra ?? null,
      reason,
      pending_reason: unresolved
        ? "Hay cobros especiales o devoluciones que requieren comprobación fiscal."
        : annualLimitExceeded
          ? "Los ingresos anuales registrados de esta tienda superan $3,500,000. Revisa la permanencia en RESICO."
          : !tax
            ? !complete
              ? "Selecciona meses completos para estimar el ISR y el IVA de esta tienda."
              : "Revisa el límite de ingresos y la permanencia en RESICO."
            : null,
    });
    cursor = b.to.slice(0, 7);
  }
  const sumField = (key: string) =>
    monthly.every((r) => r[key] !== null) ? monthly.reduce((v, r) => v + cents(r[key]), 0n) : null;
  const reason = monthly.some((r) => r.reason)
    ? "Rango parcial: estimación al corte."
    : monthly.some((r) => r.pending_documents)
      ? "Hay IVA pagado pendiente de CFDI o revisión."
      : undefined;
  return {
    profile: "RESICO persona física · IVA 16% incluido",
    monthly,
    vat_collected: asMetric(sumField("store_vat")),
    vat_creditable: asMetric(sumField("creditable_vat"), reason),
    vat_due: asMetric(sumField("vat_due"), reason),
    vat_favor: asMetric(sumField("vat_favor"), reason),
    isr_estimate: asMetric(sumField("isr_estimate"), reason),
    isr_due: asMetric(sumField("isr_due"), reason),
    notice:
      "Estimaciones únicamente de esta tienda. El ISR usa la tasa que correspondería a sus ingresos registrados de forma aislada. Tu declaración real puede variar al considerar las demás actividades del mismo RFC. Los ajustes, retenciones y saldos capturados aquí deben corresponder solo a esta tienda.",
  };
}

export async function enableFiscalProfile(q: Query) {
  const before = (await q.query("select * from settings where id=1 for update")).rows[0];
  if (!before) throw new AppError("opening_required", "Registra los ajustes iniciales.");
  if (before.fiscal_profile === "resico_pf_16") return { ok: true };
  if (before.opening_date) await unlocked(q, before.opening_date);
  await q.query("update settings set fiscal_profile='resico_pf_16' where id=1");
  await audit(
    q,
    "settings",
    "1",
    "fiscal_profile",
    { before: before.fiscal_profile, after: "resico_pf_16" },
    "Perfil confirmado: RESICO persona física con IVA del 16% incluido.",
  );
  return { ok: true };
}
