import { spawn } from "node:child_process";
import { accessSync, constants, createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { AppError } from "@tienda/shared";
import type { Database } from "../db/database";
import { env } from "../env";

const MAX_BYTES = 256 * 1024 * 1024;
let running = false;
function executable(path: string) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function tools() {
  const candidates = env.PG_DUMP_PATH
    ? [env.PG_DUMP_PATH]
    : [
        ...String(env.PATH ?? "")
          .split(delimiter)
          .map((p) => join(p, "pg_dump")),
        "/opt/homebrew/opt/libpq/bin/pg_dump",
        "/usr/local/opt/libpq/bin/pg_dump",
      ];
  const dump = candidates.find(executable);
  if (!dump) return null;
  const all = join(dirname(dump), "pg_dumpall"),
    restore = join(dirname(dump), "pg_restore");
  return executable(all) && executable(restore) ? { dump, all, restore } : null;
}
export function backupStatus(db: Database) {
  return {
    available: !!db.lite || (!!env.MIGRATION_DATABASE_URL && !!tools()),
    database: db.lite ? "pglite" : "postgres",
    running,
  };
}
// No shell, no credentials in arguments, no raw subprocess errors sent to the browser.
async function runTool(
  binary: string,
  args: string[],
  output: string,
  childEnv: NodeJS.ProcessEnv,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const child = spawn(binary, args, {
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
    signal,
    timeout: 300_000,
    killSignal: "SIGKILL",
  });
  // Never persist stderr: it can contain connection details or database content.
  child.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error("backup_tool_failed")),
    );
  });
  let bytes = 0;
  const limit = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(bytes > MAX_BYTES ? new Error("backup_size_limit") : null, chunk);
    },
  });
  const writing = pipeline(child.stdout, limit, createWriteStream(output, { mode: 0o600 })).catch(
    (error) => {
      child.kill("SIGKILL");
      throw error;
    },
  );
  const results = await Promise.allSettled([exited, writing]);
  if (results.some((r) => r.status === "rejected"))
    throw new AppError(
      "backup_failed",
      "No se pudo generar el respaldo. Revisa en el servidor la conexión de migraciones, los permisos y la versión de las herramientas PostgreSQL. No se descargó una copia parcial.",
      503,
    );
}
const digest = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");

