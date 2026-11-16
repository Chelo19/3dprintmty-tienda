import { Decimal } from "@tienda/domain";
export const mxn = (amount: string | number | null | undefined) =>
  amount === null || amount === undefined
    ? "Pendiente"
    : new Intl.NumberFormat("es-MX", {
        style: "currency",
        currency: "MXN",
        maximumFractionDigits: 2,
      }).format(Number(amount));
export const money = (cents: string | number | null | undefined) =>
  cents === null || cents === undefined
    ? "Pendiente"
    : mxn(new Decimal(String(cents)).div(100).toFixed(2));
export const amount = (cents: string | number | null | undefined) =>
  cents === null || cents === undefined ? "" : new Decimal(String(cents)).div(100).toFixed(2);
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Monterrey",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const shortDate = (d: string) =>
  new Date(d.slice(0, 10) + "T12:00:00").toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
export const sourceLabel = (s: string) =>
  ({ clip_api: "API Clip", clip_import: "Archivo Clip", manual_summary: "Consolidado" })[s] ?? s;
