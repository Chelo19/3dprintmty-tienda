import { AppError, type Row } from "@tienda/shared";
import { estimateCardFee, cardInstallmentPlan, type CardFeeRule } from "@tienda/domain";
import { audit, type Query } from "../db/database";
import { ensureOpening, id } from "./store";

/** Apply a tariff once as a separate Clip outflow. Never rewrite the imported sale or receipt. */
export async function applyCardFees(q: Query, incomeIds: string[], required = false) {
  if (!incomeIds.length) return { applied_count: 0, already_applied_count: 0 };
  const items = (
    await q.query("select * from incomes where id=any($1::uuid[]) order by id for update", [
      incomeIds,
    ])
  ).rows;
  const existing = (
    await q.query(
      "select income_id from income_card_fee_estimates where income_id=any($1::uuid[])",
      [incomeIds],
    )
  ).rows;
  const applied = new Set(existing.map((r) => r.income_id));
  const rules = (
    await q.query(
      "select method,percent,fixed_cents,tax_percent,msi_percent,installments from fee_rules",
    )
  ).rows as CardFeeRule[];
  const cash = (
    await q.query("select * from cash_movements where income_id=any($1::uuid[])", [incomeIds])
  ).rows;
  const payments = new Map<string, Row[]>();
  for (const row of cash)
    payments.set(row.income_id, [...(payments.get(row.income_id) ?? []), row]);
  const rows: Row[] = [];
  const checkedDates = new Set<string>();
  for (const item of items) {
    if (applied.has(item.id)) continue;
    if (
      item.status !== "active" ||
      item.channel !== "clip" ||
      item.source === "manual_summary" ||
      item.settled_at ||
      item.fees_cents !== null ||
      !item.import_collection_id ||
      BigInt(item.gross_cents) <= 0n
    )
      continue;
    const estimate = estimateCardFee(item.gross_cents, rules, item.clip_financial_raw);
    if (!estimate) continue;
    if (estimate.deposited_cents === null)
      throw new AppError(
        "fee_exceeds_sale",
        "La tarifa de comisión supera el importe de la venta. Revisa la configuración antes de aplicarla.",
      );
    const entries = payments.get(item.id) ?? [],
      entry = entries[0];
    if (
      entries.length !== 1 ||
      !entry ||
      entry.id !== item.import_collection_id ||
      entry.kind !== "collection" ||
      entry.account_id !== "clip" ||
      entry.amount_cents !== item.gross_cents
    )
      throw new AppError(
        "cash_conflict",
        "La venta tiene movimientos adicionales o un cobro distinto. Revisa los movimientos antes de descontar la comisión.",
        409,
      );
    if (!checkedDates.has(entry.date)) {
      await ensureOpening(q, entry.date);
      checkedDates.add(entry.date);
    }
    rows.push({
      income_id: item.id,
      date: entry.date,
      processing_cents: estimate.processing_cents,
      tax_cents: estimate.processing_tax_cents,
      rule_snapshot: estimate,
      cash_id: BigInt(estimate.processing_cents) > 0n ? id() : null,
    });
  }
  if (required && !rows.length && !applied.size)
    throw new AppError(
      "card_fee_unavailable",
      "No se puede aplicar la tarifa: verifica la configuración, el cobro original y que la venta siga pendiente de liquidar.",
      409,
    );
  const charges = rows
    .filter((r) => r.cash_id)
    .map((r) => ({
      id: r.cash_id,
      income_id: r.income_id,
      date: r.date,
      amount_cents: (-BigInt(r.processing_cents)).toString(),
      notes: "Comisión de tarjeta calculada con IVA · tarifa aplicada al cobro",
    }));
  if (charges.length)
    await q.query(
      `insert into cash_movements(id,income_id,date,account_id,amount_cents,kind,notes)
    select id,income_id,date,'clip',amount_cents,'clip_fee_estimate',notes from jsonb_to_recordset($1::jsonb)
    as x(id uuid,income_id uuid,date date,amount_cents bigint,notes text)`,
      [JSON.stringify(charges)],
    );
  if (rows.length) {
    await q.query(
      `insert into income_card_fee_estimates(income_id,date,processing_cents,tax_cents,rule_snapshot,cash_id)
      select income_id,date,processing_cents,tax_cents,rule_snapshot,cash_id from jsonb_to_recordset($1::jsonb)
      as x(income_id uuid,date date,processing_cents bigint,tax_cents bigint,rule_snapshot jsonb,cash_id uuid)`,
      [JSON.stringify(rows)],
    );
    for (const row of rows)
      await audit(
        q,
        "income",
        row.income_id,
        "apply_card_fee",
        row,
        "Comisión calculada según tarifa y descontada de Clip.",
      );
  }
  const msi = await applyMsiFees(q, items, rules);
  return {
    applied_count: rows.length,
    already_applied_count: applied.size,
    msi_applied_count: msi,
  };
}

