import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
import { clipReportRows } from "../src/modules/clip-csv";
import { stage, confirm } from "../src/modules/imports";
let app: any, db: any, token: string, incomeId: string;
const csvRow = (extra: any = {}) => ({
  Date: "2025-11-10 13:56",
  "Transaction ID": "tx-card",
  "Payment ID": "pay-card",
  "Receipt No": "P0lMPElk",
  "Payment Status": "approved",
  "Payment Currency": "MXN",
  "Base Amount": "301",
  "Tip Amount": "0",
  "Net Amount": "301.00",
  "Deferral Comission": "36.81",
  "Paid Amount": "337.81",
  "Payment Method Type": "credit_card",
  Installment: "6",
  "Installment Type": "deferred_payment",
  ...extra,
});
const post = (name: string, body: any) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + name)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", randomUUID())
    .send(body);
const getIncome = () =>
  db.tx(async (q: any) => (await q.query("select * from incomes where id=$1", [incomeId])).rows[0]);
const bank = () =>
  db.tx(
    async (q: any) =>
      (
        await q.query(
          "select count(*)::int as n,coalesce(sum(amount_cents),0)::text as total from cash_movements where account_id='bank' and kind in ('collection','transfer')",
        )
      ).rows[0],
  );
const settlement = () => ({
  id: incomeId,
  date: "2025-11-11",
  processing_fee: "10.00",
  financing_withheld: "36.81",
  creditable_tax: "1.38",
  deposited: "291.00",
  reference: "Liquidación bancaria 123",
});
const load = async (row: any, hash: string) => {
  const parsed = clipReportRows([row]);
  return db.tx((q: any) =>
    stage(q, hash + ".csv", "clip_import", parsed.rows, parsed.errors, hash),
  );
};
const historicalIncome = (receipt: string) =>
  db.tx(async (q: any) => {
    const id = randomUUID();
    await q.query(
      "insert into incomes(id,from_date,to_date,channel,source,external_id,description,gross_cents,method) values ($1,'2025-11-10','2025-11-11','clip','clip_import',$2,'Importación histórica',33781,'credit_card')",
      [id, "clip:" + receipt],
    );
    return id;
  });
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
describe.sequential("Conciliación Clip al centavo", () => {
  it("conserva el desglose real sin confundirlo con IVA, comisión ordinaria o depósito", async () => {
    const b = await load(csvRow(), "first");
    expect(b.rows[0]).toMatchObject({
      gross: "337.81",
      clip_base: "301.00",
      clip_financing: "36.81",
      clip_report_net: "301.00",
      fees: null,
      net: null,
    });
    await db.tx((q: any) => confirm(q, b.id));
    incomeId = await db.tx(async (q: any) => (await q.query("select id from incomes")).rows[0].id);
    expect(await getIncome()).toMatchObject({
      gross_cents: "33781",
      clip_base_cents: "30100",
      clip_financing_cents: "3681",
      clip_report_net_cents: "30100",
      fees_cents: null,
      deposited_cents: null,
      settled_at: null,
    });
    expect((await getIncome()).clip_financial_raw.Installment).toBe("6");
    expect(await bank()).toEqual({ n: 0, total: "0" });
    const report = await request(app.getHttpServer())
      .get("/api/v1/report?from=2025-11-01&to=2025-12-01")
      .set("Authorization", "Bearer " + token);
    expect(report.body.warnings.join(" ")).not.toMatch(/pendientes de conciliar/);
    expect(report.body.financial.warnings.join(" ")).toMatch(/sin comisión calculada/);
  });
  it("rechaza diferencias de un centavo y desgloses CSV inconsistentes sin inventar ajustes", async () => {
    expect(clipReportRows([csvRow({ "Paid Amount": "337.80" })]).errors).toHaveLength(1);
    expect((await post("settle-clip", { ...settlement(), deposited: "291.01" })).status).toBe(400);
    expect((await post("settle-clip", { ...settlement(), creditable_tax: "46.82" })).status).toBe(
      400,
    );
    expect((await post("settle-clip", { ...settlement(), date: "2025-11-09" })).status).toBe(400);
    expect(await bank()).toEqual({ n: 0, total: "0" });
  });
  it("registra el depósito neto una vez, separa IVA y reconoce todos los cargos en utilidad", async () => {
    expect((await post("settle-clip", settlement())).status).toBe(201);
    expect(await getIncome()).toMatchObject({
      deposited_cents: "29100",
      processing_fee_cents: "1000",
      financing_withheld_cents: "3681",
      fee_creditable_tax_cents: "138",
      fees_cents: "4543",
    });
    expect(await bank()).toEqual({ n: 1, total: "29100" });
    expect(
      await db.tx(
        async (q: any) =>
          (
            await q.query(
              "select coalesce(sum(amount_cents),0)::text as balance from cash_movements where account_id='clip' and income_id=$1",
              [incomeId],
            )
          ).rows[0].balance,
      ),
    ).toBe("0");
    expect((await post("settle-clip", settlement())).body.already_settled).toBe(true);
    expect(
      (await post("settle-clip", { ...settlement(), reference: "Otra liquidación" })).status,
    ).toBe(409);
    expect(
      (
        await post("cash", {
          date: "2025-11-11",
          account_id: "bank",
          income_id: incomeId,
          kind: "collection",
          amount: "1",
          notes: "No duplicar",
        })
      ).status,
    ).toBe(409);
    expect(await bank()).toEqual({ n: 1, total: "29100" });
    const r = await request(app.getHttpServer())
      .get("/api/v1/report?from=2025-11-01&to=2025-12-01")
      .set("Authorization", "Bearer " + token);
    expect(r.body.fees.value).toBe("45.43");
    expect(r.body.cash.value).toBe("291.00");
    expect(r.body.financial.months).toEqual([{ month: "2025-11", cash: "291.00" }]);
    expect(r.body.financial.movements).toEqual([
      { name: "Transferencias netas, incluidas liquidaciones de Clip", amount: "291.00" },
    ]);
    expect(r.body.financial.warnings).toEqual([]);
    expect(r.body.warnings.join(" ")).not.toMatch(/pendientes de conciliar/);
  });
  it("reimportar no duplica ni altera una liquidación y el complemento no sustituye sus comisiones", async () => {
    const b = await load(csvRow(), "reimport");
    expect(b.duplicates).toBe(1);
    await db.tx((q: any) => confirm(q, b.id));
    expect(await bank()).toEqual({ n: 1, total: "29100" });
    const changed = await load(
      csvRow({ "Base Amount": "302", "Net Amount": "302", "Paid Amount": "338.81" }),
      "changed",
    );
    const unchanged = await getIncome();
    await db.tx((q: any) => confirm(q, changed.id));
    expect(await getIncome()).toEqual(unchanged);
    expect(
      (
        await post("complement", {
          id: incomeId,
          net: null,
          cogs: null,
          fees: "1",
          category_id: null,
          reason: "No debe sustituirse",
        })
      ).status,
    ).toBe(409);
    expect((await getIncome()).gross_cents).toBe("33781");
  });
  it("la base de datos rechaza una conciliación descuadrada aunque se omita la API", async () => {
    await expect(
      db.tx((q: any) =>
        q.query("update incomes set deposited_cents=29101 where id=$1", [incomeId]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("reutiliza un depósito existente idéntico, y bloquea un depósito previo distinto", async () => {
    const i = await historicalIncome("existing");
    expect(
      (
        await post("cash", {
          date: "2025-11-11",
          account_id: "bank",
          income_id: i,
          kind: "collection",
          amount: "291",
          notes: "Depósito previamente capturado",
        })
      ).status,
    ).toBe(201);
    const before = await bank();
    expect((await post("settle-clip", { ...settlement(), id: i })).status).toBe(201);
    expect(await bank()).toEqual(before);
    const j = await historicalIncome("conflict");
    await post("cash", {
      date: "2025-11-11",
      account_id: "bank",
      income_id: j,
      kind: "collection",
      amount: "300",
      notes: "Importe anterior diferente",
    });
    const prior = await bank();
    expect((await post("settle-clip", { ...settlement(), id: j })).status).toBe(409);
    expect(await bank()).toEqual(prior);
  });
  it("revierte todo si contradice una comisión documentada y respeta meses cerrados", async () => {
    const b = await load(
      csvRow({
        "Transaction ID": "tx-rollback",
        "Payment ID": "pay-rollback",
        "Receipt No": "rollback",
      }),
      "rollback",
    );
    await db.tx((q: any) => confirm(q, b.id));
    const i = await db.tx(
      async (q: any) =>
        (await q.query("select id from incomes where clip_receipt_no='rollback'")).rows[0].id,
    );
    await post("complement", {
      id: i,
      net: null,
      cogs: null,
      fees: "1",
      category_id: null,
      reason: "Comisión previamente documentada",
    });
    const before = await bank();
    expect((await post("settle-clip", { ...settlement(), id: i })).status).toBe(409);
    expect(await bank()).toEqual(before);
    expect(
      await db.tx(
        async (q: any) =>
          (await q.query("select settled_at from incomes where id=$1", [i])).rows[0].settled_at,
      ),
    ).toBeNull();
    await db.tx((q: any) =>
      q.query(
        "insert into monthly_closes(id,month,status,snapshot,checklist) values ($1,'2025-11','closed','{}','[]')",
        [randomUUID()],
      ),
    );
    expect((await post("settle-clip", { ...settlement(), id: i })).status).toBe(409);
    expect(await bank()).toEqual(before);
  });
});
