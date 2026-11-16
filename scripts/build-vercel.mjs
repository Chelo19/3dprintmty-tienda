import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
const origin = process.env.API_ORIGIN;
if (!origin) throw new Error("Configura API_ORIGIN con la URL HTTPS de tu API.");
const url = new URL(origin);
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.pathname !== "/" ||
  url.search ||
  url.hash
)
  throw new Error("API_ORIGIN debe ser un origen HTTPS sin ruta ni credenciales.");
execFileSync("npm", ["run", "build"], { stdio: "inherit" });
rmSync(".vercel/output", { recursive: true, force: true });
mkdirSync(".vercel/output/static", { recursive: true });
cpSync("apps/web/dist", ".vercel/output/static", { recursive: true });
writeFileSync(
  ".vercel/output/config.json",
  JSON.stringify(
    {
      version: 3,
      routes: [
        {
          src: "/api/(.*)",
          dest: origin.replace(/\/$/, "") + "/api/$1",
          headers: { "Cache-Control": "no-store" },
        },
        { handle: "filesystem" },
        { src: "/(.*)", dest: "/index.html" },
      ],
    },
    null,
    2,
  ),
);
console.log("Frontend y proxy preparados en .vercel/output.");
