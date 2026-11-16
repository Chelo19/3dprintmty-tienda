import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
let app: any, db: any, token: string, income: string;
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
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  ({ app, db } = await createApp(true));
  token = (await request(app.getHttpServer()).post("/api/v1/auth/local")).body.token;
});
afterAll(async () => app?.close());
describe.sequential("Finanzas sin registro de productos ni inventario", () => {
  it("permite apertura únicamente con saldos de dinero", async () => {
    expect(
      (
        await post("opening", {
          date: "2025-11-01",
          cash: "0",
          bank: "10000",
          clip: "0",
          inventory_mode: "external",
          lines: [],
        })
      ).status,
    ).toBe(201);
    const settings = (await get("/settings")).body;
    expect(settings.inventory_mode).toBe("external");
    expect(settings.opening_inventory_cents).toBeNull();
  });
  it("retira los endpoints de productos, existencias y ajustes", async () => {
    for (const resource of ["products", "inventory", "inventory-counts", "reconciliations"])
      expect((await get("/" + resource)).status).toBe(404);
    for (const action of [
      "product",
      "product-update",
      "adjustment",
      "inventory-count",
      "opening-inventory-value",
      "reconciliation",
    ])
      expect((await post(action, {})).status).toBe(404);
    expect((await get("/exports/inventory?from=2025-11-01&to=2025-12-01&format=csv")).status).toBe(
      404,
    );
  });
  it("conserva compras por importe sin convertirlas en costo de lo vendido", async () => {
    const s = await post("supplier", { name: "Proveedor sin catálogo" });
    const p = await post("purchase", {
      date: "2025-11-05",
      supplier_id: s.body.id,
      reference: "EXT-1",
      merchandise: "1000",
    });
    expect(p.status).toBe(201);
    const i = await post("income", {
      from: "2025-11-06",
      to: "2025-11-07",
      channel: "cash",
      description: "Ventas sin desglose",
      gross: "1160",
      net: "1000",
      cogs: null,
      fees: "0",
    });
    expect(i.status).toBe(201);
    income = i.body.id;
    const r = (await get("/report?from=2025-11-01&to=2025-12-01")).body;
    expect(r.collected.value).toBe("1160.00");
    expect(r.cogs.value).toBeNull();
    expect(r.operating.value).toBeNull();
    expect(r.inventoryMode).toBe("external");
    expect(r.inventory.value).toBeNull();
    expect(r.warnings.join(" ")).not.toMatch(/inventario|SKU|unidades/i);
    const stock = await db.tx(
      async (q: any) =>
        (await q.query("select count(*)::int as n from inventory_movements")).rows[0],
    );
    expect(stock.n).toBe(0);
  });
  it("permite documentar costos externos sin existencias ni doble descuento de compras", async () => {
    expect(
      (
        await post("complement", {
          id: income,
          net: "1000",
          cogs: "400",
          fees: "0",
          category_id: null,
          reason: "Costo documentado con respaldo externo",
        })
      ).status,
    ).toBe(201);
    const r = (await get("/report?from=2025-11-01&to=2025-12-01")).body;
    expect(r.cogs.value).toBe("400.00");
    expect(r.operating.value).toBe("600.00");
    expect(r.warnings).toEqual([]);
    const exported = await get("/exports/monthly?from=2025-11-01&to=2025-12-01&format=csv");
    expect(exported.status).toBe(200);
    expect(exported.text).not.toContain("Inventario final");
  });
  it("permite varias compras sin referencia del mismo proveedor y protege referencias capturadas", async () => {
    const supplier = await post("supplier", { name: "Proveedor sin factura" });
    const body = {
      date: "2025-11-12",
      supplier_id: supplier.body.id,
      merchandise: "100",
      lines: [],
    };
    const first = await post("purchase", body);
    const second = await post("purchase", { ...body, reference: "   " });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(first.body.id).not.toBe(second.body.id);
    expect(
      (await get("/purchases")).body
        .filter((r: any) => r.supplier_id === supplier.body.id)
        .map((r: any) => r.reference),
    ).toEqual(["", ""]);
    const named = await post("purchase", { ...body, reference: "  FAC-123  " });
    expect(named.status).toBe(201);
    expect((await post("purchase", { ...body, reference: "FAC-123" })).status).toBe(409);
  });
});