async function applyMsiFees(q: Query, items: Row[], rules: CardFeeRule[]) {
  const ids = items.map((r) => r.id);
  const existing = new Set(
    (
      await q.query(
        "select income_id from income_msi_fee_estimates where income_id=any($1::uuid[])",
        [ids],
      )
    ).rows.map((r) => r.income_id),
  );
  const bases = new Map(
    (
      await q.query("select * from income_card_fee_estimates where income_id=any($1::uuid[])", [
        ids,
      ])
    ).rows.map((r) => [r.income_id, r]),
  );
  const movements = (
    await q.query("select * from cash_movements where income_id=any($1::uuid[])", [ids])
  ).rows;
  const byIncome = new Map<string, Row[]>();
  for (const r of movements) byIncome.set(r.income_id, [...(byIncome.get(r.income_id) ?? []), r]);
  let count = 0;
  for (const item of items) {
    const base = bases.get(item.id),
      plan = cardInstallmentPlan(item.clip_financial_raw);
    if (
      existing.has(item.id) ||
      !base ||
      !plan.msi ||
      item.status !== "active" ||
      item.settled_at ||
      item.channel !== "clip" ||
      item.fees_cents !== null
    )
      continue;
    const estimate = estimateCardFee(item.gross_cents, rules, item.clip_financial_raw);
    if (!estimate) continue;
    const retained = BigInt(base.processing_cents) + BigInt(estimate.financing_cents);
    if (retained > BigInt(item.gross_cents))
      throw new AppError(
        "fee_exceeds_sale",
        "La comisión total con MSI supera el cobro. Revisa la tarifa.",
      );
    const entries = byIncome.get(item.id) ?? [],
      receipt = entries.find((r) => r.id === item.import_collection_id),
      charge = entries.find((r) => r.id === base.cash_id);
    if (
      entries.length !== (base.cash_id ? 2 : 1) ||
      receipt?.kind !== "collection" ||
      receipt.account_id !== "clip" ||
      receipt.amount_cents !== item.gross_cents ||
      (base.cash_id &&
        (charge?.kind !== "clip_fee_estimate" ||
          charge.amount_cents !== (-BigInt(base.processing_cents)).toString()))
    )
      throw new AppError(
        "cash_conflict",
        "Revisa los movimientos de la venta antes de aplicar el cargo MSI.",
        409,
      );
    await ensureOpening(q, base.date);
    const cashId = BigInt(estimate.financing_cents) > 0n ? id() : null;
    if (cashId)
      await q.query(
        "insert into cash_movements(id,date,account_id,amount_cents,kind,income_id,notes) values ($1,$2,'clip',$3,'clip_msi_fee_estimate',$4,$5)",
        [
          cashId,
          base.date,
          (-BigInt(estimate.financing_cents)).toString(),
          item.id,
          `Comisión MSI ${plan.installments} meses con IVA · tarifa aplicada al cobro`,
        ],
      );
    const snapshot = {
      installments: plan.installments,
      msi_percent: estimate.msi_percent,
      tax_percent: estimate.tax_percent,
      financing_cents: estimate.financing_cents,
      tax_cents: estimate.financing_tax_cents,
      financing_base_cents: estimate.financing_base_cents,
    };
    await q.query(
      "insert into income_msi_fee_estimates(income_id,installments,date,financing_cents,tax_cents,rule_snapshot,cash_id) values ($1,$2,$3,$4,$5,$6,$7)",
      [
        item.id,
        plan.installments,
        base.date,
        estimate.financing_cents,
        estimate.financing_tax_cents,
        JSON.stringify(snapshot),
        cashId,
      ],
    );
    await audit(
      q,
      "income",
      item.id,
      "apply_msi_fee",
      snapshot,
      "Cargo MSI calculado por plazo y descontado de Clip.",
    );
    count++;
  }
  return count;
}
