import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Database } from "../src/db/database";
import { env } from "../src/env";
import { clipReportRows, isClipReport } from "../src/modules/clip-csv";
import { stage, confirm, fileRows, reject, preview } from "../src/modules/imports";
import type { Row } from "@tienda/shared";
let db: Database;
const row = (n: string, extra: Row = {}) => ({
  Date: "2026-11-10 00:15",
  "Transaction ID": "tx-" + n,
  "Payment ID": "pay-" + n,
  "Receipt No": "receipt-" + n,
  "Payment Status": "approved",
  "Payment Currency": "MXN",
  "Paid Amount": "116.00",
  "Payment Method Type": "cash",
  "Net Amount": "116.00",
  "Refunded Amount": "0",
  ...extra,
});
const load = (data: Row[], hash: string) => {
  const mapped = clipReportRows(data);
  return db.tx((q) => stage(q, hash + ".csv", "clip_import", mapped.rows, mapped.errors, hash));
};
const count = () =>
  db.tx(
    async (q) =>
      (await q.query("select count(*)::int as n,sum(gross_cents)::text as gross from incomes"))
        .rows[0]!,
  );
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  db = new Database(true);
  await db.init();
  await db.tx((q) => q.query("update settings set opening_done=true,opening_date='2026-11-01'"));
});
afterAll(async () => db?.close());
describe.sequential("Importación Clip sin duplicados", () => {
  it("reconoce CSV con BOM, mantiene medianoche local y no confunde Net Amount con venta sin IVA", async () => {
    const data = row("a");
    const content =
      "\ufeff" + Object.keys(data).join(",") + "\r\n" + Object.values(data).join(",") + "\r\n";
    const file = await fileRows(Buffer.from(content), "clip.csv");
    expect(isClipReport(file.headers)).toBe(true);
    const mapped = clipReportRows(file.rows);
    expect(mapped.errors).toEqual([]);
    expect(mapped.rows[0]!).toMatchObject({
      date: "2026-11-10",
      net: null,
      fees: null,
      gross: "116.00",
      method: "cash",
    });
  });
  it("consolida filas idénticas y guarda efectivo en su canal", async () => {
    const b = await load([row("a"), row("a")], "one");
    expect(b.rows).toHaveLength(1);
    expect(b.new_count).toBe(1);
    await db.tx((q) => confirm(q, b.id));
    expect(await count()).toEqual({ n: 1, gross: "11600" });
    const income = await db.tx(async (q) => (await q.query("select * from incomes")).rows[0]!);
    expect(income.channel).toBe("cash");
    expect(income.clip_payment_id).toBe("pay-a");
  });
  it("otro nombre, orden y periodo solapado no vuelven a sumar; importes iguales con IDs distintos sí", async () => {
    const b = await load([row("b"), row("a")], "overlap");
    expect(b.new_count).toBe(1);
    expect(b.duplicates).toBe(1);
    await db.tx((q) => confirm(q, b.id));
    const replay = await load([row("a"), row("b")], "renamed");
    expect(replay.unchanged_count).toBe(2);
    await db.tx((q) => confirm(q, replay.id));
    await db.tx((q) => confirm(q, replay.id));
    expect(await count()).toEqual({ n: 2, gross: "23200" });
  });
  it("mantiene costos documentados al importar otro archivo", async () => {
    const api = clipReportRows([row("c", { "Payment Method Type": "card" })]).rows[0]!;
    api.net = "100";
    api.cogs = "50";
    const first = await db.tx((q) =>
      stage(q, "complementado.csv", "clip_import", [api], [], "documented"),
    );
    await db.tx((q) => confirm(q, first.id));
    const b = await load([row("c", { "Payment Method Type": "card" })], "cross-source");
    expect(b.duplicates).toBe(1);
    await db.tx((q) => confirm(q, b.id));
    const record = await db.tx(
      async (q) =>
        (await q.query("select * from incomes where clip_transaction_id='tx-c'")).rows[0]!,
    );
    expect(record.net_cents).toBe("10000");
    expect(record.cogs_cents).toBe("5000");
    expect((await count()).n).toBe(3);
  });
  it("un identificador alterno reconoce exportaciones sin folio y conserva el ingreso original", async () => {
    const b = await load([row("a", { "Receipt No": "", "Paid Amount": "120.00" })], "alternative");
    expect(b.changed_count).toBe(1);
    expect(b.duplicates).toBe(1);
    await db.tx((q) => confirm(q, b.id));
    expect((await count()).n).toBe(3);
  });
  it("bloquea conflictos de identidad y filas con estados, importes o devoluciones pendientes", async () => {
    const conflict = await load([row("a", { "Receipt No": "receipt-b" })], "conflict");
    expect(conflict.errors.length).toBeGreaterThan(0);
    await expect(db.tx((q) => confirm(q, conflict.id))).rejects.toThrow("Corrige");
    const internal = await load([row("z"), row("z", { "Paid Amount": "200" })], "conflicting-file");
    expect(internal.errors.length).toBeGreaterThan(0);
    for (const extra of [
      { "Paid Amount": "-1" },
      { "Refunded Amount": "1" },
      { "Payment Status": "pending" },
      { Date: "2026-02-30 14:00" },
      { "Payment Currency": "USD" },
    ])
      expect(clipReportRows([row("invalid", extra)]).errors).toHaveLength(1);
    expect((await count()).n).toBe(3);
  });
  it("reconoce importaciones anteriores cuyo identificador era el ID de transacción", async () => {
    const mapped = clipReportRows([row("legacy")]).rows[0]!;
    const { clip_transaction_id, clip_payment_id, clip_receipt_no, ...old } = mapped;
    const first = await db.tx((q) =>
      stage(
        q,
        "anterior.csv",
        "clip_import",
        [{ ...old, external_id: "clip:tx-legacy" }],
        [],
        "legacy-old",
      ),
    );
    await db.tx((q) => confirm(q, first.id));
    const before = (await count()).n;
    const next = await load([row("legacy")], "legacy-new");
    expect(next.duplicates).toBe(1);
    await db.tx((q) => confirm(q, next.id));
    expect((await count()).n).toBe(before);
    const record = await db.tx(
      async (q) =>
        (await q.query("select * from incomes where external_id='clip:tx-legacy'")).rows[0]!,
    );
    expect(record.external_id).toBe("clip:tx-legacy");
    expect(record.clip_receipt_no).toBeNull();
  });
  it("una restricción de PostgreSQL rechaza identidades repetidas aunque se omita el importador", async () => {
    await expect(
      db.tx((q) =>
        q.query("update incomes set clip_payment_id='pay-a' where clip_transaction_id='tx-b'"),
      ),
    ).rejects.toMatchObject({ code: "23505" });
    expect((await count()).n).toBe(4);
  });
  it("dos confirmaciones concurrentes de archivos solapados conservan una sola transacción", async () => {
    const a = await load([row("parallel")], "parallel1"),
      b = await load([row("parallel")], "parallel2");
    await Promise.all([db.tx((q) => confirm(q, a.id)), db.tx((q) => confirm(q, b.id))]);
    expect((await count()).n).toBe(5);
  });
  it("limpiar el historial conserva ingresos e identificadores y no permite duplicar al recargar", async () => {
    const before = await count();
    await db.lite!.exec(
      "begin; update incomes set import_id=null where import_id is not null; delete from imports; commit;",
    );
    expect(await count()).toEqual(before);
    const batch = await load([row("b")], "after-history-cleanup");
    expect(batch.new_count).toBe(0);
    expect(batch.duplicates).toBe(1);
    await db.tx((q) => confirm(q, batch.id));
    expect(await count()).toEqual(before);
  });
  it("rechaza lotes con errores sin crear ingresos y conserva motivo y auditoría", async () => {
    const before = await count();
    const b = await load([row("reject", { "Payment Status": "pending" })], "reject-errors");
    await db.tx((q) => reject(q, b.id, "El periodo no corresponde"));
    const rejected = await db.tx((q) => preview(q, b.id));
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejected_at).toBeTruthy();
    expect(rejected.rejection_reason).toBe("El periodo no corresponde");
    expect(await db.tx((q) => reject(q, b.id, "Otro motivo"))).toMatchObject({
      already_rejected: true,
    });
    const events = await db.tx(
      async (q) =>
        (await q.query("select * from audit_events where entity_id=$1 and action='reject'", [b.id]))
          .rows,
    );
    expect(events).toHaveLength(1);
    await expect(db.tx((q) => confirm(q, b.id))).rejects.toMatchObject({ code: "import_rejected" });
    expect(await count()).toEqual(before);
  });
  it("permite volver a cargar un archivo rechazado sin perder su historial y protege los confirmados", async () => {
    const a = await load([row("retry-rejected")], "same-file");
    await db.tx((q) => reject(q, a.id));
    const b = await load([row("retry-rejected")], "same-file");
    expect(b.id).not.toBe(a.id);
    expect(b.status).toBe("preview");
    expect((await db.tx((q) => preview(q, a.id))).status).toBe("rejected");
    const before = (await count()).n;
    await db.tx((q) => confirm(q, b.id));
    await expect(db.tx((q) => reject(q, b.id))).rejects.toMatchObject({ code: "import_confirmed" });
    expect((await count()).n).toBe(before + 1);
    const replay = await load([row("retry-rejected")], "same-file");
    expect(replay.id).toBe(b.id);
  });
  it("confirmar y rechazar simultáneamente no puede aplicar ambas decisiones", async () => {
    const b = await load([row("race-reject")], "race-reject");
    const before = await count();
    const [rejection, confirmation] = await Promise.allSettled([
      db.tx((q) => reject(q, b.id)),
      db.tx((q) => confirm(q, b.id)),
    ]);
    expect(rejection.status).toBe("fulfilled");
    expect(confirmation.status).toBe("rejected");
    expect(await count()).toEqual(before);
    const c = await load([row("race-confirm")], "race-confirm");
    const [confirmed, rejected] = await Promise.allSettled([
      db.tx((q) => confirm(q, c.id)),
      db.tx((q) => reject(q, c.id)),
    ]);
    expect(confirmed.status).toBe("fulfilled");
    expect(rejected.status).toBe("rejected");
    expect((await db.tx((q) => preview(q, c.id))).status).toBe("confirmed");
  });
});

