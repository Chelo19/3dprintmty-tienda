import { beforeAll, afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
let app: any, db: any, token: string;
const row = (id: string, method = "cash", extra: any = {}) => ({
  Date: "2025-11-10 14:36",
  "Transaction ID": "tx-" + id,
  "Payment ID": "pay-" + id,
  "Receipt No": id,
  "Payment Status": "approved",
  "Payment Currency": "MXN",
  "Paid Amount": "116.00",
  "Payment Method Type": method,
  ...extra,
});
const post = (name: string, body: any, key = randomUUID()) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + name)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", key)
    .send(body);
const preview = async (rows: any[], extra: any = {}) => {
  const r = await request(app.getHttpServer())
    .post("/api/v1/imports/preview")
    .set("Authorization", "Bearer " + token)
    .send({
      filename: "clip.csv",
      file_hash: randomUUID().replaceAll("-", "").repeat(2),
      rows,
      mapping: {},
      ...extra,
    });
  expect(r.status).toBe(201);
  return r.body;
};
const snapshot = () =>
  db.tx(async (q: any) => ({
    incomes: (await q.query("select * from incomes order by id")).rows,
    cash: (await q.query("select * from cash_movements order by id")).rows,
  }));
const balances = () =>
  db.tx(
    async (q: any) =>
      (
        await q.query(
          "select a.id,coalesce(sum(c.amount_cents),0)::text as total from cash_accounts a left join cash_movements c on c.account_id=a.id group by a.id order by a.id",
        )
      ).rows,
  );
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  ({ app, db } = await createApp(true));
  token = (await request(app.getHttpServer()).post("/api/v1/auth/local")).body.token;
  await post("opening", {
    date: "2025-11-01",
    cash: "0",
    bank: "0",
    clip: "0",
    inventory_mode: "external",
    lines: [],
  });
});
afterAll(async () => app?.close());
describe.sequential("Cobros automáticos y reimportación inmutable", () => {
  it("usa el método del CSV por defecto y permite corregir efectivo a transferencia antes de confirmar", async () => {
    const b = await preview([
      row("cash"),
      row("card", "credit_card", { "Paid Amount": "232" }),
      row("spei", "bank_transfer", { "Paid Amount": "348" }),
      row("override", "cash", { "Paid Amount": "464" }),
    ]);
    expect(b.rows.map((r: any) => r.payment_type)).toEqual(["cash", "card", "transfer", "cash"]);
    expect(
      (await post("confirm-import", { id: b.id, payment_types: { "clip:override": "transfer" } }))
        .status,
    ).toBe(201);
    const s = await snapshot();
    expect(s.incomes).toHaveLength(4);
    expect(s.cash).toHaveLength(4);
    expect(s.incomes.every((r: any) => r.import_collection_id)).toBe(true);
    expect(s.incomes.find((r: any) => r.external_id === "clip:override")).toMatchObject({
      channel: "transfer",
      method: "transfer",
    });
    expect(
      s.incomes.find((r: any) => r.external_id === "clip:override").clip_financial_raw[
        "Payment Method Type"
      ],
    ).toBe("cash");
    expect(await balances()).toEqual([
      { id: "bank", total: "81200" },
      { id: "cash", total: "11600" },
      { id: "clip", total: "23200" },
    ]);
    const financialReport = (
      await request(app.getHttpServer())
        .get("/api/v1/report?from=2025-11-01&to=2025-12-01")
        .set("Authorization", "Bearer " + token)
    ).body;
    expect(financialReport.collected.value).toBe("1160.00");
    expect(financialReport.cash.value).toBe("928.00");
    expect(financialReport.financial.months).toEqual([{ month: "2025-11", cash: "928.00" }]);
    expect(financialReport.financial.warnings).toHaveLength(1);
    expect(financialReport.financial.warnings[0]).toContain("1 cobro con tarjeta");
    expect(
      (
        await post("cash", {
          date: "2025-11-10",
          account_id: "cash",
          income_id: s.incomes[0].id,
          kind: "collection",
          amount: "1",
          notes: "No duplicar",
        })
      ).status,
    ).toBe(409);
  });
  it("omite una venta existente por completo aunque cambien importe, método, estado, fecha o selección", async () => {
    const before = await snapshot();
    const b = await preview(
      [
        row("override", "credit_card", {
          Date: "2025-10-01 01:00",
          "Paid Amount": "999",
          "Payment Status": "cancelled",
        }),
      ],
      { status_decisions: { cancelled: "include" } },
    );
    expect(b.duplicates).toBe(1);
    expect(b.total).toBe("0.00");
    expect(b.rows[0].payment_type).toBe("transfer");
    const r = await post("confirm-import", {
      id: b.id,
      payment_types: { "clip:override": "card" },
    });
    expect(r.status).toBe(201);
    expect(r.body.skipped_count).toBe(1);
    expect(await snapshot()).toEqual(before);
  });
  it("dos archivos solapados confirmados simultáneamente generan un solo cobro", async () => {
    const a = await preview([row("parallel")]),
      b = await preview([row("parallel")]);
    const [x, y] = await Promise.all([
      post("confirm-import", { id: a.id }),
      post("confirm-import", { id: b.id }),
    ]);
    expect(x.status).toBe(201);
    expect(y.status).toBe(201);
    const s = await snapshot(),
      income = s.incomes.find((r: any) => r.external_id === "clip:parallel");
    expect(s.cash.filter((r: any) => r.income_id === income.id)).toHaveLength(1);
  });
  it("exige elegir un tipo desconocido y la repetición de la misma confirmación no vuelve a cobrar", async () => {
    const b = await preview([row("unknown", "Sin identificar")]),
      before = await snapshot();
    expect((await post("confirm-import", { id: b.id })).body.code).toBe("payment_type_required");
    expect(await snapshot()).toEqual(before);
    const body = { id: b.id, payment_types: { "clip:unknown": "transfer" } },
      key = randomUUID();
    expect((await post("confirm-import", body, key)).status).toBe(201);
    const after = await snapshot();
    expect((await post("confirm-import", body, key)).status).toBe(201);
    expect(await snapshot()).toEqual(after);
  });
  it("cancelaciones y ventas de cero no generan dinero; un lote inválido no deja cobros parciales", async () => {
    const b = await preview(
      [
        row("cancelled", "cash", { "Payment Status": "cancelled" }),
        row("zero", "cash", { "Paid Amount": "0" }),
      ],
      { status_decisions: { cancelled: "include" } },
    );
    const before = await snapshot();
    expect((await post("confirm-import", { id: b.id })).status).toBe(201);
    expect((await snapshot()).cash).toEqual(before.cash);
    const invalid = await preview([
      row("valid-before-error"),
      row("before-opening", "cash", { Date: "2025-10-01 10:00" }),
    ]);
    const prior = await snapshot();
    expect((await post("confirm-import", { id: invalid.id })).status).toBe(400);
    expect(await snapshot()).toEqual(prior);
  });
  it("no agrega movimientos ni cambia identificadores de importaciones históricas existentes", async () => {
    await db.tx((q: any) =>
      q.query(
        "insert into incomes(id,from_date,to_date,channel,source,external_id,description,gross_cents,method) values ($1,'2025-11-10','2025-11-11','cash','clip_import','clip:tx-legacy','Histórico',11600,'cash')",
        [randomUUID()],
      ),
    );
    const before = await snapshot(),
      b = await preview([row("legacy")]);
    expect(b.duplicates).toBe(1);
    expect((await post("confirm-import", { id: b.id })).status).toBe(201);
    expect(await snapshot()).toEqual(before);
  });
});
