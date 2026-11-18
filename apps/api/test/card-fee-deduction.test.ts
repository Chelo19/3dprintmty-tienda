import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
let app: any, db: any, token: string, oldId: string;
const post = (name: string, body: any) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + name)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", randomUUID())
    .send(body);
const get = (path: string) =>
  request(app.getHttpServer())
    .get("/api/v1/" + path)
    .set("Authorization", "Bearer " + token);
const row = (key: string, method = "credit_card", amount = "100") => ({
  Date: "2025-11-10 12:00",
  "Transaction ID": "tx-" + key,
  "Payment ID": "pay-" + key,
  "Receipt No": key,
  "Payment Status": "approved",
  "Payment Currency": "MXN",
  "Paid Amount": amount,
  "Payment Method Type": method,
});
const preview = async (rows: any[]) => {
  const result = await request(app.getHttpServer())
    .post("/api/v1/imports/preview")
    .set("Authorization", "Bearer " + token)
    .send({
      filename: "clip.csv",
      file_hash: randomUUID().replaceAll("-", "").repeat(2),
      rows,
      mapping: {},
    });
  expect(result.status).toBe(201);
  return result.body;
};
const load = async (rows: any[]) => {
  const b = await preview(rows);
  const r = await post("confirm-import", { id: b.id });
  expect(r.status).toBe(201);
  return b;
};
const snapshot = () =>
  db.tx(async (q: any) => ({
    incomes: (await q.query("select * from incomes order by id")).rows,
    cash: (await q.query("select * from cash_movements order by id")).rows,
    fees: (await q.query("select * from income_card_fee_estimates order by income_id")).rows,
  }));
const rule = (percent = "2.99") =>
  post("fee-rule", { method: "Crédito", percent, fixed: "1", tax_percent: "16", msi_percent: "0" });
const msiRule = (term: number, percent: string) =>
  post("fee-rule", {
    method: "MSI",
    installments: term,
    percent: "2.99",
    fixed: "1",
    tax_percent: "16",
    msi_percent: percent,
  });
const msiRow = (key: string, term: number) => ({
  ...row(key, "credit_card", "1000"),
  Installment: String(term),
  "Installment Type": "MSI",
  "Base Amount": "1000",
  "Tip Amount": "0",
  "Deferral Comission": "0.00",
  "Net Amount": "1000.00",
});
const incomeId = async (key: string) =>
  (await get("incomes")).body.find((r: any) => r.external_id === "clip:" + key).id;
const balance = async (id: string) =>
  db.tx(
    async (q: any) =>
      (
        await q.query(
          "select coalesce(sum(amount_cents),0)::text as amount from cash_movements where income_id=$1 and account_id='clip'",
          [id],
        )
      ).rows[0].amount,
  );
