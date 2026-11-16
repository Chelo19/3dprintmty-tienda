import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
import { stage, confirm } from "../src/modules/imports";
import { clipReportRows } from "../src/modules/clip-csv";
import { netAt16, resicoTax } from "../src/modules/tax-math";
let app: any,
  db: any,
  token: string,
  income: string,
  expense: string,
  supplier: string,
  invoice: string;
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
const report = () => get("/report?from=2025-11-01&to=2025-12-01");
const other = (month = "2025-11") =>
  post("monthly-tax", {
    month,
    reference: "Ajustes confirmados de esta tienda",
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
    bank: "10000",
    clip: "0",
    inventory_mode: "external",
    lines: [],
  });
  expect((await post("tax-profile", {})).status).toBe(201);
  supplier = (await post("supplier", { name: "Proveedor" })).body.id;
});
afterAll(async () => app?.close());
it("aplica la tabla RESICO al total de ingresos sin IVA y redondea al centavo", () => {
  expect(netAt16(11600n)).toBe(10000n);
  expect(netAt16(1n) + 1n - netAt16(1n)).toBe(1n);
  expect(resicoTax(2500000n)).toEqual({ tax: 25000n, rate: "1.00" });
  expect(resicoTax(2500001n)?.rate).toBe("1.10");
  expect(resicoTax(5000001n)?.rate).toBe("1.50");
  expect(resicoTax(8333334n)?.rate).toBe("2.00");
  expect(resicoTax(20833334n)?.rate).toBe("2.50");
  expect(resicoTax(350000001n)).toBeNull();
});
describe.sequential("Utilidad mensual e impuestos separados", () => {
  it("desglosa ventas históricas ordinarias sin alterar ingresos ni movimientos de dinero", async () => {
    const parsed = clipReportRows([
      {
        Date: "2025-11-10 10:00",
        "Transaction ID": "tx-tax",
        "Payment ID": "pay-tax",
        "Receipt No": "tax",
        "Payment Status": "approved",
        "Payment Currency": "MXN",
        "Paid Amount": "116",
        "Payment Method Type": "cash",
      },
    ]);
    const b = await db.tx((q: any) => stage(q, "tax.csv", "clip_import", parsed.rows, [], "tax"));
    await db.tx((q: any) => confirm(q, b.id));
    expect(
      (await db.tx(async (q: any) => (await q.query("select net_cents from incomes")).rows[0]))
        .net_cents,
    ).toBe("10000");
    await db.tx((q: any) => q.query("update incomes set net_cents=null"));
    const before = await db.tx(async (q: any) => (await q.query("select * from incomes")).rows[0]);
    income = before.id;
    const r = (await report()).body;
    expect(r.sales.value).toBe("100.00");
    expect(r.fees.value).toBe("0.00");
    expect(r.fiscal.vat_collected.value).toBe("16.00");
    expect(r.fiscal.isr_due.value).toBe("1.00");
    expect(
      await db.tx(
        async (q: any) => (await q.query("select * from incomes where id=$1", [income])).rows[0],
      ),
    ).toEqual(before);
    const listed = (await get("/incomes")).body[0];
    expect(listed.net_cents).toBe("10000");
    expect(listed.net_calculated).toBe(true);
  });
  it("usa un costo mensual único sin sumar el costo por venta y estima ISR únicamente con los ingresos de esta tienda", async () => {
    await db.tx((q: any) => q.query("update incomes set cogs_cents=1000 where id=$1", [income]));
    expect(
      (
        await post("monthly-cost", {
          month: "2025-11",
          amount: "40",
          reference: "Costo confirmado desde inventario externo",
        })
      ).status,
    ).toBe(201);
    expect((await other()).status).toBe(201);
    const r = (await report()).body;
    expect(r.cogs.value).toBe("40.00");
    expect(r.operating.value).toBe("60.00");
    expect(r.fiscal.monthly[0].rate).toBe("1.00");
    expect(r.fiscal.isr_estimate.value).toBe("1.00");
    expect(r.fiscal.isr_estimate.value).toBe("1.00");
    expect(r.afterIsr.value).toBe("59.00");
    expect(r.fiscal.vat_due.value).toBe("16.00");
    const slice = (await get("/report?from=2025-11-10&to=2025-11-11")).body;
    expect(slice.cogs.value).toBeNull();
    expect(slice.fiscal.isr_estimate.value).toBeNull();
    expect(slice.fiscal.vat_due.value).toBeNull();
  });
  it("acredita IVA solo al estar comprobado y pagado, proporcionalmente a los pagos", async () => {
    expense = (
      await post("expense", {
        date: "2025-11-10",
        category: "Otros",
        concept: "Comprobante prueba",
        amount: "100",
        tax: "16",
      })
    ).body.id;
    await post("cash", {
      date: "2025-11-10",
      account_id: "bank",
      expense_id: expense,
      kind: "expense",
      amount: "58",
      notes: "Primer pago mitad",
    });
    expect((await report()).body.fiscal.vat_creditable.value).toBe("0.00");
    invoice = randomUUID();
    expect(
      (
        await post("tax-document", {
          id: expense,
          type: "expense",
          status: "creditable",
          invoice_uuid: invoice,
          invoice_vat: "16",
          eligible_on: "2025-11-10",
          notes: "CFDI verificado y requisitos cumplidos",
        })
      ).status,
    ).toBe(201);
    let r = (await report()).body;
    expect(r.fiscal.vat_creditable.value).toBe("8.00");
    expect(r.fiscal.vat_due.value).toBe("8.00");
    expect(r.operating.value).toBe("-40.00");
    expect(r.fiscal.isr_estimate.value).toBe("1.00");
    await post("cash", {
      date: "2025-11-11",
      account_id: "bank",
      expense_id: expense,
      kind: "expense",
      amount: "29",
      notes: "Segundo pago parcial",
    });
    r = (await report()).body;
    expect(r.fiscal.vat_creditable.value).toBe("12.00");
  });
  it("evita acreditar dos veces el IVA de un CFDI y reconoce pagos previos al recibir factura después", async () => {
    const p = (
      await post("purchase", {
        date: "2025-11-10",
        supplier_id: supplier,
        merchandise: "1000",
        tax: "160",
        initial_payment: { account_id: "bank" },
      })
    ).body.id;
    expect(
      (
        await post("tax-document", {
          id: p,
          type: "purchase",
          status: "creditable",
          invoice_uuid: invoice,
          invoice_vat: "16",
          eligible_on: "2025-11-11",
          notes: "No debe caber en el mismo CFDI",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post("tax-document", {
          id: p,
          type: "purchase",
          status: "creditable",
          invoice_uuid: randomUUID(),
          invoice_vat: "160",
          eligible_on: "2025-12-01",
          notes: "Factura obtenida y verificada en diciembre",
        })
      ).status,
    ).toBe(201);
    expect((await report()).body.fiscal.vat_creditable.value).toBe("12.00");
    await post("monthly-tax", {
      month: "2025-12",
      reference: "Sin ajustes fiscales durante diciembre",
    });
    const dec = (await get("/report?from=2025-12-01&to=2026-01-01")).body;
    expect(dec.fiscal.vat_creditable.value).toBe("160.00");
    expect(dec.fiscal.vat_favor.value).toBe("160.00");
  });
  it("incluye IVA no recuperable en el gasto sin reducir la base de ISR", async () => {
    expect(
      (
        await post("tax-document", {
          id: expense,
          type: "expense",
          status: "nonrecoverable",
          notes: "Confirmado que este IVA no es recuperable",
        })
      ).status,
    ).toBe(201);
    const r = (await report()).body;
    expect(r.expenses.value).toBe("116.00");
    expect(r.fiscal.vat_creditable.value).toBe("0.00");
    expect(r.fiscal.isr_estimate.value).toBe("1.00");
  });
  it("ignora totales y retenciones históricos del RFC y no vuelve a solicitarlos", async () => {
    await db.tx((q: any) =>
      q.query(
        "insert into monthly_tax_inputs(month,other_income_cents,other_vat_collected_cents,other_vat_creditable_cents,isr_withheld_cents,vat_withheld_cents,vat_carry_cents,reference) values ('2025-10',349000000,999999,888888,777777,666666,555555,'Totales anteriores de RFC')",
      ),
    );
    await db.tx((q: any) =>
      q.query(
        "update monthly_tax_inputs set scope='legacy_rfc',isr_withheld_cents=777777,vat_withheld_cents=666666,vat_carry_cents=555555 where month='2025-11'",
      ),
    );
    const r = (await report()).body;
    expect(r.fiscal.isr_estimate.value).toBe("1.00");
    expect(r.fiscal.isr_due.value).toBe("1.00");
    expect(r.fiscal.vat_due.value).toBe("16.00");
    expect(r.fiscal.monthly[0].annual_limit_exceeded).toBe(false);
    expect(r.fiscal.monthly[0].pending_reason).toBeNull();
    const data = (await get("/tax/monthly")).body;
    expect(data.inputs.every((row: any) => !("other_income_cents" in row))).toBe(true);
    expect(data.inputs.some((row: any) => row.month === "2025-10")).toBe(false);
    expect(
      (
        await post("monthly-tax", {
          month: "2025-11",
          other_income: "100",
          reference: "No aceptar otros negocios",
        })
      ).status,
    ).toBe(400);
  });
  it("solicita revisar el costo si llegan nuevas ventas y permite retirarlo explícitamente", async () => {
    const parsed = clipReportRows([
      {
        Date: "2025-11-12 10:00",
        "Transaction ID": "tx-after-cost",
        "Payment ID": "pay-after-cost",
        "Receipt No": "after-cost",
        "Payment Status": "approved",
        "Payment Currency": "MXN",
        "Paid Amount": "116",
        "Payment Method Type": "cash",
      },
    ]);
    const b = await db.tx((q: any) =>
      stage(q, "after-cost.csv", "clip_import", parsed.rows, [], "after-cost"),
    );
    await db.tx((q: any) => confirm(q, b.id));
    expect((await report()).body.cogs.value).toBeNull();
    expect(
      (
        await post("monthly-cost", {
          month: "2025-11",
          amount: "40",
          reference: "Costo actualizado después de nuevas ventas",
        })
      ).status,
    ).toBe(201);
    expect((await report()).body.cogs.value).toBe("40.00");
    expect(
      (
        await post("monthly-cost", {
          month: "2025-11",
          amount: "40",
          active: false,
          reference: "Retiro temporal de costo pendiente de revisión",
        })
      ).status,
    ).toBe(201);
    expect((await report()).body.cogs.value).toBeNull();
  });
  it("las tablas fiscales respetan RLS y los meses cerrados bloquean cambios", async () => {
    await db.tx(async (q: any) => {
      await q.query("select set_config('app.author','otro@example.com',true)");
      for (const table of ["monthly_cogs", "monthly_tax_inputs", "tax_documents"])
        expect((await q.query("select count(*)::int as n from " + table)).rows[0].n).toBe(0);
    });
    await db.tx((q: any) =>
      q.query(
        "insert into monthly_closes(id,month,status,snapshot,checklist) values ($1,'2025-11','closed','{}','[]')",
        [randomUUID()],
      ),
    );
    expect(
      (
        await post("monthly-cost", {
          month: "2025-11",
          amount: "1",
          reference: "No alterar un cierre",
        })
      ).status,
    ).toBe(409);
    expect((await other()).status).toBe(409);
    expect(
      (
        await post("tax-document", {
          id: expense,
          type: "expense",
          status: "pending",
          notes: "No alterar un cierre fiscal",
        })
      ).status,
    ).toBe(409);
  });
  it("al corregir efectivo a tarjeta conserva pendiente la comisión para conciliarla", async () => {
    const parsed = clipReportRows([
      {
        Date: "2026-01-10 10:00",
        "Transaction ID": "tx-reclass",
        "Payment ID": "pay-reclass",
        "Receipt No": "reclass",
        "Payment Status": "approved",
        "Payment Currency": "MXN",
        "Paid Amount": "116",
        "Payment Method Type": "cash",
      },
    ]);
    const b = await db.tx((q: any) =>
      stage(q, "reclass.csv", "clip_import", parsed.rows, [], "reclass"),
    );
    await db.tx((q: any) => confirm(q, b.id, { "clip:reclass": "card" }));
    const stored = await db.tx(
      async (q: any) =>
        (await q.query("select * from incomes where external_id='clip:reclass'")).rows[0],
    );
    expect(stored.channel).toBe("clip");
    expect(stored.fees_cents).toBeNull();
    expect(stored.net_cents).toBe("10000");
    expect(
      (
        await post("settle-clip", {
          id: stored.id,
          date: "2026-01-11",
          processing_fee: "3",
          financing_withheld: "0",
          creditable_tax: "0",
          deposited: "113",
          reference: "Conciliación documentada correcta",
        })
      ).status,
    ).toBe(201);
  });
});
