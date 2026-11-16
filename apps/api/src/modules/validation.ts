import { NOTES_MAX_LENGTH } from "@tienda/shared";
import { z } from "zod";
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) => !isNaN(Date.parse(v)) && new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v,
    "Fecha inválida",
  );
export const money = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, "Importe positivo con hasta dos decimales");
export const initialPaymentInput = z
  .object({
    account_id: z.enum(["cash", "bank"]),
    date: date.optional(),
  })
  .optional();
export const quantity = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,6})?$/)
  .refine((v) => Number(v) > 0, "Debe ser mayor a cero");
export const uuid = z.string().uuid();
export const supplierInput = z.object({
  name: z.string().trim().min(1).max(150),
  email: z
    .string()
    .trim()
    .max(254)
    .pipe(z.union([z.string().email(), z.literal("")]))
    .default(""),
  reference: z.string().trim().max(100).default(""),
});
export const productInput = z.object({
  sku: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .transform((v) => v.toUpperCase()),
  name: z.string().trim().min(1).max(200),
  brand: z.string().max(100).default(""),
  category_id: uuid,
  variant: z.string().max(100).default(""),
  clip_id: z.string().trim().max(100).optional(),
  price: money.default("0"),
});
export const incomeInput = z
  .object({
    from: date,
    to: date,
    channel: z.enum(["clip", "cash", "transfer", "other"]),
    description: z.string().trim().min(1).max(200),
    gross: money,
    net: money.nullable(),
    cogs: money.nullable(),
    fees: money.nullable(),
    method: z.string().max(60).default("Sin identificar"),
    category_id: uuid.nullable().optional(),
    product_id: uuid.nullable().optional(),
    quantity: quantity.nullable().optional(),
    notes: z
      .string()
      .max(NOTES_MAX_LENGTH, "Las observaciones admiten hasta 20,000 caracteres.")
      .default(""),
  })
  .refine((v) => v.to > v.from, "El fin exclusivo debe ser posterior al inicio");
