import { afterAll, beforeAll, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
let app: any, db: any, token: string;
const post = (name: string, body: any) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + name)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", randomUUID())
    .send(body);
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  ({ app, db } = await createApp(true));
  token = (await request(app.getHttpServer()).post("/api/v1/auth/local")).body.token;
  await post("opening", {
    date: "2025-11-01",
    cash: "0",
    bank: "10000",
    clip: "0",
    inventory_mode: "external",
    lines: [],
  });
});
afterAll(async () => app?.close());
it("registra el total como gasto, sin IVA acreditable, y conserva el modo en la recurrencia", async () => {
  const created = await post("expense", {
    date: "2025-11-10",
    category: "Otros",
    concept: "Comprobante sin desglose",
    amount: "1160",
    tax_mode: "total_no_credit",
    recurring: true,
  });
  expect(created.status).toBe(201);
  const expense = await db.tx(
    async (q: any) =>
      (await q.query("select * from expenses where id=$1", [created.body.id])).rows[0],
  );
  expect(expense).toMatchObject({
    amount_cents: "116000",
    tax_cents: "0",
    tax_mode: "total_no_credit",
  });
  const r = await request(app.getHttpServer())
    .get("/api/v1/report?from=2025-11-01&to=2025-12-01")
    .set("Authorization", "Bearer " + token);
  expect(r.body.expenses.value).toBe("1160.00");
  const generated = await post("recurring", {
    date: "2025-12-10",
    template_id: expense.template_id,
  });
  expect(generated.status).toBe(201);
  const next = await db.tx(
    async (q: any) =>
      (await q.query("select * from expenses where id=$1", [generated.body.id])).rows[0],
  );
  expect(next).toMatchObject({
    amount_cents: "116000",
    tax_cents: "0",
    tax_mode: "total_no_credit",
  });
});
it("rechaza IVA acreditable en el modo de total y mantiene el desglose anterior", async () => {
  const input = {
    date: "2025-11-10",
    category: "Otros",
    concept: "Desglosado",
    amount: "1000",
    tax: "160",
  };
  expect((await post("expense", { ...input, tax_mode: "total_no_credit" })).status).toBe(400);
  const created = await post("expense", input);
  expect(created.status).toBe(201);
  const expense = await db.tx(
    async (q: any) =>
      (await q.query("select * from expenses where id=$1", [created.body.id])).rows[0],
  );
  expect(expense).toMatchObject({
    amount_cents: "100000",
    tax_cents: "16000",
    tax_mode: "itemized",
  });
  await expect(
    db.tx((q: any) =>
      q.query("update expenses set tax_mode='total_no_credit' where id=$1", [created.body.id]),
    ),
  ).rejects.toMatchObject({ code: "23514" });
});
