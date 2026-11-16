import { AppError } from "@tienda/shared";
import type { Query } from "../db/database";
import { audit } from "../db/database";
import { cents } from "@tienda/domain";
import { z } from "zod";
import { date, money } from "./validation";
import { id, ensureOpening } from "./store";
export const previousDay = (day: string) =>
  new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
export async function summaryCost(q: Query, from: string, to: string, settings: any) {
  const counts = (
    await q.query("select * from inventory_counts where date=any($1::date[])", [
      [previousDay(from), previousDay(to)],
    ])
  ).rows;
  const start =
    from <= settings.opening_date && settings.opening_date < to
      ? settings.opening_inventory_cents
      : counts.find((r) => r.date === previousDay(from))?.value_cents;
  const end = counts.find((r) => r.date === previousDay(to))?.value_cents;
  const purchased = (
    await q.query(
      "select coalesce(sum(summary_cost_cents),0)::text as cost,count(*) filter(where summary_cost_cents is null)::int as detailed from purchases where date >= $1 and date < $2 and status='active'",
      [from, to],
    )
  ).rows[0]!;
  const cost =
    start != null && end != null && !purchased.detailed
      ? BigInt(start) + BigInt(purchased.cost) - BigInt(end)
      : null;
  return {
    cost: cost !== null && cost >= 0n ? cost : null,
    start,
    end,
    purchases: purchased.cost,
    reason:
      cost !== null && cost < 0n
        ? "El inventario final excede al inicial más las compras; revisa los cortes y adquisiciones."
        : "Falta inventario inicial o corte final del periodo. Registra sus valores a costo de adquisición, sin IVA recuperable.",
  };
}
export async function inventoryCount(q: Query, raw: unknown) {
  const b = z.object({ date, value: money, reason: z.string().trim().min(8).max(1000) }).parse(raw);
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Monterrey",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  if (b.date > today)
    throw new AppError(
      "future_inventory",
      "El corte debe corresponder a existencias observadas, no a una fecha futura.",
    );
  await ensureOpening(q, b.date);
  const settings = (await q.query("select * from settings")).rows[0]!;
  if (settings.inventory_mode !== "summary")
    throw new AppError("inventory_mode", "Usa la conciliación por producto en el modo detallado.");
  const before = (await q.query("select * from inventory_counts where date=$1", [b.date])).rows[0];
  // A changed historical count affects all subsequent monthly results, guarded by ensureOpening.
  const cid = before?.id ?? id();
  await q.query(
    "insert into inventory_counts(id,date,value_cents,reason) values ($1,$2,$3,$4) on conflict(date) do update set value_cents=excluded.value_cents,reason=excluded.reason,created_at=now()",
    [cid, b.date, cents(b.value).toString(), b.reason],
  );
  await audit(
    q,
    "inventory_count",
    cid,
    before ? "correct" : "create",
    { before, after: b },
    b.reason,
  );
  return { id: cid };
}

export async function openingInventoryValue(q: Query, raw: unknown) {
  const b = z.object({ value: money, reason: z.string().trim().min(8).max(1000) }).parse(raw);
  const settings = (await q.query("select * from settings")).rows[0]!;
  if (settings.inventory_mode !== "summary" || !settings.opening_done)
    throw new AppError("inventory_mode", "Registra primero la apertura por totales.");
  await ensureOpening(q, settings.opening_date);
  await q.query("update settings set opening_inventory_cents=$1 where id=1", [
    cents(b.value).toString(),
  ]);
  await audit(
    q,
    "opening",
    "1",
    "inventory-value",
    { before: settings.opening_inventory_cents, after: cents(b.value).toString() },
    b.reason,
  );
  return { ok: true };
}
