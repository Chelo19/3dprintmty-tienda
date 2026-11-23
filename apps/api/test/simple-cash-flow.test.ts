import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
let app: any, db: any, token: string, ids: string[];
const post = (action: string, body: any) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + action)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", randomUUID())
    .send(body);
const get = (path: string) =>
  request(app.getHttpServer())
    .get("/api/v1" + path)
    .set("Authorization", "Bearer " + token);
const report = () => get("/report?from=2025-11-01&to=2025-12-01");
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  ({ app, db } = await createApp(true));
  token = (await request(app.getHttpServer()).post("/api/v1/auth/local")).body.token;
  expect(
    (
      await post("opening", {
        date: "2025-11-01",
        cash: "0",
        bank: "0",
        clip: "0",
        inventory_mode: "external",
        lines: [],
      })
    ).status,
  ).toBe(201);
  expect((await post("tax-profile", {})).status).toBe(201);
  expect(
    (
      await post("fee-rule", {
        method: "Tarjeta",
        percent: "2.99",
        fixed: "1",
        tax_percent: "16",
        msi_percent: "0",
      })
    ).status,
  ).toBe(201);
  const rows = ["credit_card", "debit_card"].map((method, i) => ({
    Date: "2025-11-10 12:00",
    "Transaction ID": "simple-tx-" + i,
    "Payment ID": "simple-pay-" + i,
    "Receipt No": "simple-" + i,
    "Payment Status": "approved",
    "Payment Currency": "MXN",
    "Paid Amount": "100",
    "Payment Method Type": method,
  }));
  const b = await request(app.getHttpServer())
    .post("/api/v1/imports/preview")
    .set("Authorization", "Bearer " + token)
    .send({ filename: "clip.csv", file_hash: "a".repeat(64), rows, mapping: {} });
  expect(b.status).toBe(201);
  expect((await post("confirm-import", { id: b.body.id })).status).toBe(201);
  ids = (await get("/incomes")).body.map((r: any) => r.id);
});
afterAll(async () => app?.close());
describe.sequential("Operación financiera sin conciliación por venta", () => {
  it("usa las comisiones aplicadas y muestra su IVA pendiente sin exigir confirmar depósitos", async () => {
    const r = (await report()).body;
    expect(r.fees).toMatchObject({ value: "7.98", status: "parcial" });
    expect(r.fees.reason).toContain("calculadas según tarifa");
    expect(r.financial.warnings).toEqual([]);
    expect(r.cogs.value).toBeNull();
    expect(r.fiscal.vat_creditable.value).toBe("0.00");
    expect(r.fiscal.monthly[0].pending_documents).toBe(2);
    const docs = (await get("/tax/documents")).body.filter((r: any) => r.type === "fee");
    expect(docs).toHaveLength(2);
    expect(
      docs.every(
        (r: any) =>
          r.fee_calculated && r.total_cents === "463" && r.vat_cents === "64" && r.proof === null,
      ),
    ).toBe(true);
  });
  it("permite varios SPEI para un conjunto de ventas sin volver a cobrar comisiones ni cambiar las ventas", async () => {
    const before = await db.tx(
      async (q: any) => (await q.query("select * from incomes order by id")).rows,
    );
    for (const amount of ["80", "110.74"])
      expect(
        (
          await post("cash", {
            date: "2025-11-11",
            account_id: "clip",
            destination: "bank",
            kind: "transfer",
            amount,
            notes: "SPEI de saldo Clip a Banco " + amount,
          })
        ).status,
      ).toBe(201);
    const accounts = (await get("/accounts")).body;
    expect(accounts.find((r: any) => r.id === "clip").balance_cents).toBe("0");
    expect(accounts.find((r: any) => r.id === "bank").balance_cents).toBe("19074");
    expect(
      await db.tx(async (q: any) => (await q.query("select * from incomes order by id")).rows),
    ).toEqual(before);
    const r = (await report()).body;
    expect(r.collected.value).toBe("200.00");
    expect(r.fees.value).toBe("7.98");
    expect(r.financial.warnings).toEqual([]);
  });
  it("no acredita el IVA calculado sin CFDI y evita asignar dos veces el IVA de la misma factura", async () => {
    const invoice = randomUUID();
    const body = {
      type: "fee",
      status: "creditable",
      invoice_uuid: invoice,
      invoice_vat: "0.64",
      eligible_on: "2025-11-11",
      notes: "Comprobante fiscal y cargos revisados",
    };
    expect((await post("tax-document", { ...body, id: ids[0] })).status).toBe(201);
    const duplicate = await post("tax-document", { ...body, id: ids[1] });
    expect(duplicate.status).toBe(400);
    expect(duplicate.body.code).toBe("invoice_overallocated");
    expect((await report()).body.fiscal.vat_creditable.value).toBe("0.64");
  });
  it("permite cerrar con tres revisiones, sin costo vendido ni conciliaciones individuales, y protege el periodo", async () => {
    const r = (await report()).body;
    expect(r.warnings.some((w: string) => /costo vendido/.test(w))).toBe(true);
    expect((await post("close", { month: "2025-11", checklist: [true, true, false] })).status).toBe(
      400,
    );
    expect((await post("close", { month: "2025-11", checklist: [true, true, true] })).status).toBe(
      201,
    );
    const close = (await get("/closes")).body[0];
    expect(close.snapshot.inventoryMode).toBe("external");
    expect(close.snapshot.financial.warnings).toEqual([]);
    expect(close.snapshot.cogs.value).toBeNull();
    expect(
      (
        await post("cash", {
          date: "2025-11-12",
          account_id: "bank",
          kind: "withdrawal",
          amount: "1",
          notes: "No alterar un cierre",
        })
      ).status,
    ).toBe(409);
  });
});
