import { describe, expect, it } from "vitest";
import { migrations, type Query } from "../src/db/database";

describe("Diagnóstico de migraciones", () => {
  it("indica migrar únicamente cuando falta el historial", async () => {
    const client: Query = {
      query: async () => {
        throw Object.assign(new Error("missing table"), { code: "42P01" });
      },
    };
    await expect(migrations(client, false)).rejects.toThrow("npm run db:migrate");
  });
  it.each(["ENOTFOUND", "42501", "28P01"])("conserva el error real %s", async (code) => {
    const error = Object.assign(new Error("error de conexión o permisos"), { code });
    const client: Query = {
      query: async () => {
        throw error;
      },
    };
    await expect(migrations(client, false)).rejects.toBe(error);
  });
});
