import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Database } from "../src/db/database";
import { env } from "../src/env";
import { opening, purchase, expense, income, cash, list, stock } from "../src/modules/store";
import { cancelDocument } from "../src/modules/cancellations";
import { inventoryCount } from "../src/modules/summary-inventory";
import { report } from "../src/modules/reports";
async function setup(detailed = false) {
  delete env.DATABASE_URL;
  env.AUTH_DRIVER = "local";
  const db = new Database(true);
  await db.init();
  const supplier = randomUUID(),
    product = randomUUID();
  await db.tx(async (q) => {
    await q.query("insert into suppliers(id,name) values ($1,'Proveedor')", [supplier]);
    if (detailed) {
      const cat = (await q.query("select id from categories limit 1")).rows[0]!.id;
      await q.query(
        "insert into products(id,sku,name,category_id,price_cents) values ($1,'PROD-1','Producto',$2,20000)",
        [product, cat],
      );
    }
    await opening(q, {
      date: "2025-11-01",
      cash: "0",
      bank: "10000",
      clip: "0",
      inventory_mode: detailed ? "detailed" : "summary",
      ...(detailed
        ? { lines: [{ product_id: product, quantity: "10", unit_cost: "100" }] }
        : { inventory_value: "1000", lines: [] }),
    });
  });
  return { db, supplier, product };
}
describe.sequential("Cancelar gastos y compras por totales", () => {
  let db: Database, supplier: string, expenseId: string, purchaseId: string;
  const r = () => db.tx((q) => report(q, "2025-11-01", "2025-12-01"));
  beforeAll(async () => {
    ({ db, supplier } = await setup());
  });
  afterAll(async () => db?.close());
  it("cancela un gasto pagado con motivo sin inventar reembolsos", async () => {
    const e = await db.tx((q) =>
      expense(q, {
        date: "2025-11-05",
        category: "Renta",
        concept: "Gasto por corregir",
        amount: "100",
        tax: "16",
      }),
    );
    expenseId = e.id;
    await db.tx((q) =>
      cash(q, {
        date: "2025-11-06",
        account_id: "bank",
        kind: "expense",
        expense_id: expenseId,
        amount: "40",
        notes: "Pago parcial",
      }),
    );
    expect((await r()).expenses.value).toBe("100.00");
    await expect(
      db.tx((q) => cancelDocument(q, "expense", { id: expenseId, reason: "" })),
    ).rejects.toThrow();
    expect(
      await db.tx((q) =>
        cancelDocument(q, "expense", { id: expenseId, reason: "Comprobante equivocado" }),
      ),
    ).toMatchObject({ pending_recovery_cents: "4000" });
    expect((await r()).expenses.value).toBe("0.00");
    expect((await r()).cash.value).toBe("-40.00");
    expect((await r()).warnings.join(" ")).toContain("pendientes de recuperar");
    expect(
      await db.tx((q) =>
        cancelDocument(q, "expense", { id: expenseId, reason: "Cancelar otra vez" }),
      ),
    ).toMatchObject({ already_cancelled: true });
    const events = await db.tx(
      async (q) =>
        (
          await q.query("select * from audit_events where entity_id=$1 and action='cancel'", [
            expenseId,
          ])
        ).rows,
    );
    expect(events).toHaveLength(1);
  });
  it("bloquea pagos nuevos y permite recuperar solo dinero efectivamente pagado", async () => {
    await expect(
      db.tx((q) =>
        cash(q, {
          date: "2025-11-07",
          account_id: "bank",
          kind: "expense",
          expense_id: expenseId,
          amount: "1",
          notes: "Pago inválido",
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const recover = (amount: string, date = "2025-11-07") =>
      db.tx((q) =>
        cash(q, {
          date,
          account_id: "bank",
          kind: "recovery",
          expense_id: expenseId,
          amount,
          notes: "Reembolso recibido",
        }),
      );
    await expect(recover("50")).rejects.toMatchObject({ code: "over_recovery" });
    await expect(recover("10", "2025-11-05")).rejects.toMatchObject({ code: "over_recovery" });
    await recover("10");
    let docs = await db.tx((q) => list(q, "expenses"));
    expect(docs[0]).toMatchObject({
      status: "cancelled",
      paid_cents: "4000",
      recovered_cents: "1000",
      recoverable_cents: "3000",
    });
    await recover("30");
    await expect(recover("1")).rejects.toMatchObject({ code: "over_recovery" });
    expect((await r()).cash.value).toBe("0.00");
  });
  it("cancela una compra sin duplicar el efecto en costo ni tocar efectivo automáticamente", async () => {
    const p = await db.tx((q) =>
      purchase(q, {
        date: "2025-11-05",
        supplier_id: supplier,
        reference: "COMPRA-1",
        merchandise: "500",
        freight: "100",
        tax: "80",
        nonrecoverable_tax: "20",
      }),
    );
    purchaseId = p.id;
    await db.tx((q) =>
      inventoryCount(q, {
        date: "2025-11-30",
        value: "900",
        reason: "Inventario final documentado",
      }),
    );
    expect((await r()).cogs.value).toBe("720.00");
    await db.tx((q) =>
      cash(q, {
        date: "2025-11-06",
        account_id: "bank",
        kind: "purchase",
        purchase_id: purchaseId,
        amount: "20",
        notes: "Anticipo real",
      }),
    );
    await db.tx((q) =>
      cancelDocument(q, "purchase", { id: purchaseId, reason: "Factura registrada por error" }),
    );
    expect((await r()).cogs.value).toBe("100.00");
    expect((await r()).cash.value).toBe("-20.00");
    await db.tx((q) =>
      cash(q, {
        date: "2025-11-09",
        account_id: "bank",
        kind: "recovery",
        purchase_id: purchaseId,
        amount: "20",
        notes: "Devolución de anticipo",
      }),
    );
    expect((await r()).cash.value).toBe("0.00");
    const fixed = await db.tx((q) =>
      purchase(q, {
        date: "2025-11-05",
        supplier_id: supplier,
        reference: "COMPRA-1",
        merchandise: "400",
      }),
    );
    expect(fixed.id).not.toBe(purchaseId);
    await expect(
      db.tx((q) =>
        cash(q, {
          date: "2025-11-09",
          account_id: "bank",
          kind: "recovery",
          purchase_id: fixed.id,
          amount: "1",
          notes: "Sin cancelación",
        }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
  it("protege documentos en meses cerrados y devuelve 404 para referencias inexistentes", async () => {
    const e = await db.tx((q) =>
      expense(q, {
        date: "2025-11-08",
        category: "Otros",
        concept: "No cancelar cerrado",
        amount: "10",
      }),
    );
    await db.tx((q) =>
      q.query(
        "insert into monthly_closes(id,month,status,snapshot,checklist) values ($1,'2025-12','closed','{}','[]')",
        [randomUUID()],
      ),
    );
    await expect(
      db.tx((q) => cancelDocument(q, "expense", { id: e.id, reason: "Cambio en mes cerrado" })),
    ).rejects.toMatchObject({ code: "month_closed" });
    const saved = await db.tx(
      async (q) => (await q.query("select status from expenses where id=$1", [e.id])).rows[0],
    );
    expect(saved?.status).toBe("active");
    await expect(
      db.tx((q) =>
        cancelDocument(q, "purchase", { id: randomUUID(), reason: "Documento inexistente" }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});
describe.sequential("Cancelar compras por producto conserva trazabilidad y stock", () => {
  let db: Database, supplier: string, product: string, purchaseId: string;
  beforeAll(async () => {
    ({ db, supplier, product } = await setup(true));
  });
  afterAll(async () => db?.close());
  const buy = () =>
    db.tx((q) =>
      purchase(q, {
        date: "2025-11-05",
        supplier_id: supplier,
        reference: "FACTURA-1",
        lines: [{ product_id: product, quantity: "5", unit_cost: "200" }],
      }),
    );
  it("retira el efecto de inventario de la compra y conserva sus movimientos anulados", async () => {
    const p = await buy();
    await db.tx((q) =>
      cancelDocument(q, "purchase", { id: p.id, reason: "Compra errónea documentada" }),
    );
    expect(await db.tx((q) => stock(q, product))).toMatchObject({
      quantity: "10.000000",
      value: "100000",
    });
    const original = await db.tx(
      async (q) =>
        (
          await q.query(
            "select m.voided_at from inventory_movements m join purchase_lines l on l.id=m.purchase_line_id where l.purchase_id=$1",
            [p.id],
          )
        ).rows[0],
    );
    expect(original?.voided_at).toBeTruthy();
    const p2 = await buy();
    purchaseId = p2.id;
    expect(p2.id).not.toBe(p.id);
  });
  it("revierte toda la cancelación si al quitar una compra falta stock para ventas posteriores", async () => {
    await db.tx((q) =>
      income(q, {
        from: "2025-11-06",
        to: "2025-11-07",
        channel: "cash",
        description: "Venta con unidades",
        product_id: product,
        quantity: "13",
        gross: "3000",
        net: "2600",
        cogs: null,
        fees: "0",
      }),
    );
    await expect(
      db.tx((q) =>
        cancelDocument(q, "purchase", { id: purchaseId, reason: "Cancelar compra ya utilizada" }),
      ),
    ).rejects.toMatchObject({ code: "insufficient_stock" });
    const saved = await db.tx(
      async (q) =>
        (await q.query("select status from purchases where id=$1", [purchaseId])).rows[0],
    );
    expect(saved?.status).toBe("active");
    expect((await db.tx((q) => stock(q, product))).quantity).toBe("2.000000");
  });
  it("revalúa ventas posteriores al cancelar cuando otra compra permite conservar stock suficiente", async () => {
    await db.tx((q) =>
      purchase(q, {
        date: "2025-11-04",
        supplier_id: supplier,
        reference: "COMPRA-ALTERNATIVA",
        lines: [{ product_id: product, quantity: "10", unit_cost: "500" }],
      }),
    );
    await db.tx((q) =>
      q.query(
        "insert into inventory_reconciliations(id,date,reason,snapshot) values ($1,'2025-11-07','Conteo completo validado','[]')",
        [randomUUID()],
      ),
    );
    const before = await db.tx((q) => report(q, "2025-11-01", "2025-12-01"));
    expect(before.warnings.join(" ")).not.toContain("retroactivos");
    await db.tx((q) =>
      cancelDocument(q, "purchase", {
        id: purchaseId,
        reason: "Corrección respaldada con otra compra",
      }),
    );
    expect(await db.tx((q) => stock(q, product))).toMatchObject({
      quantity: "7.000000",
      value: "210000",
    });
    const sale = await db.tx(
      async (q) =>
        (await q.query("select cogs_cents from incomes where product_id=$1", [product])).rows[0],
    );
    expect(sale?.cogs_cents).toBe("390000");
    const after = await db.tx((q) => report(q, "2025-11-01", "2025-12-01"));
    expect(after.warnings.join(" ")).toContain("retroactivos");
  });
});
