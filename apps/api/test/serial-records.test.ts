import { beforeAll, afterAll, describe, it, expect } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/main";
import { env } from "../src/env";
let app: any, db: any, token: string, recordId: string;
const record = {
  equipment: "Bambu Lab X2D",
  serial_number: "X2D-001",
  customer_name: "Cliente de prueba",
  customer_phone: "+52 81 1234 5678",
  customer_email: "cliente@example.com",
  date: "2026-11-23",
  warranty_months: 12,
  sale_date: "2026-11-23",
  invoice_date: "2026-11-24",
};
const post = (action: string, body: any, key = randomUUID()) =>
  request(app.getHttpServer())
    .post("/api/v1/actions/" + action)
    .set("Authorization", "Bearer " + token)
    .set("Idempotency-Key", key)
    .send(body);
const get = () =>
  request(app.getHttpServer())
    .get("/api/v1/serial-records")
    .set("Authorization", "Bearer " + token);
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  ({ app, db } = await createApp(true));
  token = (await request(app.getHttpServer()).post("/api/v1/auth/local")).body.token;
});
afterAll(async () => app?.close());
describe.sequential("Registro privado de números de serie", () => {
  it("registra los seis campos sin requerir apertura financiera ni crear movimientos", async () => {
    const result = await post("serial-record", {
      ...record,
      equipment: "  " + record.equipment + "  ",
    });
    expect(result.status).toBe(201);
    recordId = result.body.id;
    expect((await get()).body).toEqual([expect.objectContaining({ ...record, id: recordId })]);
    const finance = await db.tx(
      async (q: any) =>
        (
          await q.query(
            "select (select count(*)::int from incomes) as incomes,(select count(*)::int from purchases) as purchases,(select count(*)::int from cash_movements) as cash",
          )
        ).rows[0],
    );
    expect(finance).toEqual({ incomes: 0, purchases: 0, cash: 0 });
  });
  it("rechaza duplicados sin distinguir mayúsculas y espacios exteriores", async () => {
    const result = await post("serial-record", { ...record, serial_number: "  x2d-001  " });
    expect(result.status).toBe(409);
    expect(result.body.message).toBe("Este número de serie ya está registrado.");
    expect((await get()).body).toHaveLength(1);
  });
  it("dos capturas simultáneas conservan un único número de serie y una repetición con la misma llave no duplica", async () => {
    const body = { ...record, serial_number: "A1-002" };
    const result = await Promise.all([post("serial-record", body), post("serial-record", body)]);
    expect(result.map((r) => r.status).sort()).toEqual([201, 409]);
    const key = randomUUID(),
      requestBody = { ...record, serial_number: "A1-003" };
    const first = await post("serial-record", requestBody, key),
      second = await post("serial-record", requestBody, key);
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect((await get()).body.filter((r: any) => r.serial_number === "A1-003")).toHaveLength(1);
  });
  it("edita el mismo registro con auditoría y protege los números de serie de los demás", async () => {
    const revised = {
      ...record,
      customer_phone: "8187654321",
      customer_email: "nuevo@example.com",
    };
    expect((await post("serial-record-update", { ...revised, id: recordId })).status).toBe(201);
    expect((await get()).body.find((r: any) => r.id === recordId)).toMatchObject(revised);
    expect(
      (await post("serial-record-update", { ...revised, id: recordId, serial_number: "a1-002" }))
        .status,
    ).toBe(409);
    const events = await db.tx(
      async (q: any) =>
        (
          await q.query(
            "select action,data from audit_events where entity='serial_record' and entity_id=$1 order by created_at",
            [recordId],
          )
        ).rows,
    );
    expect(events.map((r: any) => r.action)).toEqual(["create", "update"]);
    expect(events[1].data.before.customer_email).toBe(record.customer_email);
    expect(events[1].data.after.customer_email).toBe(revised.customer_email);
  });
  it("valida fecha y datos obligatorios, no acepta campos extra y exige un registro existente", async () => {
    for (const extra of [
      { date: "2026-02-30" },
      { serial_number: "   " },
      { customer_name: "" },
      { customer_email: "correo-invalido" },
      { customer_phone: "" },
      { gross: "1" },
    ])
      expect(
        (await post("serial-record", { ...record, serial_number: "INVALID", ...extra })).status,
      ).toBe(400);
    expect((await post("serial-record-update", { ...record, id: randomUUID() })).status).toBe(404);
    expect((await get()).body).toHaveLength(3);
  });
  it("requiere acceso privado y aplica la política de protección de datos del propietario", async () => {
    expect((await request(app.getHttpServer()).get("/api/v1/serial-records")).status).toBe(401);
    await db.tx(async (q: any) => {
      await q.query("select set_config('app.author','otra-persona@example.com',true)");
      expect((await q.query("select * from serial_records")).rows).toEqual([]);
    });
  });
  it("da de alta una impresora sin cliente y registra venta y factura por separado, iniciando garantía solo al facturar", async () => {
    const printer = {
      equipment: "Bambu Lab P2S",
      serial_number: "STOCK-001",
      date: "2026-11-23",
      warranty_months: 6,
    };
    const created = await post("serial-record", printer);
    expect(created.status).toBe(201);
    let saved = (await get()).body.find((r: any) => r.id === created.body.id);
    expect(saved).toMatchObject({
      customer_name: null,
      customer_phone: null,
      customer_email: null,
      sale_date: null,
      invoice_date: null,
      warranty_end: null,
      warranty_status: "Sin asignar",
      warranty_months: 6,
    });
    const assignment = {
      id: created.body.id,
      customer_name: "Cliente asignado",
      customer_phone: "8111223344",
      customer_email: "asignado@example.com",
      sale_date: "2026-11-25",
    };
    expect((await post("serial-record-assign", assignment)).status).toBe(201);
    saved = (await get()).body.find((r: any) => r.id === created.body.id);
    expect(saved).toMatchObject({
      ...printer,
      customer_name: assignment.customer_name,
      sale_date: "2026-11-25",
      invoice_date: null,
      warranty_end: null,
      warranty_status: "Pendiente de facturar",
    });
    expect((await post("serial-record-assign", assignment)).body.already_assigned).toBe(true);
    expect(
      (await post("serial-record-assign", { ...assignment, customer_name: "Otro cliente" })).status,
    ).toBe(409);
    expect(
      (await post("serial-record-invoice", { id: created.body.id, invoice_date: "2026-11-30" }))
        .status,
    ).toBe(201);
    expect((await get()).body.find((r: any) => r.id === created.body.id)).toMatchObject({
      date: "2026-11-23",
      sale_date: "2026-11-25",
      invoice_date: "2026-11-30",
      warranty_end: "2027-05-30",
    });
    expect(
      (await post("serial-record-invoice", { id: created.body.id, invoice_date: "2026-11-30" }))
        .body.already_recorded,
    ).toBe(true);
    expect(
      (await post("serial-record-invoice", { id: created.body.id, invoice_date: "2026-12-01" }))
        .status,
    ).toBe(409);
    // Editing printer metadata never clears an existing assignment.
    expect(
      (
        await post("serial-record-update", {
          ...printer,
          id: created.body.id,
          equipment: "P2S corregida",
        })
      ).status,
    ).toBe(201);
    expect((await get()).body.find((r: any) => r.id === created.body.id).customer_name).toBe(
      assignment.customer_name,
    );
  });
  it("exige vigencia válida y datos de asignación completos, también al omitir la API", async () => {
    const printer = {
      equipment: "A1",
      serial_number: "INVALID-WARRANTY",
      date: "2026-11-23",
      warranty_months: 12,
    };
    for (const months of [0, -1, 1.5, 121])
      expect((await post("serial-record", { ...printer, warranty_months: months })).status).toBe(
        400,
      );
    expect(
      (await post("serial-record", { ...printer, customer_name: "Asignación incompleta" })).status,
    ).toBe(400);
    await expect(
      db.tx((q: any) =>
        q.query(
          "insert into serial_records(id,equipment,serial_number,date,warranty_months,customer_name) values ($1,'A1','PARTIAL','2026-11-23',12,'Incompleto')",
          [randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("conserva los registros anteriores sin inventar una vigencia y permite completarla", async () => {
    const legacyId = randomUUID();
    await db.tx((q: any) =>
      q.query(
        "insert into serial_records(id,equipment,serial_number,date,customer_name,customer_phone,customer_email,warranty_start,sale_date) values ($1,'X1','LEGACY','2026-01-31','Cliente previo','8112345678','previo@example.com','2026-01-31','2026-01-31')",
        [legacyId],
      ),
    );
    const before = (await get()).body.find((r: any) => r.id === legacyId);
    expect(before).toMatchObject({
      warranty_months: null,
      warranty_status: "Pendiente de facturar",
      warranty_end: null,
    });
    expect(
      (
        await post("serial-record-update", {
          id: legacyId,
          equipment: "X1",
          serial_number: "LEGACY",
          date: "2026-01-31",
          warranty_months: 1,
        })
      ).status,
    ).toBe(201);
    expect((await get()).body.find((r: any) => r.id === legacyId)).toMatchObject({
      customer_name: "Cliente previo",
      sale_date: "2026-01-31",
      invoice_date: null,
      warranty_end: null,
      warranty_months: 1,
    });
    expect(
      (await post("serial-record-invoice", { id: legacyId, invoice_date: "2026-02-02" })).status,
    ).toBe(201);
    expect((await get()).body.find((r: any) => r.id === legacyId)).toMatchObject({
      date: "2026-01-31",
      sale_date: "2026-01-31",
      warranty_start: "2026-01-31",
      invoice_date: "2026-02-02",
      warranty_end: "2026-03-02",
    });
  });
  it("distingue No se va a facturar de pendiente, conserva la opción y calcula la garantía desde venta", async () => {
    const printer = {
      equipment: "A1 Mini",
      serial_number: "NO-FACT-001",
      date: "2026-11-23",
      warranty_months: 12,
      will_invoice: false,
    };
    const created = await post("serial-record", printer);
    expect(created.status).toBe(201);
    const id = created.body.id;
    const find = async () => (await get()).body.find((r: any) => r.id === id);
    expect(await find()).toMatchObject({
      will_invoice: false,
      billing_status: "No se facturará",
      warranty_status: "Sin asignar",
      warranty_end: null,
    });
    expect(
      (
        await post("serial-record-assign", {
          id,
          customer_name: "Cliente sin factura",
          customer_phone: "8112345678",
          customer_email: "cliente@example.com",
          sale_date: "2026-11-25",
        })
      ).status,
    ).toBe(201);
    expect(await find()).toMatchObject({
      will_invoice: false,
      invoice_date: null,
      sale_date: "2026-11-25",
      warranty_end: "2027-11-25",
      billing_status: "No se facturará",
    });
    const { will_invoice, ...metadata } = printer;
    expect((await post("serial-record-update", { ...metadata, id })).status).toBe(201);
    expect((await find()).will_invoice).toBe(false);
    expect((await post("serial-record-invoice", { id, invoice_date: "2026-11-30" })).status).toBe(
      409,
    );
    expect(
      (await post("serial-record-update", { ...metadata, id, invoice_date: "2026-11-30" })).status,
    ).toBe(400);
    expect(
      (await post("serial-record-update", { ...metadata, id, will_invoice: true })).status,
    ).toBe(201);
    expect(await find()).toMatchObject({
      will_invoice: true,
      warranty_end: null,
      warranty_status: "Pendiente de facturar",
    });
    expect((await post("serial-record-invoice", { id, invoice_date: "2026-11-30" })).status).toBe(
      201,
    );
    expect(await find()).toMatchObject({ invoice_date: "2026-11-30", warranty_end: "2027-11-30" });
  });
  it("no borra una fecha de factura existente al cambiar la opción y la base de datos impide estados contradictorios", async () => {
    const body = { ...record, id: recordId, will_invoice: false };
    expect((await post("serial-record-update", body)).status).toBe(400);
    expect((await get()).body.find((r: any) => r.id === recordId)).toMatchObject({
      invoice_date: record.invoice_date,
      will_invoice: true,
    });
    await expect(
      db.tx((q: any) =>
        q.query("update serial_records set will_invoice=false where id=$1", [recordId]),
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });
  it("guarda, conserva y corrige el folio sin alterar las fechas ni permitir folios sin factura", async () => {
    const created = await post("serial-record", {
      ...record,
      serial_number: "FOLIO-001",
      invoice_folio: "  F-123  ",
    });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const find = async () => (await get()).body.find((r: any) => r.id === id);
    expect(await find()).toMatchObject({
      invoice_folio: "F-123",
      invoice_date: record.invoice_date,
    });
    expect(
      (await post("serial-record-update", { ...record, id, serial_number: "FOLIO-001" })).status,
    ).toBe(201);
    expect((await find()).invoice_folio).toBe("F-123");
    expect(
      (
        await post("serial-record-update", {
          ...record,
          id,
          serial_number: "FOLIO-001",
          invoice_folio: "F-124",
        })
      ).status,
    ).toBe(201);
    expect(await find()).toMatchObject({
      invoice_folio: "F-124",
      sale_date: record.sale_date,
      invoice_date: record.invoice_date,
    });
    expect(
      (
        await post("serial-record-update", {
          ...record,
          id,
          serial_number: "FOLIO-001",
          invoice_date: null,
        })
      ).status,
    ).toBe(400);
    await expect(
      db.tx((q: any) => q.query("update serial_records set invoice_date=null where id=$1", [id])),
    ).rejects.toMatchObject({ code: "23514" });
    for (const invoice_folio of ["", " ", "x".repeat(121)])
      expect(
        (await post("serial-record", { ...record, serial_number: "INVALID-FOLIO", invoice_folio }))
          .status,
      ).toBe(400);
    expect(
      (
        await post("serial-record-update", {
          ...record,
          id,
          serial_number: "FOLIO-001",
          invoice_date: null,
          invoice_folio: null,
          will_invoice: false,
        })
      ).status,
    ).toBe(201);
    expect(await find()).toMatchObject({
      invoice_date: null,
      invoice_folio: null,
      will_invoice: false,
    });
    const pending = await post("serial-record", {
      ...record,
      serial_number: "FOLIO-002",
      invoice_date: null,
    });
    const invoice = { id: pending.body.id, invoice_date: "2026-11-30", invoice_folio: "FAC-002" };
    expect((await post("serial-record-invoice", invoice)).status).toBe(201);
    expect((await post("serial-record-invoice", invoice)).body.already_recorded).toBe(true);
    expect(
      (await post("serial-record-invoice", { ...invoice, invoice_folio: "OTHER" })).status,
    ).toBe(409);
    expect((await get()).body.find((r: any) => r.id === pending.body.id)).toMatchObject(invoice);
    const stock = await post("serial-record", {
      equipment: "A1",
      serial_number: "FOLIO-003",
      date: record.date,
      warranty_months: 12,
    });
    expect(
      (
        await post("serial-record-assign", {
          id: stock.body.id,
          customer_name: record.customer_name,
          customer_phone: record.customer_phone,
          customer_email: record.customer_email,
          sale_date: record.sale_date,
          invoice_date: record.invoice_date,
          invoice_folio: "ASSIGN-1",
        })
      ).status,
    ).toBe(201);
    expect((await get()).body.find((r: any) => r.id === stock.body.id).invoice_folio).toBe(
      "ASSIGN-1",
    );
  });
});
