// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Dashboard } from "./dashboard";
const mocks = vi.hoisted(() => ({ api: vi.fn(), download: vi.fn() }));
vi.mock("../lib/api", () => mocks);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const complete = (value = "0.00") => ({ value, status: "completo" });
const pending = { value: null, status: "no_disponible" };
async function show(warnings: string[] = []) {
  const r = {
    inventoryMode: "external",
    collected: complete("116.00"),
    cash: complete("-158.00"),
    cogs: pending,
    gross: pending,
    operating: pending,
    afterIsr: pending,
    sales: complete("100.00"),
    warnings: ["Hay ingresos sin costo vendido; no se calcula rentabilidad completa."],
    count: 1,
    knownCosts: 0,
    sourceSummary: { purchases_paid: complete("116.00"), expenses_paid: complete("158.00") },
    financial: {
      warnings,
      months: [{ month: "2026-11", cash: "-158.00" }],
      movements: [{ name: "Pagos de compras", amount: "-116.00" }],
    },
    categories: [{ name: "Sin clasificar", collected: "116.00", profit: null, margin: null }],
    expenseCategories: [],
    payments: [],
    recentPurchases: [],
    recentExpenses: [
      {
        id: "e",
        date: "2026-11-15",
        concept: "Servicio",
        category: "Servicios",
        amount_cents: "5800",
        tax_cents: "800",
        total_cents: "5800",
      },
    ],
    fiscal: {
      vat_collected: complete("16.00"),
      vat_creditable: complete(),
      vat_due: complete("16.00"),
      vat_favor: complete(),
      isr_estimate: complete("1.00"),
      isr_due: complete("1.00"),
      monthly: [],
      notice: "Estimación exclusiva de esta tienda.",
    },
  };
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(path === "/settings" ? { opening_done: true } : r),
  );
  mocks.download.mockResolvedValue(undefined);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <Dashboard from="2026-11-01" to="2026-12-01" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  await screen.findByRole("heading", { name: "Resumen financiero" });
  return client;
}
it("presenta flujo, pagos e impuestos sin exigir costos vendidos ni mostrar rentabilidad pendiente", async () => {
  const client = await show();
  expect(screen.getByRole("heading", { name: "Entradas y salidas de dinero" })).toBeTruthy();
  expect(
    screen.getByRole("img", { name: "Flujo de caja disponible mensual en pesos mexicanos" }),
  ).toBeTruthy();
  expect(screen.getByTitle("Flujo de caja: -$158.00")).toBeTruthy();
  expect(screen.queryByText("De la venta a la utilidad")).toBeNull();
  expect(
    screen.queryByText(
      /Costo vendido|Costo de lo vendido|Resultado pendiente|Costo o IVA pendiente|Resultado después de ISR/,
    ),
  ).toBeNull();
  expect(screen.queryByText(/Hay ingresos sin costo vendido/)).toBeNull();
  expect(screen.getByText("Sin alertas de movimientos")).toBeTruthy();
  expect(screen.getByText("IVA estimado por pagar · tienda")).toBeTruthy();
  const expense = screen.getByText("Servicio").closest(".recent-row")!;
  expect(within(expense as HTMLElement).getByText("$58.00")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Exportar" }));
  expect(mocks.download).toHaveBeenCalledWith("financial", "2026-11-01", "2026-12-01");
  expect(screen.getByRole("link", { name: /Importar CSV de Clip/ }).getAttribute("href")).toBe(
    "/app/importaciones",
  );
  client.clear();
});
it("mantiene visibles las alertas financieras que sí necesitan conciliación", async () => {
  const client = await show(["Hay pagos de compras o gastos cancelados pendientes de recuperar."]);
  expect(screen.getByText("Movimientos por revisar")).toBeTruthy();
  expect(
    screen.getByText("Hay pagos de compras o gastos cancelados pendientes de recuperar."),
  ).toBeTruthy();
  expect(screen.queryByText("Sin pendientes de revisión")).toBeNull();
  client.clear();
});
