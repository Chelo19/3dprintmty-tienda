import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Database } from "../src/db/database";
import { env } from "../src/env";
import { opening, purchase, income } from "../src/modules/store";
import { inventoryCount, openingInventoryValue } from "../src/modules/summary-inventory";
import { report } from "../src/modules/reports";
import { randomUUID } from "node:crypto";
let db: Database, supplier: string;
const period = () => db.tx((q) => report(q, "2025-11-01", "2025-12-01"));
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  delete env.DATABASE_URL;
  db = new Database(true);
  await db.init();
  supplier = randomUUID();
  await db.tx((q) => q.query("insert into suppliers(id,name) values ($1,'Proveedor')", [supplier]));
});
afterAll(async () => db?.close());
describe.sequential("Control financiero sin catálogo", () => {
  it("exige valor inicial explícito y abre sin crear productos ficticios", async () => {
    await expect(
      db.tx((q) =>
        opening(q, {
          date: "2025-11-01",
          cash: "0",
          bank: "5000",
          clip: "0",
          inventory_mode: "summary",
          lines: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "opening_inventory" });
    await db.tx((q) =>
      opening(q, {
        date: "2025-11-01",
        cash: "0",
        bank: "5000",
        clip: "0",
        inventory_mode: "summary",
        inventory_value: "1000",
        lines: [],
      }),
    );
    expect(
      (
        await db.tx(
          async (q) => (await q.query("select count(*)::int as n from products")).rows[0]!,
        )
      ).n,
    ).toBe(0);
  });
  it("registra compras por totales, separa IVA y no las trata como costo vendido inmediato", async () => {
    const body = {
      date: "2025-11-05",
      supplier_id: supplier,
      reference: "COMPRA-1",
      merchandise: "500",
      freight: "100",
      nonrecoverable_tax: "20",
      tax: "80",
      lines: [],
    };
    const p = await db.tx((q) => purchase(q, body));
    expect(p.total_cents).toBe("70000");
    await expect(db.tx((q) => purchase(q, body))).rejects.toMatchObject({ code: "23505" });
    const r = await period();
    expect(r.cogs.value).toBeNull();
    expect(r.operating.value).toBeNull();
    expect(r.inventory.value).toBe("1000.00");
    expect(r.inventory.status).toBe("parcial");
    const detail = await db.tx(async (q) => (await q.query("select * from purchases")).rows[0]!);
    expect(detail.summary_cost_cents).toBe("62000");
  });
  it("usa inicial más compras menos final una sola vez y no exige costos por venta ni SKU", async () => {
    await db.tx((q) =>
      income(q, {
        from: "2025-11-10",
        to: "2025-11-11",
        channel: "cash",
        description: "Ventas del día",
        gross: "1160",
        net: "1000",
        cogs: "999",
        fees: "0",
        method: "cash",
      }),
    );
    await db.tx((q) =>
      inventoryCount(q, { date: "2025-11-30", value: "900", reason: "Conteo mensual documentado" }),
    );
    const r = await period();
    expect(r.cogs.value).toBe("720.00");
    expect(r.gross.value).toBe("280.00");
    expect(r.operating.value).toBe("280.00");
    expect(r.inventory.status).toBe("completo");
    expect(r.warnings).toEqual([]);
    expect(r.months[0]?.operating).toBe("280.00");
    expect(r.cash.value).toBe("0.00");
  });
  it("no prorratea cortes faltantes y registra correcciones sin duplicarlas", async () => {
    const partial = await db.tx((q) => report(q, "2025-11-15", "2025-12-01"));
    expect(partial.cogs.value).toBeNull();
    expect(partial.operating.value).toBeNull();
    await db.tx((q) =>
      inventoryCount(q, {
        date: "2025-11-30",
        value: "920",
        reason: "Corrección de conteo con respaldo",
      }),
    );
    expect((await period()).cogs.value).toBe("700.00");
    const counts = await db.tx(
      async (q) => (await q.query("select count(*)::int as n from inventory_counts")).rows[0]!,
    );
    expect(counts.n).toBe(1);
  });
  it("permite completar el valor inicial faltante de una apertura existente, con auditoría", async () => {
    await db.tx((q) => q.query("update settings set opening_inventory_cents=null"));
    expect((await period()).cogs.value).toBeNull();
    await db.tx((q) =>
      openingInventoryValue(q, { value: "1000", reason: "Inventario inicial según reporte" }),
    );
    expect((await period()).cogs.value).toBe("700.00");
    const audit = await db.tx(
      async (q) =>
        (await q.query("select * from audit_events where action='inventory-value'")).rows,
    );
    expect(audit).toHaveLength(1);
    await expect(
      db.tx((q) =>
        inventoryCount(q, { date: "2999-01-01", value: "1", reason: "Fecha futura inválida" }),
      ),
    ).rejects.toMatchObject({ code: "future_inventory" });
  });
  it("no presenta costos negativos como utilidad e impide cambiar cortes que afecten cierres", async () => {
    await db.tx((q) =>
      inventoryCount(q, {
        date: "2025-11-30",
        value: "2000",
        reason: "Conteo pendiente de verificar",
      }),
    );
    const r = await period();
    expect(r.cogs.value).toBeNull();
    expect(r.warnings.join(" ")).toContain("excede");
    await db.tx((q) =>
      q.query(
        "insert into monthly_closes(id,month,status,snapshot,checklist) values ($1,'2025-12','closed','{}','[]')",
        [randomUUID()],
      ),
    );
    await expect(
      db.tx((q) =>
        inventoryCount(q, {
          date: "2025-11-30",
          value: "900",
          reason: "Corrección después de cierre",
        }),
      ),
    ).rejects.toMatchObject({ code: "month_closed" });
  });
  it("conserva RLS privado en los cortes", async () => {
    await expect(
      db.tx(async (q) => {
        await q.query("select set_config('app.author','otro@example.com',true)");
        return q.query(
          "insert into inventory_counts(id,date,value_cents,reason) values ($1,'2025-12-31',0,'Intento sin autorización')",
          [randomUUID()],
        );
      }),
    ).rejects.toMatchObject({ code: "42501" });
  });
});
