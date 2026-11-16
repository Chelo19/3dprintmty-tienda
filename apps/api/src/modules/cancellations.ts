import { z } from "zod";
import { AppError } from "@tienda/shared";
import { type Query, audit } from "../db/database";
import { ensureOpening, revalue } from "./store";
import { uuid } from "./validation";
export async function cancelDocument(q: Query, type: "purchase" | "expense", raw: unknown) {
  const b = z.object({ id: uuid, reason: z.string().trim().min(8).max(1000) }).parse(raw);
  const table = type === "purchase" ? "purchases" : "expenses";
  const before = (await q.query(`select * from ${table} where id=$1 for update`, [b.id])).rows[0];
  if (!before) throw new AppError("not_found", "No existe el documento.", 404);
  if (before.status === "cancelled") return { id: b.id, already_cancelled: true };
  await ensureOpening(q, before.date);
  await q.query(
    `update ${table} set status='cancelled',cancelled_at=now(),cancellation_reason=$1 where id=$2`,
    [b.reason, b.id],
  );
  if (type === "purchase") {
    const movements = (
      await q.query(
        "update inventory_movements m set voided_at=now() from purchase_lines l where m.purchase_line_id=l.id and l.purchase_id=$1 and m.voided_at is null returning m.id,m.product_id",
        [b.id],
      )
    ).rows;
    for (const product of new Set(movements.map((m) => m.product_id))) await revalue(q, product);
  }
  const cash = (
    await q.query(
      `select coalesce(-sum(amount_cents),0)::text as pending from cash_movements where ${type}_id=$1`,
      [b.id],
    )
  ).rows[0]!;
  await audit(
    q,
    type,
    b.id,
    "cancel",
    { before, after: { status: "cancelled" }, pending_recovery_cents: cash.pending },
    b.reason,
  );
  return { id: b.id, cancelled: true, pending_recovery_cents: cash.pending };
}
