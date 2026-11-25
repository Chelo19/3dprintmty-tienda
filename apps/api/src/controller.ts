import {
  saveMonthlyCost,
  saveTaxInputs,
  saveTaxDocument,
  taxDocuments,
  enableFiscalProfile,
} from "./modules/tax";
import { settleClip } from "./modules/clip-settlement";
import { cancelDocument } from "./modules/cancellations";
import { inventoryCount, openingInventoryValue } from "./modules/summary-inventory";
import { isClipReport, clipReportRows } from "./modules/clip-csv";
import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query as QueryParam,
  Headers,
  Req,
  Res,
  UploadedFile,
  UseInterceptors,
} from "@nestjs/common";
import { FileInterceptor } from "@nestjs/platform-express";
import type { Response } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { AppError, type Row } from "@tienda/shared";
import { cents, monthBounds, major } from "@tienda/domain";
import { Database, audit, idempotent, unlocked } from "./db/database";
import { applyCardFees } from "./modules/card-fees";
import { env } from "./env";
import { localMode, localToken } from "./http/auth";
import { date, money, uuid, productInput, supplierInput } from "./modules/validation";
import * as store from "./modules/store";
import {
  createSerialRecord,
  updateSerialRecord,
  assignSerialRecord,
  invoiceSerialRecord,
} from "./modules/serial-records";
import { report, reportRows, csv } from "./modules/reports";
import { fileRows, mapRows, stage, preview, confirm, reject, hash } from "./modules/imports";
import ExcelJS from "exceljs";
import { backupStatus, withDatabaseBackup } from "./modules/backups";
let current: Database;
export const setDatabase = (db: Database) => {
  current = db;
};
const range = (raw: any) =>
  z
    .object({ from: date, to: date })
    .refine(
      (v) => v.to > v.from && (Date.parse(v.to) - Date.parse(v.from)) / 86400000 <= 732,
      "Selecciona un rango válido de hasta dos años.",
    )
    .parse(raw);
