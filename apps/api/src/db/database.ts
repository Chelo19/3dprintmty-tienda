import { PGlite } from "@electric-sql/pglite";
import { Pool, Client, types, type PoolClient } from "pg";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzleLite } from "drizzle-orm/pglite";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync } from "node:fs";
import { ROOT, env } from "../env";
import { AppError, type Row } from "@tienda/shared";
types.setTypeParser(1082, (v) => v);
export interface Query {
  exec?(text: string): Promise<unknown>;
  query<T extends Row = Row>(text: string, values?: any[]): Promise<{ rows: T[] }>;
}
const files = () =>
  readdirSync(ROOT + "supabase/migrations")
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
export async function migrations(c: Query, apply: boolean) {
  if (apply)
    await c.query(
      "create table if not exists schema_migrations (id text primary key, checksum text not null)",
    );
  let rows: Row[];
  try {
    rows = (await c.query("select * from schema_migrations")).rows;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "42P01") {
      throw new Error("Ejecuta npm run db:migrate antes de iniciar la API.");
    }
    throw error;
  }
  for (const file of files()) {
    const source = readFileSync(ROOT + "supabase/migrations/" + file, "utf8");
    const hash = digest(source);
    const prev = rows.find((r) => r.id === file);
    if (prev && prev.checksum !== hash) throw new Error("Cambió una migración aplicada: " + file);
    if (!prev && apply && file.startsWith("0001_")) {
      const foreign = await c.query(
        "select tablename from pg_tables where schemaname='public' and tablename<>'schema_migrations'",
      );
      if (foreign.rows.length)
        throw new Error(
          "La instalación inicial requiere un esquema public vacío; no se modificaron las tablas existentes.",
        );
    }
    if (!prev) {
      if (!apply) throw new Error("Migración pendiente: " + file);
      await c.query("begin");
      try {
        if (c.exec) await c.exec(source);
        else await c.query(source);
        await c.query("insert into schema_migrations values ($1,$2)", [file, hash]);
        await c.query("commit");
      } catch (e) {
        await c.query("rollback");
        throw e;
      }
    }
  }
}
export async function seed(c: Query) {
  await c.query("insert into settings(id,owner_email) values (1,$1) on conflict do nothing", [
    env.OWNER_EMAIL ?? "mdeleon@3dprintmty.com",
  ]);
  for (const name of [
    "Impresoras 3D",
    "Filamentos",
    "Accesorios",
    "Refacciones",
    "Consumibles",
    "Otros",
  ])
    await c.query("insert into categories(id,name) values ($1,$2) on conflict(name) do nothing", [
      randomUUID(),
      name,
    ]);
}
export class Database {
  lite?: PGlite;
  pool?: Pool;
  orm: any;
  private tail: Promise<void> = Promise.resolve();
  constructor(readonly memory = false) {}
  async init() {
    if (env.DATABASE_URL && !this.memory) {
      this.pool = new Pool({ connectionString: env.DATABASE_URL, max: 5 });
      this.orm = drizzlePg(this.pool);
      try {
        await migrations(this.pool, false);
      } catch (error) {
        await this.pool.end();
        throw error;
      }
    } else {
      if (env.NODE_ENV === "production") throw new Error("Producción requiere PostgreSQL.");
      if (!this.memory) mkdirSync(ROOT + ".data", { recursive: true });
      this.lite = new PGlite({
        dataDir: this.memory ? undefined : ROOT + ".data/pglite",
        parsers: { 1082: (v: string) => v, 20: (v: string) => v, 1700: (v: string) => v },
      });
      await this.lite.waitReady;
      this.orm = drizzleLite(this.lite);
      await migrations(this.lite, true);
      await seed(this.lite);
    }
  }
  async tx<T>(fn: (q: Query) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((r) => (release = r));
    await previous;
    let connection: PoolClient | PGlite | undefined;
    try {
      connection = this.pool ? await this.pool.connect() : this.lite!;
      const c = connection as Query;
      await c.query("begin");
      if (this.pool) await c.query("select pg_advisory_xact_lock(839106,1)");
      await c.query("select set_config('app.owner',$1,true),set_config('app.author',$1,true)", [
        env.OWNER_EMAIL ?? "mdeleon@3dprintmty.com",
      ]);
      await c.query("set local role tienda_api");
      const result = await fn(c as Query);
      await c.query("commit");
      return result;
    } catch (e) {
      if (connection) await (connection as Query).query("rollback").catch(() => {});
      throw e;
    } finally {
      if (connection && "release" in connection) connection.release();
      release();
    }
  }
  async close() {
    await this.pool?.end();
    await this.lite?.close();
  }
}
export const audit = async (
  q: Query,
  entity: string,
  id: string,
  action: string,
  data: unknown,
  reason = "",
) => {
  await q.query(
    "insert into audit_events(id,entity,entity_id,action,actor,reason,data) values ($1,$2,$3,$4,$5,$6,$7)",
    [
      randomUUID(),
      entity,
      id,
      action,
      env.OWNER_EMAIL ?? "mdeleon@3dprintmty.com",
      reason,
      JSON.stringify(data),
    ],
  );
};
export async function unlocked(q: Query, date: string) {
  const found = await q.query(
    "select month from monthly_closes where month >= $1 and status='closed' order by month limit 1",
    [date.slice(0, 7)],
  );
  if (found.rows.length)
    throw new AppError(
      "month_closed",
      "Este movimiento afecta un mes cerrado. Reabre los cierres desde la fecha afectada.",
      409,
    );
}
export async function idempotent<T>(
  q: Query,
  key: string | undefined,
  payload: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  if (!key || key.length > 200)
    throw new AppError("idempotency_required", "Falta una llave de captura válida.");
  const hash = digest(JSON.stringify(payload));
  const prev = (await q.query("select * from idempotency_requests where key=$1", [key])).rows[0];
  if (prev) {
    if (prev.payload_hash !== hash)
      throw new AppError(
        "idempotency_conflict",
        "La captura cambió. Usa una nueva operación.",
        409,
      );
    return prev.result;
  }
  const result = await fn();
  await q.query("insert into idempotency_requests(key,payload_hash,result) values ($1,$2,$3)", [
    key,
    hash,
    JSON.stringify(result),
  ]);
  return result;
}
