import { effectiveNet } from "./tax-math";
import { externalCost, fiscalSummary, sourceSummary } from "./tax";
import { summaryCost, previousDay } from "./summary-inventory";
import { type Query } from "../db/database";
import { type Metric, type Report, type Row } from "@tienda/shared";
import { sum, major, margin, Decimal, cardInstallmentPlan } from "@tienda/domain";
const metric = (v: bigint | null, reason?: string): Metric => ({
  value: v === null ? null : major(v),
  status: v === null ? "no_disponible" : reason ? "parcial" : "completo",
  ...(reason ? { reason } : {}),
});
export async function report(q: Query, from: string, to: string): Promise<Report> {
  const verifiedFees = (r: Row) =>
    r.fees_cents !== null &&
    (r.channel !== "clip" ||
      r.source === "manual_summary" ||
      (!!r.settled_at && r.settlement_date < to));

  const incomes = (
    await q.query(
      "select i.*,c.name as category from incomes i left join categories c on c.id=i.category_id where i.status='active' and i.from_date >= $1 and i.to_date <= $2",
      [from, to],
    )
  ).rows;
  const profile =
    (await q.query("select fiscal_profile from settings")).rows[0]?.fiscal_profile ===
    "resico_pf_16";
  if (profile)
    for (const r of incomes) {
      r.net_cents = effectiveNet(r);
      if (r.fees_cents === null && r.source === "clip_import" && r.channel !== "clip")
        r.fees_cents = "0";
    }
  const refunds = (
    await q.query(
      "select r.*,i.category_id,c.name as category,i.product_id,i.method from income_refunds r join incomes i on i.id=r.income_id left join categories c on c.id=i.category_id where r.date >= $1 and r.date < $2",
      [from, to],
    )
  ).rows;
  for (const r of refunds)
    incomes.push({
      ...r,
      from_date: r.date,
      to_date: new Date(Date.parse(r.date) + 86400000).toISOString().slice(0, 10),
      gross_cents: (-BigInt(r.gross_cents)).toString(),
      net_cents:
        r.net_cents === null
          ? profile
            ? (-BigInt(effectiveNet(r)!)).toString()
            : null
          : (-BigInt(r.net_cents)).toString(),
      cogs_cents: r.cogs_cents === null ? null : (-BigInt(r.cogs_cents)).toString(),
      fees_cents: "0",
      quantity: r.quantity === null ? null : new Decimal(r.quantity).neg().toFixed(),
    });
  const overlapping = (
    await q.query(
      "select count(*)::int as count from incomes where status='active' and from_date < $2 and to_date > $1 and (from_date < $1 or to_date > $2)",
      [from, to],
    )
  ).rows[0]!.count;
  const expenseRows = (
    await q.query(
      "select * from expenses where date >= $1 and date < $2 and kind='operating' and status='active'",
      [from, to],
    )
  ).rows;
  for (const e of expenseRows)
    e.total_cents = (BigInt(e.amount_cents) + BigInt(e.tax_cents)).toString();
  const cashRows = (
    await q.query(
      "select m.*,a.kind as account_kind from cash_movements m join cash_accounts a on a.id=m.account_id where date >= $1 and date < $2 and m.kind not in ('opening','contribution','withdrawal') and a.kind='available'",
      [from, to],
    )
  ).rows;
  const movements = (
    await q.query(
      "select coalesce(sum(value_cents),0)::text as value from inventory_movements where date < $1 and voided_at is null",
      [to],
    )
  ).rows;
  let fiscalCostsPending = false,
    expenseVatPending = false,
    feeVatPending = false;
  if (profile) {
    const proofs = (await q.query("select * from tax_documents")).rows;
    for (const e of expenseRows)
      if (BigInt(e.tax_cents) > 0n) {
        const proof = proofs.find((p) => p.expense_id === e.id);
        if (proof?.status === "nonrecoverable")
          e.amount_cents = (BigInt(e.amount_cents) + BigInt(e.tax_cents)).toString();
        else if (proof?.status !== "creditable") {
          fiscalCostsPending = true;
          expenseVatPending = true;
        }
      }
    for (const i of incomes)
      if (BigInt(i.fee_creditable_tax_cents ?? 0) > 0n) {
        const proof = proofs.find((p) => p.income_id === i.id);
        if (proof?.status === "nonrecoverable" && i.fees_cents !== null)
          i.fees_cents = (BigInt(i.fees_cents) + BigInt(i.fee_creditable_tax_cents)).toString();
        else if (proof?.status !== "creditable") {
          fiscalCostsPending = true;
          feeVatPending = true;
        }
      }
  }
  const opening = (await q.query("select * from settings")).rows[0];
  const summary = opening?.inventory_mode === "summary";
  const external = opening?.inventory_mode === "external";
  const periodCost =
    summary && opening.opening_done ? await summaryCost(q, from, to, opening) : null;
  const counts = summary
    ? (await q.query("select * from inventory_counts where date < $1 order by date desc", [to]))
        .rows
    : [];
  const lastCount = counts[0];
  const summaryInventory =
    lastCount?.value_cents ??
    (opening?.opening_done && opening.opening_date < to ? opening.opening_inventory_cents : null) ??
    null;
  const monthlyCost = external ? await externalCost(q, from, to, opening?.opening_date) : null;
  const netKnown = incomes.every((r) => r.net_cents !== null),
    costKnown = summary
      ? periodCost?.cost != null
      : monthlyCost?.usesMonthly
        ? monthlyCost.value !== null
        : incomes.every((r) => r.cogs_cents !== null),
    feesKnown = incomes.every(verifiedFees);
  const sales = netKnown ? sum(incomes.map((r) => r.net_cents)) : null,
    cogs = summary
      ? (periodCost?.cost ?? null)
      : monthlyCost?.usesMonthly
        ? monthlyCost.value
        : costKnown
          ? sum(incomes.map((r) => r.cogs_cents))
          : null,
    fees = feesKnown ? sum(incomes.map((r) => r.fees_cents)) : null;
  const gross = sales !== null && cogs !== null ? sales - cogs : null;
  const contrib = gross !== null && fees !== null ? gross - fees : null;
  const expenses = sum(expenseRows.map((r) => r.amount_cents));
  const operating = contrib !== null ? contrib - expenses : null;
  const reconciled = (
    await q.query(
      "select * from inventory_reconciliations where date < $1 order by date desc,created_at desc limit 1",
      [to],
    )
  ).rows[0];
  const cutoff = reconciled
    ? new Date(Date.parse(reconciled.date) + 86400000).toISOString().slice(0, 10)
    : "0001-01-01";
  const missingSku = (
    await q.query(
      "select count(*)::int as count from incomes where status='active' and from_date < $1 and product_id is null and (to_date > $2 or created_at > $3)",
      [to, cutoff, reconciled?.created_at ?? "0001-01-01T00:00:00Z"],
    )
  ).rows[0]!.count;
  const invalidReconciliation = reconciled
    ? (
        await q.query(
          "select count(*)::int as count from inventory_movements where date <= $1 and coalesce(voided_at,created_at) > $2",
          [reconciled.date, reconciled.created_at],
        )
      ).rows[0]!.count
    : 0;
  const cancelledCash = (
    await q.query(
      "select count(*)::int as count from incomes i where i.status='cancelled' and i.from_date < $1 and coalesce((select sum(amount_cents) from cash_movements c where c.income_id=i.id and kind in ('collection','refund')),0)<>0",
      [to],
    )
  ).rows[0]!.count;
  const pendingRecoveries = (
    await q.query(
      `select count(*)::int as count from (
    select p.id from purchases p where p.status='cancelled' and p.date < $1 and (select coalesce(sum(amount_cents),0) from cash_movements c where c.purchase_id=p.id and c.date < $1)<0
    union all select e.id from expenses e where e.status='cancelled' and e.date < $1 and (select coalesce(sum(amount_cents),0) from cash_movements c where c.expense_id=e.id and c.date < $1)<0
  ) pending`,
      [to],
    )
  ).rows[0]!.count;
  const warnings: string[] = [];
  const pendingClip = incomes.filter(
    (r) =>
      r.channel === "clip" &&
      r.source !== "manual_summary" &&
      r.gross_cents &&
      BigInt(r.gross_cents) >= 0n &&
      (!r.settled_at || r.settlement_date >= to),
  );
  if (pendingClip.length)
    warnings.push(
      `${pendingClip.length} transacciones de Clip pendientes de conciliar con sus comisiones y depósitos al cierre del periodo.`,
    );

  if (pendingRecoveries)
    warnings.push(
      "Hay compras o gastos cancelados con pagos pendientes de recuperar; concilia los reembolsos efectivos.",
    );
  if (!opening?.opening_done) warnings.push("Falta registrar los saldos de apertura.");
  if (!netKnown)
    warnings.push("Hay cobros sin desglose de IVA; ventas netas y utilidad no disponibles.");
  if (!costKnown)
    warnings.push(
      summary
        ? (periodCost?.reason ?? "Falta la apertura del inventario por totales.")
        : (monthlyCost?.reason ??
            "Hay ingresos sin costo vendido; no se calcula rentabilidad completa."),
    );

  if (!feesKnown) warnings.push("Hay comisiones pendientes de confirmar.");
  if (overlapping)
    warnings.push(
      "Hay consolidados que cruzan el rango: se excluyeron para evitar prorrateos inventados. Selecciona su periodo completo.",
    );
  if (cancelledCash)
    warnings.push(
      "Hay cobros vinculados a transacciones canceladas: revisa su devolución o conciliación.",
    );
  if (!external && !summary && invalidReconciliation)
    warnings.push(
      "Hay movimientos retroactivos posteriores a la conciliación; vuelve a conciliar el corte.",
    );
  if (!external && !summary && missingSku)
    warnings.push("Inventario parcial: existen ingresos sin detalle de unidades por producto.");
  const monthsMap = new Map<string, Row>();
  for (const r of incomes) {
    const m = r.from_date.slice(0, 7);
    const a = monthsMap.get(m) ?? {
      month: m,
      gross: 0n,
      net: 0n,
      cogs: 0n,
      fees: 0n,
      complete: true,
      expenses: 0n,
    };
    a.gross += BigInt(r.gross_cents);
    a.net += BigInt(r.net_cents ?? 0);
    a.cogs += BigInt(r.cogs_cents ?? 0);
    a.fees += BigInt(r.fees_cents ?? 0);
    a.complete &&= r.net_cents !== null && r.cogs_cents !== null && verifiedFees(r);
    monthsMap.set(m, a);
  }
  for (const r of expenseRows) {
    const m = r.date.slice(0, 7);
    const a = monthsMap.get(m) ?? {
      month: m,
      gross: 0n,
      net: 0n,
      cogs: 0n,
      fees: 0n,
      complete: true,
      expenses: 0n,
    };
    a.expenses += BigInt(r.amount_cents);
    monthsMap.set(m, a);
  }
  const months = [...monthsMap.values()]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((r) => ({
      month: r.month,
      collected: major(r.gross),
      operating: r.complete
        ? major(BigInt(r.net) - BigInt(r.cogs) - BigInt(r.fees) - BigInt(r.expenses))
        : null,
    }));
  const categoryMap = new Map<string, Row>();
  for (const r of incomes) {
    const name = r.category ?? "Sin clasificar";
    const a = categoryMap.get(name) ?? { name, gross: 0n, net: 0n, cogs: 0n, complete: true };
    a.gross += BigInt(r.gross_cents);
    a.net += BigInt(r.net_cents ?? 0);
    a.cogs += BigInt(r.cogs_cents ?? 0);
    a.complete &&= r.net_cents !== null && r.cogs_cents !== null;
    categoryMap.set(name, a);
  }
  const categories = [...categoryMap.values()].map((r) => ({
    name: r.name,
    collected: major(r.gross),
    profit: r.complete ? major(BigInt(r.net) - BigInt(r.cogs)) : null,
    margin: r.complete ? margin(BigInt(r.net) - BigInt(r.cogs), BigInt(r.net)) : null,
  }));
  const expMap = new Map<string, bigint>();
  for (const e of expenseRows)
    expMap.set(e.category, (expMap.get(e.category) ?? 0n) + BigInt(e.amount_cents));
  const paymentsMap = new Map<string, bigint>();
  const productMap = new Map<string, Row>();
  for (const r of incomes) {
    const method = r.method ?? "Sin identificar";
    paymentsMap.set(method, (paymentsMap.get(method) ?? 0n) + BigInt(r.gross_cents));
    if (!r.product_id) continue;
    const a = productMap.get(r.product_id) ?? {
      id: r.product_id,
      quantity: new Decimal(0),
      net: 0n,
      cogs: 0n,
      complete: true,
    };
    a.quantity = a.quantity.plus(r.quantity ?? 0);
    a.net += BigInt(r.net_cents ?? 0);
    a.cogs += BigInt(r.cogs_cents ?? 0);
    a.complete &&= r.net_cents !== null && r.cogs_cents !== null;
    productMap.set(r.product_id, a);
  }
  const catalog = (await q.query("select id,name,sku from products")).rows;
  const productPerformance = [...productMap.values()]
    .map((p) => ({
      ...catalog.find((c) => c.id === p.id),
      quantity: p.quantity.toFixed(),
      sales: p.complete ? major(p.net) : null,
      profit: p.complete ? major(BigInt(p.net) - BigInt(p.cogs)) : null,
      margin: p.complete ? margin(BigInt(p.net) - BigInt(p.cogs), BigInt(p.net)) : null,
    }))
    .sort((a, b) => Number(b.quantity) - Number(a.quantity));
  const inventoryHistory = summary
    ? [
        ...new Map(
          counts
            .slice()
            .reverse()
            .map((r) => [r.date.slice(0, 7), r]),
        ).values(),
      ].map((r) => ({ month: r.date.slice(0, 7), value: major(r.value_cents) }))
    : opening?.opening_done
      ? (
          await q.query(
            "select to_char(month,'YYYY-MM') as month,coalesce((select sum(value_cents) from inventory_movements where voided_at is null and date<least(month+interval '1 month',$2::date)),0)::text as value_cents from generate_series(date_trunc('month',$1::date),date_trunc('month',$2::date-1),interval '1 month') as month order by month",
            [from, to],
          )
        ).rows.map((r) => ({ month: r.month, value: major(r.value_cents) }))
      : [];
  const slowProducts = (
    await q.query(
      "select p.id,p.sku,p.name,sum(m.quantity)::text as quantity,sum(m.value_cents)::text as value_cents,max(m.date) filter(where m.kind='sale') as last_sale,min(m.date) as first_entry from products p join inventory_movements m on m.product_id=p.id where m.date<$1 and m.voided_at is null group by p.id having sum(m.quantity)>0 and coalesce(max(m.date) filter(where m.kind='sale'),min(m.date))<$1::date-90 order by sum(m.value_cents) desc limit 10",
      [to],
    )
  ).rows;
  const partial = overlapping
    ? "Excluye consolidados que cruzan los límites del rango."
    : undefined;
  if (summary) {
    for (const m of monthsMap.values()) {
      const boundsFrom = m.month + "-01";
      const boundsTo = new Date(
        Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 1),
      )
        .toISOString()
        .slice(0, 10);
      const start = from > boundsFrom ? from : boundsFrom,
        end = to < boundsTo ? to : boundsTo;
      const cost = await summaryCost(q, start, end, opening);
      const relevant = incomes.filter((r) => r.from_date.slice(0, 7) === m.month);
      const complete =
        cost.cost !== null && relevant.every((r) => r.net_cents !== null && verifiedFees(r));
      const month = months.find((r) => r.month === m.month);
      if (month) {
        month.operating = complete
          ? major(BigInt(m.net) - cost.cost! - BigInt(m.fees) - BigInt(m.expenses))
          : null;
      }
    }
  }
  if (external)
    for (const m of monthsMap.values()) {
      const bounds = new Date(Date.UTC(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)), 1))
        .toISOString()
        .slice(0, 10);
      const start = from > m.month + "-01" ? from : m.month + "-01",
        end = to < bounds ? to : bounds;
      const cost = await externalCost(q, start, end, opening?.opening_date);
      const relevant = incomes.filter((r) => r.from_date.slice(0, 7) === m.month);
      if (cost.usesMonthly) {
        const found = months.find((r) => r.month === m.month);
        if (found)
          found.operating =
            cost.value !== null && relevant.every((r) => r.net_cents !== null && verifiedFees(r))
              ? major(BigInt(m.net) - cost.value - BigInt(m.fees) - BigInt(m.expenses))
              : null;
      }
    }
  const fiscal = await fiscalSummary(q, from, to);
  if (fiscalCostsPending)
    warnings.push(
      "La recuperabilidad del IVA de gastos o comisiones está pendiente; la utilidad es provisional.",
    );
  if (fiscal)
    for (const month of fiscal.monthly) {
      if (month.pending_reason) warnings.push(`${month.month}: ${month.pending_reason}`);
      if (month.pending_documents)
        warnings.push(`${month.month}: hay IVA pagado pendiente de comprobación fiscal.`);
    }

  const afterIsr =
    operating !== null && fiscal?.isr_estimate.value != null
      ? metric(
          operating - BigInt(new Decimal(fiscal.isr_estimate.value).times(100).toFixed(0)),
          fiscalCostsPending
            ? "Recuperabilidad del IVA pendiente: resultado provisional."
            : undefined,
        )
      : metric(
          null,
          fiscal?.monthly
            .map((m) => m.pending_reason)
            .filter(Boolean)
            .join(" ") || "Completa el costo mensual y las comisiones de la tienda.",
        );
  const financialWarnings: string[] = [];
  if (!opening?.opening_done) financialWarnings.push("Falta registrar los saldos de apertura.");
  if (pendingClip.length)
    financialWarnings.push(
      `${pendingClip.length} ${pendingClip.length === 1 ? "cobro con tarjeta pendiente" : "cobros con tarjeta pendientes"} de conciliar con el depósito y las comisiones de Clip.`,
    );
  if (pendingRecoveries)
    financialWarnings.push("Hay pagos de compras o gastos cancelados pendientes de recuperar.");
  if (pendingClip.length) {
    const termRules = (
      await q.query(
        "select installments from fee_rules where method='MSI' and installments is not null",
      )
    ).rows;
    const appliedMsi = new Set(
      (await q.query("select income_id from income_msi_fee_estimates")).rows.map(
        (r) => r.income_id,
      ),
    );
    const missing = [
      ...new Set(
        pendingClip
          .filter((r) => !appliedMsi.has(r.id))
          .map((r) => cardInstallmentPlan(r.clip_financial_raw))
          .filter((p) => p.msi && !termRules.some((r) => r.installments === p.installments))
          .map((p) => p.installments ?? "desconocido"),
      ),
    ];
    if (missing.length)
      financialWarnings.push(
        `Falta configurar tarifa MSI para estos plazos: ${missing.join(", ")} meses. Revisa las reglas de comisión.`,
      );
  }
  if (overlapping)
    financialWarnings.push(
      "Se excluyeron consolidados que cruzan el rango. Consulta su periodo completo.",
    );
  if (cancelledCash)
    financialWarnings.push("Hay cobros de ventas canceladas: revisa su devolución o conciliación.");
  const cashByKind = new Map<string, bigint>(),
    cashByMonth = new Map<string, bigint>();
  for (const row of cashRows) {
    const value = BigInt(row.amount_cents),
      month = row.date.slice(0, 7);
    cashByKind.set(row.kind, (cashByKind.get(row.kind) ?? 0n) + value);
    cashByMonth.set(month, (cashByMonth.get(month) ?? 0n) + value);
  }
  const cashLabels: Record<string, string> = {
    collection: "Cobros en Efectivo y Banco",
    transfer: "Transferencias netas, incluidas liquidaciones de Clip",
    purchase: "Pagos de compras",
    expense: "Pagos de gastos y activos",
    refund: "Devoluciones pagadas",
    recovery: "Recuperaciones de pagos",
    clip_fee: "Cargos de Clip descontados de cuentas disponibles",
  };
  return {
    financial: {
      warnings: financialWarnings,
      movements: [...cashByKind]
        .filter(([, amount]) => amount !== 0n)
        .map(([kind, amount]) => ({ name: cashLabels[kind] ?? kind, amount: major(amount) })),
      months: [...cashByMonth]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, amount]) => ({ month, cash: major(amount) })),
    },
    fiscal,
    sourceSummary: await sourceSummary(q, from, to),
    afterIsr,
    costBasis: monthlyCost?.usesMonthly ? "monthly" : "per_income",
    inventoryMode: external ? "external" : summary ? "summary" : "detailed",
    from,
    to,
    sales: metric(sales, partial),
    collected: metric(sum(incomes.map((r) => r.gross_cents)), partial),
    cogs: metric(cogs, partial),
    gross: metric(gross, partial),
    fees: metric(
      fees,
      partial ?? (feeVatPending ? "IVA de comisiones pendiente de comprobación." : undefined),
    ),
    contribution: metric(contrib, partial),
    expenses: metric(
      expenses,
      expenseVatPending ? "Recuperabilidad del IVA pendiente de confirmar." : undefined,
    ),
    operating: metric(
      operating,
      partial ??
        (fiscalCostsPending
          ? "IVA de gastos/comisiones pendiente de comprobar; resultado provisional."
          : undefined),
    ),
    cash: metric(sum(cashRows.map((r) => r.amount_cents))),
    inventory: external
      ? metric(null, "Inventario administrado fuera del sistema.")
      : summary
        ? metric(
            summaryInventory === null ? null : BigInt(summaryInventory),
            !opening?.opening_done || lastCount?.date !== previousDay(to)
              ? "Último inventario confirmado; falta el corte final del periodo consultado."
              : undefined,
          )
        : metric(
            BigInt(movements[0]!.value),
            missingSku || invalidReconciliation || !opening?.opening_done
              ? "Requiere conciliación contra Clip."
              : undefined,
          ),
    grossMargin: margin(gross, sales),
    operatingMargin: margin(operating, sales),
    warnings,
    months,
    categories: summary
      ? categories.map((r) => ({ ...r, profit: null, margin: null }))
      : categories,
    payments: [...paymentsMap].map(([name, v]) => ({ name, amount: major(v) })),
    productPerformance: summary || external ? [] : productPerformance,
    inventoryHistory: external ? [] : inventoryHistory,
    slowProducts: summary || external ? [] : slowProducts,
    expenseCategories: [...expMap].map(([name, v]) => ({ name, amount: major(v) })),
    recentPurchases: (
      await q.query(
        "select p.*,s.name as supplier from purchases p left join suppliers s on s.id=p.supplier_id where p.date >= $1 and p.date < $2 and p.status='active' order by p.date desc limit 5",
        [from, to],
      )
    ).rows,
    recentExpenses: expenseRows
      .slice()
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 5),
    count: incomes.length,
    knownCosts: incomes.filter((r) => r.cogs_cents !== null).length,
  };
}
export function reportRows(r: Report, financial = false) {
  if (financial)
    return [
      {
        Concepto: "Cobros registrados, incluidos cobros en Clip",
        "Importe MXN": r.collected.value,
      },
      ...(r.financial?.movements ?? []).map((m) => ({ Concepto: m.name, "Importe MXN": m.amount })),
      { Concepto: "Flujo de caja disponible", "Importe MXN": r.cash.value },
      ...(r.fiscal
        ? [
            ["IVA cobrado · tienda", r.fiscal.vat_collected],
            ["IVA acreditable pagado y comprobado · tienda", r.fiscal.vat_creditable],
            ["IVA estimado por pagar · tienda", r.fiscal.vat_due],
            ["IVA a favor estimado · tienda", r.fiscal.vat_favor],
            ["ISR estimado antes de retenciones · tienda", r.fiscal.isr_estimate],
            ["ISR estimado por pagar · tienda", r.fiscal.isr_due],
          ].map(([name, m]) => ({ Concepto: name as string, "Importe MXN": (m as Metric).value }))
        : []),
    ].map((row) => ({
      ...row,
      Inicio: r.from,
      "Fin exclusivo": r.to,
      Alcance:
        "Flujo en Efectivo y Banco; excluye apertura, aportaciones y retiros. Los cobros registrados incluyen Clip y no se suman de nuevo al flujo.",
    }));
  return (
    [
      ["Ventas netas", r.sales],
      ["Costo de mercancía vendida", r.cogs],
      ["Utilidad bruta", r.gross],
      ["Comisiones", r.fees],
      ["Margen de contribución", r.contribution],
      ["Gastos operativos", r.expenses],
      ["Resultado operativo", r.operating],
      ["Flujo neto de efectivo disponible", r.cash],
      ...(r.fiscal
        ? ([
            ["IVA cobrado tienda", r.fiscal.vat_collected],
            ["IVA acreditable pagado tienda", r.fiscal.vat_creditable],
            ["IVA estimado por pagar tienda", r.fiscal.vat_due],
            ["IVA a favor estimado tienda", r.fiscal.vat_favor],
            ["ISR estimado tienda", r.fiscal.isr_estimate],
            ["ISR estimado por pagar tienda", r.fiscal.isr_due],
            ["Resultado después de ISR estimado de tienda", r.afterIsr!],
          ] as const)
        : []),
      ...(r.inventoryMode === "external" ? [] : [["Inventario final", r.inventory] as const]),
    ] as const
  ).map(([name, m]) => ({
    Periodo: r.from.slice(0, 7),
    Concepto: name,
    "Importe MXN": m.value,
    Estado: m.status,
    Observaciones: m.reason ?? "",
    Inicio: r.from,
    "Fin exclusivo": r.to,
  }));
}
export function csv(rows: Row[]): string {
  const keys = Object.keys(rows[0] ?? {});
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (typeof v === "string" && !/^-?\d+(\.\d+)?$/.test(s) && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
  };
  return (
    "\uFEFF" +
    [keys.map(cell).join(","), ...rows.map((r) => keys.map((k) => cell(r[k])).join(","))].join(
      "\r\n",
    )
  );
}
