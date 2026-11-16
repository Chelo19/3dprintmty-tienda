import { z } from "zod";
import { AppError } from "@tienda/shared";
import { cents } from "@tienda/domain";
import { audit, type Query } from "../db/database";
import { ensureOpening, id } from "./store";
import { date, money, uuid } from "./validation";

/** Reconcile a single transaction to documented deductions and its actual bank receipt. */
export async function settleClip(q: Query, raw: unknown) {
  const b = z
    .object({
      id: uuid,
      date,
      processing_fee: money,
      financing_withheld: money,
      creditable_tax: money,
      deposited: money,
      reference: z.string().trim().min(5).max(1000),
    })
    .parse(raw);
  const item = (await q.query("select * from incomes where id=$1 for update", [b.id])).rows[0];
  if (
    !item ||
    item.status !== "active" ||
    item.channel !== "clip" ||
    item.source === "manual_summary"
  )
    throw new AppError(
      "not_found",
      "Selecciona una transacción activa de Clip importada del reporte.",
      404,
    );
  const processing = cents(b.processing_fee),
    financing = cents(b.financing_withheld),
    tax = cents(b.creditable_tax),
    deposited = cents(b.deposited);
  if (item.settled_at) {
    if (
      item.settlement_date === b.date &&
      item.processing_fee_cents === processing.toString() &&
      item.financing_withheld_cents === financing.toString() &&
      item.fee_creditable_tax_cents === tax.toString() &&
      item.deposited_cents === deposited.toString() &&
      item.settlement_reference === b.reference
    )
      return { id: item.id, already_settled: true };
    throw new AppError(
      "already_settled",
      "Esta transacción ya está conciliada. No se registró otro depósito.",
      409,
    );
  }
  await ensureOpening(q, item.from_date);
  await ensureOpening(q, b.date);
  if (b.date < item.from_date)
    throw new AppError("invalid_date", "El depósito no puede ser anterior al cobro.");
  if (processing + financing + deposited !== BigInt(item.gross_cents))
    throw new AppError(
      "settlement_difference",
      "No cuadra al centavo: cobro = depósito + comisión de procesamiento + financiamiento retenido. No se guardó la conciliación.",
    );
  if (tax > processing + financing)
    throw new AppError("invalid_tax", "El IVA acreditable excede los cargos retenidos.");
  if ((await q.query("select id from income_refunds where income_id=$1", [item.id])).rows.length)
    throw new AppError(
      "refund_conflict",
      "La transacción tiene devoluciones; concilia el estado de cuenta con sus fechas antes de registrar el depósito.",
      409,
    );
  const cash = (await q.query("select * from cash_movements where income_id=$1", [item.id])).rows;
  let cashId: string | null = null;
  const entry = cash[0];
  const heldInClip =
    cash.length === 1 &&
    entry?.kind === "collection" &&
    entry.account_id === "clip" &&
    entry.amount_cents === item.gross_cents;
  if (heldInClip) {
    if (b.date < entry!.date)
      throw new AppError(
        "invalid_date",
        "El depósito no puede ser anterior al cobro registrado en Clip.",
      );
    const transferId = id();
    if (deposited > 0n) {
      cashId = id();
      await q.query(
        `insert into cash_movements(id,date,account_id,amount_cents,kind,income_id,transfer_id,notes)
        values ($1,$2,'clip',$3,'transfer',$4,$5,$6),($7,$2,'bank',$8,'transfer',$4,$5,$6)`,
        [
          id(),
          b.date,
          (-deposited).toString(),
          item.id,
          transferId,
          "Liquidación Clip · " + b.reference,
          cashId,
          deposited.toString(),
        ],
      );
    }
    const retained = processing + financing;
    if (retained > 0n)
      await q.query(
        "insert into cash_movements(id,date,account_id,amount_cents,kind,income_id,notes) values ($1,$2,'clip',$3,'clip_fee',$4,$5)",
        [id(), b.date, (-retained).toString(), item.id, "Cargos retenidos Clip · " + b.reference],
      );
  } else if (cash.length) {
    if (
      cash.length !== 1 ||
      !entry ||
      entry.kind !== "collection" ||
      entry.account_id !== "bank" ||
      entry.date !== b.date ||
      entry.amount_cents !== deposited.toString()
    )
      throw new AppError(
        "cash_conflict",
        "Ya hay movimientos de efectivo para este cobro que no coinciden con el depósito. No se duplicó dinero; revisa esos movimientos antes de conciliar.",
        409,
      );
    cashId = entry.id;
  } else if (deposited > 0n) {
    // Historical imports without a collection retain their existing reconciliation flow.
    cashId = id();
    await q.query(
      "insert into cash_movements(id,date,account_id,amount_cents,kind,income_id,notes) values ($1,$2,'bank',$3,'collection',$4,$5)",
      [cashId, b.date, deposited.toString(), item.id, "Depósito conciliado Clip · " + b.reference],
    );
  }
  const feeExpense = processing + financing - tax;
  if (item.fees_cents !== null && item.fees_cents !== feeExpense.toString())
    throw new AppError(
      "fee_conflict",
      "La comisión complementada antes no coincide con la conciliación. Revisa el complemento antes de continuar.",
      409,
    );
  await q.query(
    `update incomes set processing_fee_cents=$1,financing_withheld_cents=$2,
    fee_creditable_tax_cents=$3,deposited_cents=$4,settlement_date=$5,settlement_reference=$6,
    settlement_cash_id=$7,settled_at=now(),fees_cents=$8 where id=$9`,
    [
      processing.toString(),
      financing.toString(),
      tax.toString(),
      deposited.toString(),
      b.date,
      b.reference,
      cashId,
      feeExpense.toString(),
      item.id,
    ],
  );
  await audit(
    q,
    "income",
    item.id,
    "settle_clip",
    { before: item, after: b, cash_id: cashId, fees_cents: feeExpense.toString() },
    b.reference,
  );
  return { id: item.id, settled: true, cash_id: cashId };
}