it("exige decidir todos los estatus distintos de approved y conserva la validación financiera", () => {
  const data = [
    row("ok"),
    row("p", { "Payment Status": " Pending " }),
    row("cancel", { "Payment Status": "cancelled" }),
  ];
  expect(clipReportRows(data).errors).toHaveLength(2);
  const mapped = clipReportRows(data, { pending: "include", cancelled: "exclude" });
  expect(mapped.errors).toEqual([]);
  expect(mapped.rows.map((r) => r.external_id)).toEqual(["clip:receipt-ok", "clip:receipt-p"]);
  expect(mapped.rows[1]).toMatchObject({ status: "active", clip_status: "pending" });
  expect(clipReportRows(data, { pending: "exclude", cancelled: "include" }).rows[1]).toMatchObject({
    status: "cancelled",
    clip_status: "cancelled",
  });
  expect(
    clipReportRows([row("refund", { "Payment Status": "refunded", "Refunded Amount": "116" })], {
      refunded: "include",
    }).errors,
  ).toHaveLength(1);
  expect(
    clipReportRows([row("invalid", { "Payment Status": "pending", "Paid Amount": "-1" })], {
      pending: "include",
    }).errors,
  ).toHaveLength(1);
  expect(
    clipReportRows([row("empty", { "Payment Status": "" })], { "": "exclude" }).rows,
  ).toHaveLength(0);
});
