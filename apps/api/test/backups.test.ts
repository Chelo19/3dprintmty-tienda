import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import JSZip from "jszip";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { createApp } from "../src/main";
import { backupStatus, withDatabaseBackup } from "../src/modules/backups";
import { env } from "../src/env";
let app: any, db: any, token: string;
const original = { url: env.MIGRATION_DATABASE_URL, binary: env.PG_DUMP_PATH };
beforeAll(async () => {
  env.AUTH_DRIVER = "local";
  env.OWNER_EMAIL = "mdeleon@3dprintmty.com";
  delete env.DATABASE_URL;
  ({ app, db } = await createApp(true));
  token = (await request(app.getHttpServer()).post("/api/v1/auth/local")).body.token;
});
afterAll(async () => {
  for (const [key, value] of Object.entries({
    MIGRATION_DATABASE_URL: original.url,
    PG_DUMP_PATH: original.binary,
  })) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  await app?.close();
});
const owner = (method: "get" | "post", path: string) =>
  request(app.getHttpServer())
    [method]("/api/v1/" + path)
    .set("Authorization", "Bearer " + token);
describe.sequential("Respaldos privados", () => {
  it("protege disponibilidad y descarga contra accesos sin sesión", async () => {
    expect((await request(app.getHttpServer()).get("/api/v1/backups/status")).status).toBe(401);
    expect((await request(app.getHttpServer()).post("/api/v1/backups/database")).status).toBe(401);
    expect((await owner("get", "backups/status")).body).toEqual({
      available: true,
      database: "pglite",
      running: false,
    });
  });
  it("descarga un ZIP completo sin caché, verifica sus hashes y restaura la instantánea local", async () => {
    const result = await owner("post", "backups/database")
      .buffer(true)
      .parse((res: any, done: any) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => done(null, Buffer.concat(chunks)));
        res.on("error", done);
      });
    expect(result.status).toBe(201);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.headers["content-disposition"]).toMatch(
      /attachment; filename="tienda-backup-.*\.zip"/,
    );
    const zip = await JSZip.loadAsync(result.body);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    const snapshot = await zip.file("pglite.tar.gz")!.async("nodebuffer");
    expect(manifest.sha256["pglite.tar.gz"]).toBe(
      createHash("sha256").update(snapshot).digest("hex"),
    );
    expect(await zip.file("LEEME.txt")!.async("string")).toContain("loadDataDir");
    const restored = new PGlite({ loadDataDir: new Blob([new Uint8Array(snapshot)]) });
    try {
      await restored.waitReady;
      expect(
        (await restored.query("select count(*)::int as n from schema_migrations")).rows,
      ).toEqual((await db.lite.query("select count(*)::int as n from schema_migrations")).rows);
      expect((await restored.query("select owner_email from settings")).rows).toEqual([
        { owner_email: env.OWNER_EMAIL },
      ]);
      expect((await restored.query("select count(*)::int as n from cash_movements")).rows).toEqual([
        { n: 0 },
      ]);
    } finally {
      await restored.close();
    }
  });
  it("evita respaldos simultáneos y limpia los archivos incluso si falla la entrega", async () => {
    let file = "";
    await expect(
      withDatabaseBackup(db, async (path) => {
        file = path;
        expect(backupStatus(db).running).toBe(true);
        await expect(withDatabaseBackup(db, async () => {})).rejects.toMatchObject({
          code: "backup_busy",
        });
        throw new Error("interrupted_download");
      }),
    ).rejects.toThrow("interrupted_download");
    await expect(access(file)).rejects.toMatchObject({ code: "ENOENT" });
    expect(backupStatus(db).running).toBe(false);
  });
  it("empaqueta PostgreSQL y roles sin contraseñas ni conexiones privadas, y rechaza una exportación parcial", async () => {
    const folder = await mkdtemp(join(tmpdir(), "tienda-backup-tools-"));
    const fakeDb = { pool: {} } as any;
    try {
      env.MIGRATION_DATABASE_URL =
        "postgresql://postgres:secret-backup-password@localhost:5432/postgres";
      env.PG_DUMP_PATH = join(folder, "pg_dump");
      for (const binary of ["pg_dump", "pg_dumpall", "pg_restore"]) {
        await writeFile(
          join(folder, binary),
          "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
          { mode: 0o700 },
        );
      }
      await withDatabaseBackup(fakeDb, async (file) => {
        const zip = await JSZip.loadAsync(await readFile(file));
        expect(Object.keys(zip.files).sort()).toEqual([
          "LEEME.txt",
          "contents.txt",
          "database.dump",
          "manifest.json",
          "roles.sql",
        ]);
        const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
        expect(manifest.validation).toBe("pg_restore --list");
        for (const name of Object.keys(zip.files))
          expect(await zip.file(name)!.async("string")).not.toContain("secret-backup-password");
        expect(await zip.file("roles.sql")!.async("string")).toContain("--no-role-passwords");
      });
      await writeFile(
        env.PG_DUMP_PATH,
        '#!/usr/bin/env node\nprocess.stdout.write("partial"); process.stderr.write("secret-backup-password"); process.exit(7);\n',
      );
      await chmod(env.PG_DUMP_PATH, 0o700);
      let delivered = false;
      await expect(
        withDatabaseBackup(fakeDb, async () => {
          delivered = true;
        }),
      ).rejects.toMatchObject({ code: "backup_failed", status: 503 });
      expect(delivered).toBe(false);
      expect(backupStatus(fakeDb).running).toBe(false);
      env.PG_DUMP_PATH = join(folder, "missing");
      expect(backupStatus(fakeDb).available).toBe(false);
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });
});