export async function withDatabaseBackup<T>(
  db: Database,
  deliver: (file: string, filename: string) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (running)
    throw new AppError(
      "backup_busy",
      "Ya se está preparando un respaldo. Espera a que termine.",
      409,
    );
  if (!backupStatus(db).available)
    throw new AppError(
      "backup_unavailable",
      "El respaldo requiere MIGRATION_DATABASE_URL y las herramientas pg_dump, pg_dumpall y pg_restore instaladas en el servidor.",
      503,
    );
  running = true;
  let folder: string | undefined;
  try {
    folder = await mkdtemp(join(tmpdir(), "tienda-backup-"));
    const zip = new JSZip();
    const createdAt = new Date().toISOString();
    const filename = `tienda-backup-${createdAt.replace(/[:.]/g, "-")}.zip`;
    const entries: Record<string, string> = {};
    if (db.lite) {
      const snapshot = Buffer.from(await (await db.lite.dumpDataDir()).arrayBuffer());
      zip.file("pglite.tar.gz", snapshot);
      entries["pglite.tar.gz"] = digest(snapshot);
    } else {
      const binaries = tools()!;
      const url = new URL(env.MIGRATION_DATABASE_URL!);
      const password = decodeURIComponent(url.password);
      url.password = "";
      const childEnv = {
        ...process.env,
        PGPASSWORD: password,
        PGCONNECT_TIMEOUT: "15",
        PGOPTIONS: "-c default_transaction_read_only=on -c statement_timeout=300000",
      };
      await runTool(
        binaries.dump,
        ["--dbname", url.toString(), "--no-password", "--format=custom"],
        join(folder, "database.dump"),
        childEnv,
        signal,
      );
      await runTool(
        binaries.all,
        ["--dbname", url.toString(), "--no-password", "--roles-only", "--no-role-passwords"],
        join(folder, "roles.sql"),
        childEnv,
        signal,
      );
      await runTool(
        binaries.restore,
        ["--list", join(folder, "database.dump")],
        join(folder, "contents.txt"),
        childEnv,
        signal,
      );
      for (const name of ["database.dump", "roles.sql", "contents.txt"]) {
        const data = await readFile(join(folder, name));
        if (!data.length)
          throw new AppError(
            "backup_empty",
            "El respaldo está vacío; no se generó la descarga.",
            503,
          );
        zip.file(name, data);
        entries[name] = digest(data);
      }
    }
    signal?.throwIfAborted();
    zip.file(
      "manifest.json",
      JSON.stringify(
        {
          format: "tienda-database-backup-v1",
          created_at: createdAt,
          database: db.lite ? "pglite" : "postgres",
          scope:
            "Base de datos completa, sin filtro de fechas. No incluye archivos de Storage, código, .env, claves API, configuración de Auth ni contraseñas de roles.",
          sha256: entries,
          validation: db.lite ? "snapshot" : "pg_restore --list",
        },
        null,
        2,
      ),
    );
    zip.file("LEEME.txt", restoreGuide(!!db.lite));
    const file = join(folder, filename);
    await writeFile(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }), {
      mode: 0o600,
    });
    return await deliver(file, filename);
  } finally {
    try {
      if (folder) await rm(folder, { recursive: true, force: true });
    } finally {
      running = false;
    }
  }
}
function restoreGuide(local: boolean) {
  return `RESPALDO DE LA BASE DE DATOS DE LA TIENDA\n\n${
    local
      ? "pglite.tar.gz contiene la instantánea local completa. Para restaurarla, utiliza la opción loadDataDir de la misma versión de PGlite, en una instancia nueva sin datos. No sobrescribas una base en uso."
      : `database.dump contiene la estructura, datos, índices, restricciones, políticas y permisos exportados por pg_dump de toda la base. roles.sql contiene roles y membresías, sin contraseñas. contents.txt permite revisar el contenido del archivo.\n\nRESTAURACIÓN\n1. Conserva el original y prueba primero en una base aislada. Usa pg_restore de la misma versión o una más nueva que la que generó la copia.\n2. Revisa roles.sql antes de aplicarlo: un proyecto Supabase ya tiene roles administrados. Recrea solo los roles personalizados que falten, incluido tienda_api. No reemplaces roles del destino ni sus contraseñas.\n3. En Supabase, configura las extensiones y servicios requeridos. Sus esquemas administrados ya existen: adapta la selección de objetos a restaurar mediante pg_restore --list y --use-list. No apliques el archivo completo sobre un proyecto en operación.\n4. En una base vacía preparada con los roles y extensiones necesarios, la restauración lógica se realiza con pg_restore --exit-on-error --no-owner --dbname=CONEXION_DESTINO database.dump. Este paso escribe en el destino.\n5. Verifica recuentos, saldos y acceso del propietario antes de usar el destino. Reconfigura credenciales y conexiones para ese destino.\n\nEl archivo fue comprobado con pg_restore --list; esto verifica que el catálogo del archivo se puede leer, pero no sustituye una prueba real de restauración.`
  }\n\nALCANCE\nIncluye todo el historial de la base; no depende del periodo seleccionado en la pantalla. No incluye archivos de Supabase Storage, código del proyecto, .env, claves API ni configuración externa de Supabase/Auth. Copia esos elementos por separado si los necesitas. Los archivos de Storage no están dentro de la base de datos.\n\nmanifest.json contiene la fecha UTC y las sumas SHA-256 de los archivos. El ZIP no está cifrado y contiene datos privados, incluidos datos de autenticación si existen en la base. Guárdalo en una ubicación privada. El servidor elimina sus archivos temporales tras la descarga o al fallar.\n`;
}
