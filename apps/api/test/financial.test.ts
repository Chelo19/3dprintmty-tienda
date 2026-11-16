import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
import { stage, mapRows, fileRows } from "../src/modules/imports";
import { csv } from "../src/modules/reports";
import ExcelJS from "exceljs";
let app: any,
  db: any,
  token = "",
  category = "",
  product = "",
  supplier = "",
  purchase = "",
  income = "",
  expense = "";
const post = (action: string, body: any, key = randomUUID()) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + action)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", key)
    .send(body);
const get = (path: string) =>
  request(app.getHttpServer())
    .get("/api/v1" + path)
    .set("Authorization", "Bearer " + token);
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  ({ app, db } = await createApp(true));
  // Historical SKU flows remain covered without enabling them in the current application.
  await db.tx((q: any) => q.query("update settings set inventory_mode='detailed'"));
  const result = await request(app.getHttpServer()).post("/api/v1/auth/local");
  expect(result.status).toBe(201);
  token = result.body.token;
  category = (await get("/categories")).body[0].id;
});
afterAll(async () => {
  await app?.close();
});
describe.sequential("Flujo financiero real con PGlite y Nest", () => {
  it("requiere identidad y prueba disponibilidad de DB", async () => {
    expect((await request(app.getHttpServer()).get("/api/v1/products")).status).toBe(401);
    expect((await get("/health")).body.status).toBe("ok");
    expect((await get("/settings")).body.owner_email).toBe("mdeleon@3dprintmty.com");
  });
  it("retira los endpoints de Clip y su historial de consultas", async () => {
    expect((await get("/dev/clip")).status).toBe(404);
    expect((await get("/sync")).status).toBe(404);
    for (const path of ["/api/v1/clip/preview", "/api/v1/dev/clip/query"]) {
      const response = await request(app.getHttpServer())
        .post(path)
        .set("Authorization", "Bearer " + token)
        .send({ from: "2026-11-01", to: "2026-12-01" });
      expect(response.status).toBe(404);
    }
    expect((await get("/settings")).body).not.toHaveProperty("clip_configured");
  });
  it("catálogos y captura idempotente no duplican productos", async () => {
    const key = randomUUID(),
      body = { sku: "PLA-1", name: "PLA negro", category_id: category, price: "250" };
    const first = await post("product", body, key);
    expect(first.status).toBe(201);
    product = first.body.id;
    expect((await post("product", body, key)).body.id).toBe(product);
    expect((await post("product", { ...body, name: "Otro" }, key)).status).toBe(409);
    supplier = (await post("supplier", { name: "Proveedor local" })).body.id;
  });
  it("bloquea operaciones previas a apertura", async () => {
    expect(
      (
        await post("expense", {
          date: "2026-11-01",
          category: "Renta",
          concept: "Renta",
          amount: "100",
        })
      ).status,
    ).toBe(400);
  });
  it("permite previsualizar archivos pero exige apertura al confirmar ingresos", async () => {
    const rows = mapRows(
      [{ id: "before-opening", date: "2026-11-03", amount: "116", status: "approved" }],
      { external_id: "id", date: "date", gross: "amount", status: "status" },
    );
    const draft = await db.tx((q: any) =>
      stage(q, "reporte.csv", "clip_import", rows.rows, rows.errors, "before-opening"),
    );
    const result = await post("confirm-import", {
      id: draft.id,
      payment_types: { [draft.rows[0].external_id]: "cash" },
    });
    expect(result.body.code).toBe("opening_required");
  });
  it("rechaza un lote mediante una acción autenticada e idempotente sin exigir apertura", async () => {
    const batch = await db.tx((q: any) =>
      stage(
        q,
        "rechazar.csv",
        "clip_import",
        [],
        [{ row: 2, message: "Datos inválidos" }],
        "reject-http",
      ),
    );
    const key = randomUUID();
    const response = await post(
      "reject-import",
      { id: batch.id, reason: "Archivo equivocado" },
      key,
    );
    expect(response.status).toBe(201);
    expect(response.body.rejected).toBe(true);
    expect(
      (await post("reject-import", { id: batch.id, reason: "Archivo equivocado" }, key)).body,
    ).toEqual(response.body);
    const saved = (await get("/imports/" + batch.id)).body;
    expect(saved.status).toBe("rejected");
    expect(saved.rejection_reason).toBe("Archivo equivocado");
    expect((await post("confirm-import", { id: batch.id })).status).toBe(409);
  });
  it("apertura no afecta ventas ni utilidad y solo se registra una vez", async () => {
    const body = {
      date: "2026-11-01",
      cash: "0",
      bank: "5000",
      clip: "0",
      lines: [{ product_id: product, quantity: "10", unit_cost: "100" }],
    };
    expect((await post("opening", body)).status).toBe(201);
    expect((await post("opening", body)).status).toBe(409);
    const r = await get("/report?from=2026-11-01&to=2026-12-01");
    expect(r.body.sales.value).toBe("0.00");
    expect(r.body.cash.value).toBe("0.00");
    expect(r.body.inventory.value).toBe("1000.00");
  });
  it("cancela un gasto con autenticación, motivo e idempotencia", async () => {
    const e = await post("expense", {
      date: "2026-11-02",
      category: "Otros",
      concept: "Registro equivocado",
      amount: "10",
    });
    expect(e.status).toBe(201);
    expect((await post("cancel-expense", { id: e.body.id, reason: "" })).status).toBe(400);
    const key = randomUUID(),
      body = { id: e.body.id, reason: "Registro capturado por error" };
    const result = await post("cancel-expense", body, key);
    expect(result.status).toBe(201);
    expect(result.body.cancelled).toBe(true);
    expect((await post("cancel-expense", body, key)).body).toEqual(result.body);
    expect((await get("/expenses")).body.find((r: any) => r.id === e.body.id).status).toBe(
      "cancelled",
    );
  });
  it("compra distribuye flete y separa IVA del inventario", async () => {
    const result = await post("purchase", {
      date: "2026-11-02",
      supplier_id: supplier,
      reference: "FACT-1",
      freight: "100",
      tax: "336",
      lines: [{ product_id: product, quantity: "10", unit_cost: "200" }],
    });
    expect(result.status).toBe(201);
    purchase = result.body.id;
    expect(result.body.total_cents).toBe("243600");
    const p = (await get("/products")).body[0];
    expect(p.stock).toBe("20.000000");
    expect(p.value_cents).toBe("310000");
  });
  it("venta valúa por promedio, gasto devenga y pago no cambia utilidad", async () => {
    const result = await post("income", {
      from: "2026-11-03",
      to: "2026-11-04",
      channel: "cash",
      description: "Venta consolidada",
      gross: "1160",
      net: "1000",
      cogs: null,
      fees: "30",
      product_id: product,
      quantity: "5",
      category_id: category,
    });
    expect(result.status).toBe(201);
    income = result.body.id;
    const exp = await post("expense", {
      date: "2026-11-03",
      category: "Renta",
      concept: "Renta del local",
      amount: "100",
      tax: "16",
    });
    expect(exp.status).toBe(201);
    expense = exp.body.id;
    const r = (await get("/report?from=2026-11-01&to=2026-12-01")).body;
    expect(r.cogs.value).toBe("775.00");
    expect(r.gross.value).toBe("225.00");
    expect(r.operating.value).toBe("95.00");
    expect(r.cash.value).toBe("0.00");
    expect(r.inventory.value).toBe("2325.00");
  });
  it("paga parcialmente, cobra y separa efectivo de resultado", async () => {
    for (const body of [
      { kind: "purchase", purchase_id: purchase, amount: "1000" },
      { kind: "expense", expense_id: expense, amount: "116" },
      { kind: "collection", income_id: income, amount: "1160" },
    ])
      expect(
        (
          await post("cash", {
            ...body,
            date: "2026-11-04",
            account_id: "bank",
            notes: "Referencia de prueba",
          })
        ).status,
      ).toBe(201);
    const r = (await get("/report?from=2026-11-01&to=2026-12-01")).body;
    expect(r.cash.value).toBe("44.00");
    expect(r.operating.value).toBe("95.00");
    expect(
      (
        await post("cash", {
          date: "2026-11-04",
          kind: "expense",
          expense_id: expense,
          amount: "1",
          account_id: "bank",
          notes: "Exceso",
        })
      ).status,
    ).toBe(400);
  });
  it("una transferencia interna no crea ingreso ni flujo", async () => {
    expect(
      (
        await post("cash", {
          date: "2026-11-04",
          kind: "transfer",
          amount: "100",
          account_id: "bank",
          destination: "cash",
          notes: "Fondo de caja",
        })
      ).status,
    ).toBe(201);
    const r = (await get("/report?from=2026-11-01&to=2026-12-01")).body;
    expect(r.cash.value).toBe("44.00");
    expect(r.sales.value).toBe("1000.00");
  });
  it("rechaza stock insuficiente y revierte todos los efectos", async () => {
    const before = (await get("/inventory")).body.length;
    expect(
      (
        await post("income", {
          from: "2026-11-05",
          to: "2026-11-06",
          channel: "cash",
          description: "Venta imposible",
          gross: "10",
          net: "10",
          cogs: null,
          fees: "0",
          product_id: product,
          quantity: "1000",
        })
      ).status,
    ).toBe(400);
    expect((await get("/inventory")).body.length).toBe(before);
    expect((await get("/incomes")).body.length).toBe(1);
  });
  it("no prorratea un consolidado al consultar un subperiodo", async () => {
    const r = (await get("/report?from=2026-11-03&to=2026-11-04")).body;
    expect(r.sales.value).toBe("1000.00");
    const conflict = await post("income", {
      from: "2026-11-03",
      to: "2026-11-04",
      channel: "cash",
      description: "Duplicado",
      gross: "10",
      net: "10",
      cogs: "0",
      fees: "0",
    });
    expect(conflict.status).toBe(409);
  });
  it("cierra el mes, bloquea retroactivos y registra reapertura", async () => {
    const checklist = Array(10).fill(true);
    expect((await post("close", { month: "2026-11", checklist })).status).toBe(201);
    expect(
      (
        await post("expense", {
          date: "2026-11-05",
          category: "Renta",
          concept: "Retroactivo",
          amount: "1",
        })
      ).status,
    ).toBe(409);
    expect(
      (await post("reopen", { month: "2026-11", reason: "Revisión documentada" })).status,
    ).toBe(201);
    expect((await get("/audit")).body.some((r: any) => r.action === "reopen")).toBe(true);
  });
  it("Archivos solapados comparten deduplicación, costos faltantes son nulos", async () => {
    const rows = [
      {
        external_id: "clip:abc",
        date: "2026-11-08",
        gross: "116.00",
        net: null,
        cogs: null,
        fees: null,
        method: "Credit",
        status: "active" as const,
        description: "Clip abc",
      },
    ];
    const batch = await db.tx((q: any) => stage(q, "primero.csv", "clip_import", rows, [], "abc"));
    expect((await post("confirm-import", { id: batch.id })).status).toBe(201);
    const next = await db.tx((q: any) => stage(q, "Archivo", "clip_import", rows, [], "def"));
    expect(next.duplicates).toBe(1);
    expect((await post("confirm-import", { id: next.id })).status).toBe(201);
    expect(
      (await get("/incomes")).body.filter((r: any) => r.external_id === "clip:abc"),
    ).toHaveLength(1);
    const r = (await get("/report?from=2026-11-01&to=2026-12-01")).body;
    expect(r.collected.value).toBe("1276.00");
    expect(r.sales.value).toBeNull();
    expect(r.operating.value).toBeNull();
    expect(
      (await post("close", { month: "2026-11", checklist: Array(10).fill(true) })).status,
    ).toBe(400);
  });
  it("exporta CSV consistente y XLSX numérico", async () => {
    const response = await get("/exports/monthly?from=2026-11-01&to=2026-12-01&format=csv");
    expect(response.status).toBe(200);
    expect(response.text).toContain("Importe MXN");
    const x = await get("/exports/monthly?from=2026-11-01&to=2026-12-01&format=xlsx");
    expect(x.status).toBe(200);
    expect(x.headers["content-type"]).toContain("spreadsheetml");
  });
  it("documenta devoluciones con costo original sin borrar la venta", async () => {
    const response = await post("refund", {
      income_id: income,
      date: "2026-11-09",
      gross: "232",
      net: "200",
      cogs: null,
      quantity: "1",
      reason: "Devolución de una unidad",
    });
    expect(response.status).toBe(201);
    const p = (await get("/products")).body.find((r: any) => r.id === product);
    expect(p.stock).toBe("16.000000");
    expect(p.value_cents).toBe("248000");
    expect((await get("/refunds")).body[0].cogs_cents).toBe("15500");
    expect(
      (
        await post("refund", {
          income_id: income,
          date: "2026-11-09",
          gross: "2000",
          net: null,
          cogs: null,
          quantity: "10",
          reason: "Exceso de devolución",
        })
      ).status,
    ).toBe(400);
  });
  it("complementa sin añadir ventas y concilia inventario completo", async () => {
    const imported = (await get("/incomes")).body.find((r: any) => r.external_id === "clip:abc");
    expect(
      (
        await post("complement", {
          id: imported.id,
          net: "100",
          cogs: "155",
          fees: "3",
          category_id: category,
          reason: "Costos e IVA documentados",
        })
      ).status,
    ).toBe(201);
    const result = await post("reconciliation", {
      date: "2026-11-30",
      reason: "Reporte de existencias Clip",
      lines: [{ product_id: product, clip_quantity: "15", unit_cost: "155" }],
    });
    expect(result.status).toBe(201);
    const r = (await get("/report?from=2026-11-01&to=2026-12-01")).body;
    expect(r.sales.value).toBe("900.00");
    expect(r.inventory.status).toBe("completo");
    expect(r.inventory.value).toBe("2325.00");
    expect(
      (await post("close", { month: "2026-11", checklist: Array(10).fill(true) })).status,
    ).toBe(400);
    expect(
      (
        await post("settle-clip", {
          id: imported.id,
          date: "2026-11-10",
          processing_fee: "3",
          financing_withheld: "0",
          creditable_tax: "0",
          deposited: "113",
          reference: "Liquidación documentada de prueba",
        })
      ).status,
    ).toBe(201);
    expect(
      (await post("close", { month: "2026-11", checklist: Array(10).fill(true) })).status,
    ).toBe(201);
    await post("reopen", { month: "2026-11", reason: "Verificación de retroactivos" });
  });
  it("retroactivos revalúan ventas posteriores y exigen reconciliar otra vez", async () => {
    const p = (await post("product", { sku: "REF-1", name: "Refacción", category_id: category }))
      .body.id;
    const buy = (day: string, ref: string, cost: string) =>
      post("purchase", {
        date: day,
        supplier_id: supplier,
        reference: ref,
        lines: [{ product_id: p, quantity: "10", unit_cost: cost }],
      });
    await buy("2026-11-02", "RETRO-1", "100");
    const sale = await post("income", {
      from: "2026-11-05",
      to: "2026-11-06",
      channel: "transfer",
      description: "Venta refacción",
      gross: "464",
      net: "400",
      cogs: null,
      fees: "0",
      product_id: p,
      quantity: "2",
    });
    expect(sale.status).toBe(201);
    await buy("2026-11-03", "RETRO-2", "200");
    const entry = (await get("/incomes")).body.find((r: any) => r.id === sale.body.id);
    expect(entry.cogs_cents).toBe("30000");
    const r = (await get("/report?from=2026-11-01&to=2026-12-01")).body;
    expect(r.inventory.status).toBe("parcial");
  });
  it("RLS impide acceso con autor distinto", async () => {
    await db.tx(async (q: any) => {
      await q.query("select set_config('app.author','otro@ejemplo.com',true)");
      expect((await q.query("select * from products")).rows).toHaveLength(0);
    });
  });
});
describe("Adaptadores de entrada", () => {
  it("preserva IDs con ceros iniciales al leer CSV", async () => {
    const parsed = await fileRows(
      Buffer.from("id,fecha,importe\n000123,2026-11-01,100.00\n"),
      "clip.csv",
    );
    expect(parsed.rows[0]?.id).toBe("000123");
    expect(parsed.rows[0]?.importe).toBe("100.00");
  });
  it("exige estado o confirmación expresa de cobros pagados", () => {
    const result = mapRows([{ id: "abc", date: "2026-11-01", amount: "100" }], {
      external_id: "id",
      date: "date",
      gross: "amount",
    });
    expect(result.errors).toHaveLength(1);
  });

  it("mapea archivos sin inventar impuestos y marca IDs repetidos", () => {
    const result = mapRows(
      [
        { id: "a", fecha: "2026-11-03", monto: "100" },
        { id: "a", fecha: "2026-11-03", monto: "100" },
      ],
      { external_id: "id", date: "fecha", gross: "monto" },
      true,
    );
    expect(result.rows[0]?.net).toBeNull();
    expect(result.errors).toHaveLength(1);
  });
  it("rechaza fórmulas XLSX", async () => {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet("Datos");
    sheet.addRow(["id", "amount"]);
    sheet.addRow(["a", { formula: "1+1", result: 2 }]);
    await expect(fileRows(Buffer.from(await book.xlsx.writeBuffer()), "test.xlsx")).rejects.toThrow(
      "fórmulas",
    );
  });
  it("neutraliza texto ejecutable al exportar CSV", () => {
    expect(csv([{ name: '=HYPERLINK("bad")' }])).toContain("'=HYPERLINK");
  });
});