@Controller()
export class ApiController {
  @Get("health") async health() {
    await current.orm.execute(sql`select 1`);
    return { status: "ok", database: current.pool ? "postgres" : "pglite" };
  }
  @Get("auth/config") config() {
    return {
      local: localMode(),
      supabaseUrl: env.SUPABASE_URL ?? "",
      publishableKey: env.SUPABASE_PUBLISHABLE_KEY ?? "",
    };
  }
  @Post("auth/local") async local() {
    return { token: await localToken(), email: env.OWNER_EMAIL };
  }
  @Get("detail/:resource/:id") detail(
    @Param("resource") resource: string,
    @Param("id") value: string,
  ) {
    uuid.parse(value);
    if (resource !== "purchases") throw new AppError("not_found", "Detalle no disponible.", 404);
    return current.tx(
      async (q) =>
        (
          await q.query(
            "select l.*,p.name,p.sku from purchase_lines l join products p on p.id=l.product_id where purchase_id=$1",
            [value],
          )
        ).rows,
    );
  }
  @Get("settings") settings() {
    return current.tx(async (q) => ({
      ...(await q.query("select * from settings")).rows[0],
      database: current.pool ? "postgres" : "pglite",
      local: localMode(),
    }));
  }
  @Get("backups/status") backupStatus() {
    return backupStatus(current);
  }
  @Post("backups/database") async backup(@Res() res: Response) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const cancellation = new AbortController();
    const cancel = () => {
      if (!res.writableFinished) cancellation.abort();
    };
    res.once("close", cancel);
    try {
      await withDatabaseBackup(
        current,
        async (file, filename) => {
          await current.tx((q) =>
            audit(q, "database_backup", store.id(), "generate", { filename }),
          );
          await new Promise<void>((resolve, reject) => {
            res.download(file, filename, (error) => (error ? reject(error) : resolve()));
          });
        },
        cancellation.signal,
      );
    } finally {
      res.off("close", cancel);
    }
  }
  @Get("tax/documents") taxDocs() {
    return current.tx((q) => taxDocuments(q));
  }
  @Get("tax/monthly") taxMonthly() {
    return current.tx(async (q) => ({
      costs: (await q.query("select * from monthly_cogs order by month desc")).rows,
      inputs: (
        await q.query(
          "select month,isr_withheld_cents,vat_withheld_cents,vat_carry_cents,reference,updated_at from monthly_tax_inputs where scope='store' order by month desc",
        )
      ).rows,
    }));
  }
  @Get("report") report(@QueryParam() raw: any) {
    const { from, to } = range(raw);
    return current.tx((q) => report(q, from, to));
  }
  @Get("exports/:resource") async download(
    @Param("resource") resource: string,
    @QueryParam() raw: any,
    @Res() res: Response,
  ) {
    const { from, to } = range(raw);
    const format = z.enum(["csv", "xlsx"]).default("csv").parse(raw.format);
    const data = await current.tx(async (q) => {
      if (resource === "monthly") return reportRows(await report(q, from, to));
      if (resource === "financial") return reportRows(await report(q, from, to), true);
      if (resource === "categories")
        return (await report(q, from, to)).categories.map((r) => ({
          Categoria: r.name,
          "Cobros MXN": r.collected,
          "Utilidad bruta MXN": r.profit,
          "Margen %": r.margin,
        }));
      if (!["purchases", "expenses", "incomes", "cash", "suppliers"].includes(resource))
        throw new AppError("not_found", "Reporte no disponible.", 404);
      const rows = await store.list(q, resource);
      return rows
        .filter((r) => {
          const d = r.date ?? r.from_date;
          return !d || (d >= from && d < to);
        })
        .map((r) =>
          Object.fromEntries(
            Object.entries(r)
              .filter(([k]) => !k.endsWith("_id") && k !== "id")
              .map(([k, v]) => [
                k.endsWith("_cents") ? k.replace("_cents", " MXN") : k,
                k.endsWith("_cents") && v !== null
                  ? major(String(v))
                  : v !== null && typeof v === "object"
                    ? JSON.stringify(v)
                    : v,
              ]),
          ),
        );
    });
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="tienda-${resource}-${from}.${format}"`,
    );
    res.setHeader("Cache-Control", "no-store");
    if (format === "csv") {
      res.type("text/csv; charset=utf-8").send(csv(data));
      return;
    }
    const book = new ExcelJS.Workbook();
    book.creator = "3dprintmty Tienda";
    const sheet = book.addWorksheet("Tienda");
    const keys = Object.keys(data[0] ?? {});
    sheet.columns = keys.map((k) => ({
      header: k,
      key: k,
      width: k.includes("Concepto") ? 38 : 24,
    }));
    for (const r of data)
      sheet.addRow(
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            (k.includes("MXN") || k === "Margen %") && v !== null ? Number(v) : v,
          ]),
        ),
      );
    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];
    res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .send(Buffer.from(await book.xlsx.writeBuffer()));
  }
  @Post("imports/read")
  @UseInterceptors(FileInterceptor("file", { limits: { fileSize: 3 * 1024 * 1024, files: 1 } }))
  async read(@UploadedFile() file: { buffer: Buffer; originalname: string }) {
    if (!file) throw new AppError("file_required", "Selecciona un CSV o XLSX.");
    const parsed = await fileRows(file.buffer, file.originalname);
    return {
      ...parsed,
      profile: isClipReport(parsed.headers) ? "clip_report" : "generic",
      filename: file.originalname,
      file_hash: hash(file.buffer),
    };
  }
  @Post("imports/preview") async importPreview(@Body() raw: any) {
    const b = z
      .object({
        filename: z.string().max(200),
        file_hash: z.string().length(64),
        rows: z.array(z.record(z.string())).max(10000),
        mapping: z.record(z.string()),
        assume_paid: z.boolean().default(false),
        status_decisions: z.record(z.enum(["include", "exclude"])).default({}),
      })
      .parse(raw);
    const mapped =
      b.rows.length && isClipReport(Object.keys(b.rows[0]!))
        ? clipReportRows(b.rows, b.status_decisions)
        : mapRows(b.rows, b.mapping, b.assume_paid);
    return current.tx((q) =>
      stage(q, b.filename, "clip_import", mapped.rows, mapped.errors, b.file_hash),
    );
  }
  @Get("imports/:id") preview(@Param("id") value: string) {
    return current.tx((q) => preview(q, uuid.parse(value)));
  }
  @Post("actions/:action") action(
    @Param("action") action: string,
    @Body() raw: any,
    @Headers("idempotency-key") key: string,
  ) {
    return current.tx((q) =>
      idempotent(q, key, { action, raw }, async () => {
        if (
          [
            "product",
            "product-update",
            "adjustment",
            "opening-inventory-value",
            "inventory-count",
            "reconciliation",
          ].includes(action) &&
          (await q.query("select inventory_mode from settings")).rows[0]?.inventory_mode ===
            "external"
        )
          throw new AppError("not_found", "El módulo de productos e inventario fue retirado.", 404);
        switch (action) {
          case "product": {
            const b = productInput.parse(raw),
              pid = store.id();
            await q.query(
              "insert into products(id,sku,name,brand,category_id,variant,clip_id,price_cents) values ($1,$2,$3,$4,$5,$6,$7,$8)",
              [
                pid,
                b.sku,
                b.name,
                b.brand,
                b.category_id,
                b.variant,
                b.clip_id || null,
                cents(b.price).toString(),
              ],
            );
            await audit(q, "product", pid, "create", b);
            return { id: pid };
          }
          case "product-update": {
            const b = productInput.extend({ id: uuid, active: z.boolean() }).parse(raw);
            await q.query(
              "update products set sku=$1,name=$2,brand=$3,category_id=$4,variant=$5,clip_id=$6,price_cents=$7,active=$8 where id=$9",
              [
                b.sku,
                b.name,
                b.brand,
                b.category_id,
                b.variant,
                b.clip_id || null,
                cents(b.price).toString(),
                b.active,
                b.id,
              ],
            );
            await audit(q, "product", b.id, "update", b);
            return { id: b.id };
          }
          case "supplier": {
            const b = supplierInput.parse(raw),
              sid = store.id();
            await q.query("insert into suppliers(id,name,email,reference) values ($1,$2,$3,$4)", [
              sid,
              b.name,
              b.email,
              b.reference,
            ]);
            await audit(q, "supplier", sid, "create", b);
            return { id: sid };
          }
          case "serial-record":
            return createSerialRecord(q, raw);
          case "serial-record-update":
            return updateSerialRecord(q, raw);
          case "serial-record-assign":
            return assignSerialRecord(q, raw);
          case "serial-record-invoice":
            return invoiceSerialRecord(q, raw);
          case "supplier-update": {
            const b = supplierInput.extend({ id: uuid }).parse(raw);
            const before = (await q.query("select * from suppliers where id=$1 for update", [b.id]))
              .rows[0];
            if (!before) throw new AppError("not_found", "No existe el proveedor.", 404);
            await q.query("update suppliers set name=$1,email=$2,reference=$3 where id=$4", [
              b.name,
              b.email,
              b.reference,
              b.id,
            ]);
            await audit(q, "supplier", b.id, "update", { before, after: b });
            return { id: b.id };
          }
          case "category": {
            const b = z
                .object({
                  name: z.string().trim().min(1).max(100),
                  parent_id: uuid.nullable().optional(),
                })
                .parse(raw),
              cid = store.id();
            await q.query("insert into categories(id,name,parent_id) values ($1,$2,$3)", [
              cid,
              b.name,
              b.parent_id ?? null,
            ]);
            return { id: cid };
          }
          case "cancel-purchase":
            return cancelDocument(q, "purchase", raw);
          case "cancel-expense":
            return cancelDocument(q, "expense", raw);
          case "tax-profile":
            return enableFiscalProfile(q);
          case "monthly-cost":
            return saveMonthlyCost(q, raw);
          case "monthly-tax":
            return saveTaxInputs(q, raw);
          case "tax-document":
            return saveTaxDocument(q, raw);
          case "purchase":
            return store.purchase(q, raw);
          case "purchase-reference":
            return store.purchaseReference(q, raw);
          case "purchase-notes":
            return store.purchaseNotes(q, raw);
          case "apply-card-fee":
            return applyCardFees(q, [z.object({ id: uuid }).strict().parse(raw).id], true);
          case "expense":
            return store.expense(q, raw);
          case "income":
            return store.income(q, raw);
          case "opening":
            return store.opening(q, raw);
          case "adjustment":
            return store.adjustment(q, raw);
          case "opening-inventory-value":
            return openingInventoryValue(q, raw);
          case "inventory-count":
            return inventoryCount(q, raw);
          case "reconciliation":
            return store.reconciliation(q, raw);
          case "refund":
            return store.refund(q, raw);
          case "cash":
            return store.cash(q, raw);
          case "reject-import": {
            const b = z
              .object({ id: uuid, reason: z.string().trim().max(1000).default("") })
              .parse(raw);
            return reject(q, b.id, b.reason);
          }
          case "confirm-import": {
            const b = z
              .object({
                id: uuid,
                payment_types: z.record(z.enum(["cash", "card", "transfer"])).default({}),
              })
              .parse(raw);
            return confirm(q, b.id, b.payment_types);
          }
          case "settle-clip":
            return settleClip(q, raw);
          case "complement": {
            const b = z
              .object({
                id: uuid,
                net: money.nullable(),
                cogs: money.nullable(),
                fees: money.nullable(),
                category_id: uuid.nullable(),
                reason: z.string().min(5).max(1000),
              })
              .parse(raw);
            const item = (
              await q.query("select * from incomes where id=$1 and status='active'", [b.id])
            ).rows[0];
            if (!item) throw new AppError("not_found", "Ingreso no disponible.", 404);
            await unlocked(q, item.from_date);
            if (
              item.settled_at &&
              (b.fees === null || cents(b.fees).toString() !== item.fees_cents)
            )
              throw new AppError(
                "settled_fees",
                "La comisión ya está conciliada con el depósito y no puede cambiarse desde el complemento.",
                409,
              );
            if (b.net !== null && cents(b.net) > BigInt(item.gross_cents))
              throw new AppError("invalid_net", "El importe sin IVA excede al cobro.");
            if (item.product_id && b.cogs !== null && cents(b.cogs) !== BigInt(item.cogs_cents))
              throw new AppError(
                "valued_cost",
                "El costo de este ingreso proviene del inventario y no puede sustituirse manualmente.",
              );
            await q.query(
              "update incomes set net_cents=$1,cogs_cents=$2,fees_cents=$3,category_id=$4 where id=$5",
              [
                b.net === null ? null : cents(b.net).toString(),
                b.cogs === null ? null : cents(b.cogs).toString(),
                b.fees === null ? null : cents(b.fees).toString(),
                b.category_id,
                b.id,
              ],
            );
            await audit(q, "income", b.id, "complement", { before: item, after: b }, b.reason);
            return { ok: true };
          }
          case "replace-summary": {
            const b = z.object({ id: uuid, reason: z.string().min(8).max(1000) }).parse(raw);
            const item = (
              await q.query(
                "select * from incomes where id=$1 and source='manual_summary' and status='active'",
                [b.id],
              )
            ).rows[0];
            if (!item) throw new AppError("not_found", "Consolidado no disponible.", 404);
            await unlocked(q, item.from_date);
            if (
              item.product_id ||
              (await q.query("select id from cash_movements where income_id=$1", [b.id])).rows
                .length
            )
              throw new AppError(
                "linked_effects",
                "Este consolidado tiene efectos de inventario o cobros. Concilia esos movimientos antes de reemplazarlo.",
              );
            await q.query("update incomes set status='replaced' where id=$1", [b.id]);
            await audit(q, "income", b.id, "replace", item, b.reason);
            return { ok: true };
          }
          case "fee-rule": {
            const b = z
              .object({
                method: z.string().min(1).max(60),
                percent: z.string().regex(/^\d+(\.\d{1,4})?$/),
                fixed: money,
                tax_percent: z.string().regex(/^\d+(\.\d{1,4})?$/),
                msi_percent: z.string().regex(/^\d+(\.\d{1,4})?$/),
                installments: z.coerce.number().int().min(2).max(120).optional(),
              })
              .superRefine((v, ctx) => {
                if ((v.method === "MSI") !== (v.installments !== undefined))
                  ctx.addIssue({
                    code: z.ZodIssueCode.custom,
                    path: ["installments"],
                    message: "Selecciona el plazo para MSI; los otros métodos no llevan plazo.",
                  });
              })
              .parse(raw);
            await q.query(
              `insert into fee_rules(id,method,percent,fixed_cents,tax_percent,msi_percent,installments) values ($1,$2,$3,$4,$5,$6,$7)
              on conflict ${b.installments === undefined ? "(method) where installments is null" : "(method,installments) where installments is not null"}
              do update set percent=excluded.percent,fixed_cents=excluded.fixed_cents,tax_percent=excluded.tax_percent,msi_percent=excluded.msi_percent`,
              [
                store.id(),
                b.method,
                b.percent,
                cents(b.fixed).toString(),
                b.tax_percent,
                b.msi_percent,
                b.installments ?? null,
              ],
            );
            await audit(q, "fee_rule", b.method + ":" + (b.installments ?? "standard"), "save", b);
            return { ok: true };
          }
          case "recurring": {
            const b = z.object({ date, template_id: uuid }).parse(raw);
            await store.ensureOpening(q, b.date);
            const t = (
              await q.query("select * from expense_templates where id=$1 and active", [
                b.template_id,
              ])
            ).rows[0];
            if (!t) throw new AppError("not_found", "Recurrencia no disponible.");
            const eid = store.id();
            if (
              (
                await q.query(
                  "select id from expenses where template_id=$1 and date >= $2 and date < $3",
                  [t.id, ...Object.values(monthBounds(b.date.slice(0, 7)))],
                )
              ).rows.length
            )
              throw new AppError("already_generated", "El gasto de este mes ya fue generado.", 409);
            await q.query(
              "insert into expenses(id,date,category,concept,amount_cents,tax_cents,template_id,tax_mode) values ($1,$2,$3,$4,$5,$6,$7,$8)",
              [eid, b.date, t.category, t.concept, t.amount_cents, t.tax_cents, t.id, t.tax_mode],
            );
            await audit(q, "expense", eid, "recurring", b);
            return { id: eid };
          }
          case "close": {
            const b = z
              .object({ month: z.string(), checklist: z.array(z.boolean()).min(3).max(10) })
              .parse(raw);
            const bounds = monthBounds(b.month);
            const external =
              (await q.query("select inventory_mode from settings")).rows[0]?.inventory_mode ===
              "external";
            if (
              !b.checklist.every(Boolean) ||
              (external ? ![3, 10].includes(b.checklist.length) : b.checklist.length !== 10)
            )
              throw new AppError("checklist_required", "Completa las revisiones del cierre.");
            const snapshot = await report(q, bounds.from, bounds.to);
            const blockers = external ? (snapshot.financial?.warnings ?? []) : snapshot.warnings;
            if (blockers.length)
              throw new AppError(
                "incomplete_close",
                "El cierre tiene datos incompletos: " + blockers.join(" "),
              );
            const existing = (
              await q.query("select * from monthly_closes where month=$1", [b.month])
            ).rows[0];
            if (existing?.status === "closed")
              throw new AppError("already_closed", "El mes ya está cerrado.", 409);
            const cid = existing?.id ?? store.id();
            await q.query(
              "insert into monthly_closes(id,month,status,snapshot,checklist) values ($1,$2,'closed',$3,$4) on conflict(month) do update set status='closed',snapshot=excluded.snapshot,checklist=excluded.checklist,version=monthly_closes.version+1",
              [cid, b.month, JSON.stringify(snapshot), JSON.stringify(b.checklist)],
            );
            await audit(q, "close", cid, "close", { snapshot, checklist: b.checklist });
            return { id: cid };
          }
          case "reopen": {
            const b = z
              .object({ month: z.string(), reason: z.string().min(8).max(1000) })
              .parse(raw);
            monthBounds(b.month);
            await q.query("update monthly_closes set status='reopened' where month=$1", [b.month]);
            await audit(q, "close", b.month, "reopen", b, b.reason);
            return { ok: true };
          }
          default:
            throw new AppError("not_found", "Acción no disponible.", 404);
        }
      }),
    );
  }
  @Get(":resource") list(@Param("resource") resource: string) {
    return current.tx((q) => store.list(q, resource));
  }
}
