import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
import { stage, confirm } from "../src/modules/imports";
import { clipReportRows } from "../src/modules/clip-csv";
let app: any, db: any, token: string, expense: string, purchase: string, invoice: string;
const post = (name: string, body: any) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + name)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", randomUUID())
    .send(body);
const get = (path: string) =>
  request(app.getHttpServer())
    .get("/api/v1" + path)
    .set("Authorization", "Bearer " + token);
const counts = () =>
  db.tx(
    async (q: any) =>
      (
        await q.query(
          "select (select count(*)::int from purchases) as purchases,(select count(*)::int from expenses) as expenses,(select count(*)::int from cash_movements) as cash,(select count(*)::int from tax_documents) as proofs,(select count(*)::int from monthly_cogs) as costs",
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
    cash: "1000",
    bank: "1000",
    clip: "0",
    inventory_mode: "external",
    lines: [],
  });
  await post("tax-profile", {});
  const supplier = (await post("supplier", { name: "Makers" })).body.id;
  invoice = randomUUID();
  purchase = (
    await post("purchase", {
      date: "2025-11-10",
      supplier_id: supplier,
      reference: invoice,
      merchandise: "100",
      tax: "16",
      initial_payment: { account_id: "bank" },
    })
  ).body.id;
  await post("purchase", {
    date: "2025-11-11",
    supplier_id: supplier,
    merchandise: "200",
    tax: "32",
  });
  expense = (
    await post("expense", {
      date: "2025-11-12",
      category: "Publicidad",
      concept: "Meta Ads",
      amount: "100",
      tax_mode: "total_no_credit",
      initial_payment: { account_id: "cash" },
    })
  ).body.id;
  const data = clipReportRows([
    {
      Date: "2025-11-12 10:00",
      "Transaction ID": "auto-tx",
      "Payment ID": "auto-pay",
      "Receipt No": "auto",
      "Payment Status": "approved",
      "Payment Currency": "MXN",
      "Paid Amount": "58",
      "Payment Method Type": "cash",
    },
  ]);
  const b = await db.tx((q: any) => stage(q, "cash.csv", "clip_import", data.rows, [], "autofill"));
  await db.tx((q: any) => confirm(q, b.id));
});
afterAll(async () => app?.close());
describe.sequential("Datos fiscales desde compras y gastos existentes", () => {
  it("integra importes y pagos sin duplicar documentos ni inventar el costo de lo vendido", async () => {
    const before = await counts(),
      r = (await get("/report?from=2025-11-01&to=2025-12-01")).body,
      s = r.sourceSummary;
    expect(s.purchases_total.value).toBe("348.00");
    expect(s.acquisition_cost.value).toBe("300.00");
    expect(s.expenses_total.value).toBe("100.00");
    expect(s.operating_expense.value).toBe("100.00");
    expect(s.purchases_paid.value).toBe("116.00");
    expect(s.expenses_paid.value).toBe("100.00");
    expect(s.vat_recorded.value).toBe("48.00");
    expect(s.vat_paid_pending.value).toBe("16.00");
    expect(r.cash.value).toBe("-158.00");
    expect(r.financial.months).toEqual([{ month: "2025-11", cash: "-158.00" }]);
    expect(r.financial.warnings).toEqual([]);
    expect(
      r.financial.movements.reduce(
        (total: number, m: any) => total + Math.round(Number(m.amount) * 100),
        0,
      ),
    ).toBe(-15800);
    const exported = await get("/exports/financial?from=2025-11-01&to=2025-12-01&format=csv");
    expect(exported.status).toBe(200);
    expect(exported.text).toContain("Flujo de caja disponible");
    expect(exported.text).not.toMatch(
      /Costo de mercancía vendida|Utilidad bruta|Resultado operativo/,
    );
    expect(r.cogs.value).toBeNull();
    await get("/tax/documents");
    await get("/report?from=2025-11-01&to=2025-12-01");
    expect(await counts()).toEqual(before);
    expect(before.costs).toBe(0);
  });
  it("reutiliza el tratamiento sin IVA recuperable, los pagos, la referencia y el UUID ya existentes", async () => {
    const docs = (await get("/tax/documents")).body;
    const e = docs.find((r: any) => r.id === expense),
      p = docs.find((r: any) => r.id === purchase);
    expect(e.automatic_treatment).toBe(true);
    expect(e.proof.status).toBe("nonrecoverable");
    expect(e.paid_cents).toBe("10000");
    expect(p.invoice_uuid_suggestion).toBe(invoice);
    expect(p.paid_cents).toBe("11600");
    expect(p.vat_paid_cents).toBe("1600");
    expect(p.proof).toBeNull();
    expect(p.default_notes).toContain("Makers");
    expect((await counts()).proofs).toBe(0);
  });
  it("las cancelaciones se reflejan sin borrar los pagos que realmente salieron", async () => {
    expect(
      (
        await post("cancel-expense", {
          id: expense,
          reason: "Gasto capturado por error de registro",
        })
      ).status,
    ).toBe(201);
    const r = (await get("/report?from=2025-11-01&to=2025-12-01")).body;
    expect(r.sourceSummary.expense_count).toBe(0);
    expect(r.sourceSummary.expenses_total.value).toBe("0.00");
    expect(r.sourceSummary.expenses_paid.value).toBe("100.00");
    expect(r.cash.value).toBe("-158.00");
    expect(r.financial.warnings).toContain(
      "Hay pagos de compras o gastos cancelados pendientes de recuperar.",
    );
  });
  it("conserva el total original del gasto cuando su IVA se reconoce como no recuperable", async () => {
    const e = await post("expense", {
      date: "2025-11-13",
      category: "Servicios",
      concept: "Servicio con IVA no recuperable",
      amount: "50",
      tax: "8",
    });
    expect(e.status).toBe(201);
    expect(
      (
        await post("tax-document", {
          id: e.body.id,
          type: "expense",
          status: "nonrecoverable",
          notes: "IVA no recuperable confirmado",
        })
      ).status,
    ).toBe(201);
    const r = (await get("/report?from=2025-11-01&to=2025-12-01")).body;
    expect(r.recentExpenses.find((row: any) => row.id === e.body.id)).toMatchObject({
      amount_cents: "5800",
      total_cents: "5800",
      tax_cents: "800",
    });
  });
  it("no convierte transferencias internas, aportaciones o retiros en flujo de operación", async () => {
    const path = "/report?from=2025-11-01&to=2025-12-01";
    const before = (await get(path)).body;
    for (const body of [
      { account_id: "cash", destination: "bank", kind: "transfer", amount: "25" },
      { account_id: "bank", kind: "contribution", amount: "100" },
      { account_id: "bank", kind: "withdrawal", amount: "20" },
    ])
      expect(
        (await post("cash", { ...body, date: "2025-11-15", notes: "Movimiento del propietario" }))
          .status,
      ).toBe(201);
    const after = (await get(path)).body;
    expect(after.cash).toEqual(before.cash);
    expect(after.financial.months).toEqual(before.financial.months);
    expect(after.financial.movements).toEqual(before.financial.movements);
  });
});
