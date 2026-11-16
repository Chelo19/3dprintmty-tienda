import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Module } from "@nestjs/common";
import express from "express";
import { APP_GUARD } from "@nestjs/core";
import { env } from "./env";
import { Database } from "./db/database";
import { ApiController, setDatabase } from "./controller";
import { AuthGuard } from "./http/auth";
import { Errors } from "./http/errors";
@Module({ controllers: [ApiController], providers: [{ provide: APP_GUARD, useClass: AuthGuard }] })
class AppModule {}
export async function createApp(memory = false) {
  if (
    env.NODE_ENV === "production" &&
    (env.AUTH_DRIVER !== "supabase" || !env.OWNER_EMAIL || !env.DATABASE_URL || !env.SUPABASE_URL)
  )
    throw new Error("Configura Auth Supabase, propietario y PostgreSQL antes de producción.");
  const db = new Database(memory);
  await db.init();
  setDatabase(db);
  const app = await NestFactory.create(AppModule, {
    logger: env.VITEST ? false : ["error", "warn", "log"],
    bodyParser: false,
  });
  app.use(express.json({ limit: "8mb" }));
  app.setGlobalPrefix("api/v1");
  app.enableCors({ origin: (env.CORS_ORIGIN ?? "http://localhost:5173").split(",") });
  app.useGlobalFilters(new Errors());
  await app.init();
  const close = app.close.bind(app);
  app.close = async () => {
    await close();
    await db.close();
  };
  return { app, db };
}
if (process.argv[1]?.endsWith("main.ts"))
  createApp()
    .then(async ({ app }) => {
      await app.listen(Number(env.PORT ?? 3001), "127.0.0.1");
      console.log(`API lista: http://localhost:${env.PORT ?? 3001}/api/v1`);
      let stopping = false;
      for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, () => {
          if (!stopping) {
            stopping = true;
            void app.close();
          }
        });
    })
    .catch((e) => {
      console.error(e.message);
      process.exitCode = 1;
    });
