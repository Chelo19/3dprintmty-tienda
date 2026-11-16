import { Client } from "pg";
import { env } from "../env";
import { migrations, seed } from "./database";
async function migrate() {
  const url = env.MIGRATION_DATABASE_URL;
  if (!url)
    throw new Error(
      "Configura MIGRATION_DATABASE_URL; el arranque local prepara PGlite automáticamente.",
    );
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query("select pg_advisory_lock(839106,2)");
    await migrations(client, true);
    await seed(client);
    console.log("Migraciones verificadas y aplicadas.");
  } finally {
    await client.query("select pg_advisory_unlock(839106,2)").catch(() => {});
    await client.end();
  }
}
migrate().catch((error: Error) => {
  console.error(error.message);
  process.exitCode = 1;
});
