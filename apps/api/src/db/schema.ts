import { pgTable, uuid, text, bigint, boolean, timestamp } from "drizzle-orm/pg-core";
export const products = pgTable("products", {
  id: uuid("id").primaryKey(),
  sku: text("sku").notNull(),
  name: text("name").notNull(),
  brand: text("brand").notNull(),
  priceCents: bigint("price_cents", { mode: "bigint" }).notNull(),
  active: boolean("active").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
