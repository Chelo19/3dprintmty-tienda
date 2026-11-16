import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
let app: any, db: any, token: string, supplier: string;
const post = (name: string, body: any, key = randomUUID()) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + name)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", key)
    .send(body);
const get = (path: string) =>
  request(app.getHttpServer())
    .get("/api/v1" + path)
    .set("Authorization", "Bearer " + token);
const linkedPayments = (id: string, kind: "expense" | "purchase") =>
  db.tx(
    async (q: any) =>
      (await q.query(`select * from cash_movements where ${kind}_id=$1`, [id])).rows,
  );
const counts = () =>
  db.tx(
    async (q: any) =>
      (
        await q.query(
          "select (select count(*)::int from expenses) as expenses,(select count(*)::int from purchases) as purchases,(select count(*)::int from expense_templates) as templates,(select count(*)::int from cash_movements) as cash,(select count(*)::int from audit_events) as audits",
        )
      ).rows[0],
  );
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  ({ app, db } = await createApp(true));
  token = (await request(app.getHttpServer()).post("/api/v1/auth/local")).body.token;
  await post("opening", {
    date: "2025-11-01",
    cash: "5000",
    bank: "5000",
    clip: "0",
    inventory_mode: "external",
    lines: [],
  });
  supplier = (await post("supplier", { name: "Proveedor" })).body.id;
});
afterAll(async () => app?.close());
describe.sequential("Registro y pago atómicos de compras y gastos", () => {
  it("paga una compra con flete e impuestos por el total exacto y no duplica el reintento", async () => {
    const body = {
      date: "2025-11-10",
      supplier_id: supplier,
      merchandise: "1000",
      freight: "100",
      nonrecoverable_tax: "24",
      tax: "176",
      initial_payment: { account_id: "bank", date: "2025-11-11" },
    };
    const key = randomUUID(),
      a = await post("purchase", body, key),
      again = await post("purchase", body, key);
    expect(a.status).toBe(201);
    expect(again.body.id).toBe(a.body.id);
    expect(a.body.total_cents).toBe("130000");
    const paid = await linkedPayments(a.body.id, "purchase");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      account_id: "bank",
      amount_cents: "-130000",
      date: "2025-11-11",
      kind: "purchase",
    });
    expect((await get("/purchases")).body.find((p: any) => p.id === a.body.id).paid_cents).toBe(
      "130000",
    );
    expect(
      (
        await post("cash", {
          date: "2025-11-11",
          account_id: "bank",
          kind: "purchase",
          purchase_id: a.body.id,
          amount: "1",
          notes: "Evitar doble pago",
        })
      ).status,
    ).toBe(400);
  });
  it("paga un gasto con IVA en efectivo y usa su fecha cuando no se captura otra", async () => {
    const e = await post("expense", {
      date: "2025-11-12",
      category: "Otros",
      concept: "Gasto pagado",
      amount: "100",
      tax: "16",
      initial_payment: { account_id: "cash" },
    });
    expect(e.status).toBe(201);
    const paid = await linkedPayments(e.body.id, "expense");
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({
      account_id: "cash",
      amount_cents: "-11600",
      date: "2025-11-12",
      kind: "expense",
    });
    expect((await get("/expenses")).body.find((p: any) => p.id === e.body.id).paid_cents).toBe(
      "11600",
    );
    const r = (await get("/report?from=2025-11-01&to=2025-12-01")).body;
    expect(r.expenses.value).toBe("100.00");
    expect(r.cash.value).toBe("-1416.00");
  });
  it("registra un total sin IVA acreditable, pero la plantilla recurrente no paga meses futuros", async () => {
    const e = await post("expense", {
      date: "2025-11-12",
      category: "Otros",
      concept: "Mensual pagado",
      amount: "116",
      tax_mode: "total_no_credit",
      recurring: true,
      initial_payment: { account_id: "bank" },
    });
    expect(e.status).toBe(201);
    expect((await linkedPayments(e.body.id, "expense"))[0].amount_cents).toBe("-11600");
    const stored = (await get("/expenses")).body.find((r: any) => r.id === e.body.id);
    const next = await post("recurring", { date: "2025-12-12", template_id: stored.template_id });
    expect(next.status).toBe(201);
    expect(await linkedPayments(next.body.id, "expense")).toEqual([]);
  });
  it("sin la opción no registra pagos y permite pagarlos después", async () => {
    const e = await post("expense", {
      date: "2025-11-12",
      category: "Otros",
      concept: "Pendiente",
      amount: "50",
    });
    expect(e.status).toBe(201);
    expect(await linkedPayments(e.body.id, "expense")).toEqual([]);
    expect(
      (
        await post("cash", {
          date: "2025-11-13",
          account_id: "cash",
          kind: "expense",
          expense_id: e.body.id,
          amount: "20",
          notes: "Pago parcial",
        })
      ).status,
    ).toBe(201);
    expect((await get("/expenses")).body.find((p: any) => p.id === e.body.id).paid_cents).toBe(
      "2000",
    );
  });
  it("si falla el pago revierte documento, plantilla, movimientos y auditoría", async () => {
    const before = await counts();
    const invalidDate = { account_id: "bank", date: "2025-11-09" };
    expect(
      (
        await post("expense", {
          date: "2025-11-10",
          category: "Otros",
          concept: "No guardar",
          amount: "100",
          recurring: true,
          initial_payment: invalidDate,
        })
      ).status,
    ).toBe(400);
    expect(await counts()).toEqual(before);
    expect(
      (
        await post("purchase", {
          date: "2025-11-10",
          supplier_id: supplier,
          merchandise: "100",
          initial_payment: invalidDate,
        })
      ).status,
    ).toBe(400);
    expect(await counts()).toEqual(before);
    expect(
      (
        await post("expense", {
          date: "2025-11-10",
          category: "Otros",
          concept: "Sin cuenta",
          amount: "100",
          initial_payment: {},
        })
      ).status,
    ).toBe(400);
    expect(await counts()).toEqual(before);
  });
});