const settle = (id: string, processing = "4.63", deposited = "95.37", financing = "0") =>
  post("settle-clip", {
    id,
    date: "2025-11-11",
    processing_fee: processing,
    financing_withheld: financing,
    creditable_tax: "0.64",
    deposited,
    reference: "Liquidación bancaria verificada",
  });
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
  await load([row("old")]);
  oldId = await incomeId("old");
  expect((await rule()).status).toBe(201);
});
afterAll(async () => app?.close());
describe.sequential("Comisión de tarjeta descontada de Clip", () => {
  it("aplica la tarifa a un cobro existente sin modificar la venta ni el movimiento de cobro original", async () => {
    const before = await snapshot();
    expect((await post("apply-card-fee", { id: oldId })).body.applied_count).toBe(1);
    const after = await snapshot();
    expect(after.incomes).toEqual(before.incomes);
    expect(after.cash.filter((r: any) => r.kind === "collection")).toEqual(before.cash);
    expect(await balance(oldId)).toBe("9537");
    expect(after.cash.find((r: any) => r.kind === "clip_fee_estimate")).toMatchObject({
      amount_cents: "-463",
      account_id: "clip",
      income_id: oldId,
    });
    expect((await post("apply-card-fee", { id: oldId })).body.already_applied_count).toBe(1);
    expect(await snapshot()).toEqual(after);
  });
  it("descuenta automáticamente comisión e IVA para débito y crédito, sin afectar efectivo o transferencia", async () => {
    await load([
      row("credit"),
      row("debit", "debit_card"),
      row("cash", "cash"),
      row("transfer", "bank_transfer"),
    ]);
    const s = await snapshot();
    for (const key of ["credit", "debit"]) {
      const id = await incomeId(key);
      expect(await balance(id)).toBe("9537");
      expect(s.fees.find((r: any) => r.income_id === id)).toMatchObject({
        processing_cents: "463",
        tax_cents: "64",
      });
    }
    for (const key of ["cash", "transfer"])
      expect(
        s.fees.some(
          (r: any) =>
            r.income_id === s.incomes.find((i: any) => i.external_id === "clip:" + key).id,
        ),
      ).toBe(false);
    const current = (await get("incomes")).body.find((r: any) => r.external_id === "clip:credit");
    expect(current).toMatchObject({
      gross_cents: "10000",
      fee_applied: true,
      fees_cents: null,
      settled_at: null,
    });
  });
  it("reimportar y cambiar tarifas conserva los descuentos anteriores sin volver a descontar", async () => {
    const before = await snapshot();
    await load([row("credit"), row("debit", "debit_card")]);
    expect(await snapshot()).toEqual(before);
    await rule("3.5");
    const rows = (await get("incomes")).body;
    expect(
      rows.find((r: any) => r.external_id === "clip:credit").fee_estimate.processing_cents,
    ).toBe("463");
    await load([row("new-rate")]);
    expect(await balance(await incomeId("new-rate"))).toBe("9478");
    await rule();
  });
  it("la conciliación transfiere el neto y no duplica la comisión ya descontada", async () => {
    const id = await incomeId("credit");
    expect((await settle(id)).status).toBe(201);
    expect(await balance(id)).toBe("0");
    const s = await snapshot(),
      cash = s.cash.filter((r: any) => r.income_id === id);
    expect(cash.filter((r: any) => r.kind === "clip_fee_estimate")).toHaveLength(1);
    expect(
      cash.filter((r: any) => r.kind === "clip_fee" || r.kind === "clip_fee_adjustment"),
    ).toHaveLength(0);
    expect(cash.find((r: any) => r.account_id === "bank")).toMatchObject({ amount_cents: "9537" });
    expect((await settle(id)).body.already_settled).toBe(true);
    expect(await snapshot()).toEqual(s);
  });
  it.each([
    ["higher", "4.64", "95.36", "-1"],
    ["lower", "4.62", "95.38", "1"],
  ])("ajusta al centavo cuando la comisión real es %s", async (key, fee, net, adjustment) => {
    await load([row(key)]);
    const id = await incomeId(key);
    expect((await settle(id, fee, net)).status).toBe(201);
    expect(await balance(id)).toBe("0");
    const s = await snapshot();
    expect(
      s.cash.find((r: any) => r.income_id === id && r.kind === "clip_fee_adjustment"),
    ).toMatchObject({ amount_cents: adjustment });
  });
  it("los cargos de financiamiento solo se descuentan al confirmar su importe real", async () => {
    await load([row("finance")]);
    const id = await incomeId("finance");
    expect((await settle(id, "4.63", "85.37", "10")).status).toBe(201);
    expect(await balance(id)).toBe("0");
    expect(
      (await snapshot()).cash.find(
        (r: any) => r.income_id === id && r.kind === "clip_fee_adjustment",
      ),
    ).toMatchObject({ amount_cents: "-1000" });
  });
  it("dos importaciones simultáneas generan una sola comisión por venta", async () => {
    const a = await preview([row("overlap")]),
      b = await preview([row("overlap")]);
    const responses = await Promise.all([
      post("confirm-import", { id: a.id }),
      post("confirm-import", { id: b.id }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    const id = await incomeId("overlap");
    expect(
      (await snapshot()).cash.filter(
        (r: any) => r.income_id === id && r.kind === "clip_fee_estimate",
      ),
    ).toHaveLength(1);
    expect(await balance(id)).toBe("9537");
  });
  it("una tarifa mayor que el cobro revierte la importación completa sin dejar dinero parcial", async () => {
    const b = await preview([row("too-small", "credit_card", "0.01")]),
      before = await snapshot();
    const result = await post("confirm-import", { id: b.id });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe("fee_exceeds_sale");
    expect(await snapshot()).toEqual(before);
  });
  it("guarda reglas MSI independientes por plazo y exige identificarlo", async () => {
    expect(
      (
        await post("fee-rule", {
          method: "MSI",
          percent: "2.99",
          fixed: "1",
          tax_percent: "16",
          msi_percent: "4.57",
        })
      ).status,
    ).toBe(400);
    for (const [term, rate] of [
      [3, "4.57"],
      [6, "7"],
      [9, "10"],
      [12, "13"],
    ] as const)
      expect((await msiRule(term, rate)).status).toBe(201);
    expect((await msiRule(3, "4.57")).status).toBe(201);
    expect((await get("fee-rules")).body.filter((r: any) => r.method === "MSI")).toHaveLength(4);
  });
  it.each([
    [3, "5301"],
    [6, "8120"],
    [9, "11600"],
    [12, "15080"],
  ])(
    "aplica el recargo específico de %s MSI aunque el CSV reporte diferimiento cero",
    async (term, financing) => {
      await load([msiRow("term-" + term, Number(term))]);
      const id = await incomeId("term-" + term),
        s = await snapshot();
      expect(await balance(id)).toBe((100000n - 3584n - BigInt(financing)).toString());
      expect(
        s.cash.filter((r: any) => r.income_id === id && r.kind === "clip_msi_fee_estimate"),
      ).toHaveLength(1);
      const quote = (await get("incomes")).body.find((r: any) => r.id === id);
      expect(quote).toMatchObject({
        fee_applied: true,
        msi_fee_applied: true,
        fee_needs_apply: false,
        fee_estimate: {
          processing_cents: "3584",
          financing_cents: String(financing),
          installments: Number(term),
        },
      });
    },
  );
  it("no sustituye un plazo sin configurar y permite aplicar su tarifa cuando se registra", async () => {
    await load([msiRow("missing-term", 18)]);
    const id = await incomeId("missing-term");
    expect(await balance(id)).toBe("100000");
    const quote = (await get("incomes")).body.find((r: any) => r.id === id);
    expect(quote).toMatchObject({ fee_missing_rule: true, fee_estimate: null });
    expect(
      (await get("report?from=2025-11-01&to=2025-12-01")).body.financial.warnings.join(" "),
    ).toContain("18 meses");
    await msiRule(18, "15");
    expect((await post("apply-card-fee", { id })).body.msi_applied_count).toBe(1);
    expect(await balance(id)).toBe("79016");
  });
  it("completa únicamente el cargo MSI en ventas que ya tenían descontada su comisión base", async () => {
    await load([row("legacy-msi", "credit_card", "1000")]);
    const id = await incomeId("legacy-msi");
    // Reproduce a pre-feature import: original CSV metadata already said MSI, but only base fee was supported.
    await db.tx((q: any) =>
      q.query("update incomes set clip_financial_raw=$1 where id=$2", [
        JSON.stringify(msiRow("legacy-msi", 3)),
        id,
      ]),
    );
    const before = await snapshot();
    expect((await post("apply-card-fee", { id })).body.msi_applied_count).toBe(1);
    const after = await snapshot();
    expect(after.incomes).toEqual(before.incomes);
    expect(
      after.cash.filter((r: any) => r.income_id === id && r.kind === "clip_fee_estimate"),
    ).toEqual(before.cash.filter((r: any) => r.income_id === id && r.kind === "clip_fee_estimate"));
    expect(await balance(id)).toBe("91115");
    expect((await post("apply-card-fee", { id })).body.msi_applied_count).toBe(0);
    await load([msiRow("legacy-msi", 3)]);
    expect(await snapshot()).toEqual(after);
  });
  it("concilia el depósito neto MSI sin repetir el procesamiento ni el financiamiento descontados", async () => {
    const id = await incomeId("term-3");
    const body = {
      id,
      date: "2025-11-11",
      processing_fee: "35.84",
      financing_withheld: "53.01",
      creditable_tax: "12.25",
      deposited: "911.15",
      reference: "Liquidación MSI conciliada",
    };
    expect((await post("settle-clip", body)).status).toBe(201);
    expect(await balance(id)).toBe("0");
    const detail = (await get("incomes")).body.find((r: any) => r.id === id);
    expect(detail.fee_estimate).toBeNull();
    expect(detail.applied_fee_breakdown).toMatchObject({
      percent: "2.9900",
      fixed_cents: "100",
      processing_cents: "3584",
      processing_tax_cents: "494",
      financing_cents: "5301",
      financing_tax_cents: "731",
      total_cents: "8885",
      tax_cents: "1225",
    });
    const after = await snapshot();
    expect(
      after.cash.filter((r: any) => r.income_id === id && r.kind === "clip_fee_adjustment"),
    ).toHaveLength(0);
    expect((await post("settle-clip", body)).body.already_settled).toBe(true);
    expect(await snapshot()).toEqual(after);
  });
  it("cambiar una tarifa MSI no modifica cargos que ya fueron aplicados", async () => {
    const id = await incomeId("term-6"),
      before = await snapshot();
    await msiRule(6, "8");
    expect(
      (await get("incomes")).body.find((r: any) => r.id === id).fee_estimate.financing_cents,
    ).toBe("8120");
    expect(await snapshot()).toEqual(before);
  });
  it("bloquea agregar un cargo MSI a un periodo cerrado", async () => {
    await load([msiRow("closed-term", 24)]);
    const id = await incomeId("closed-term");
    await msiRule(24, "20");
    await db.tx((q: any) =>
      q.query(
        "insert into monthly_closes(id,month,status,snapshot,checklist) values ($1,'2025-11','closed','{}','{}')",
        [randomUUID()],
      ),
    );
    const before = await snapshot();
    expect((await post("apply-card-fee", { id })).body.code).toBe("month_closed");
    expect(await snapshot()).toEqual(before);
  });
});
