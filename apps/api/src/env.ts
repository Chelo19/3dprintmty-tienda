import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
if (!process.env.VITEST && existsSync(ROOT + ".env")) process.loadEnvFile(ROOT + ".env");
export const env = process.env;
