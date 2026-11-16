// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { TaxPage } from "./tax";
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
const mocks = vi.hoisted(() => ({ api: vi.fn(), action: vi.fn() }));
vi.mock("../lib/api", () => mocks);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const metric = { value: "0.00", status: "completo" };
function show() {
  mocks.action.mockResolvedValue({ month: "2026-11" });
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/tax/monthly"
        ? { costs: [], inputs: [] }
        : path === "/tax/documents"
          ? [
              {
                id: "expense",
                type: "expense",
                date: "2026-11-10",
                label: "Renta",
                status: "active",
                vat_cents: "1600",
                total_cents: "11600",
                proof: null,
                paid_cents: "5800",
                invoice_uuid_suggestion: "11111111-1111-4111-8111-111111111111",
                default_notes: "Comprobación del gasto Renta ya registrado",
              },
            ]
          : {
              afterIsr: metric,
              cogs: { value: null, status: "no_disponible" },
              cash: { value: "-58.00", status: "completo" },
              sourceSummary: {
                purchase_count: 0,
                expense_count: 1,
                purchases_total: metric,
                acquisition_cost: metric,
                expenses_total: { value: "116.00", status: "completo" },
                operating_expense: { value: "100.00", status: "completo" },
                assets_total: metric,
                purchases_paid: metric,
                expenses_paid: { value: "58.00", status: "completo" },
                recoveries: metric,
                vat_recorded: { value: "16.00", status: "completo" },
                vat_paid_pending: { value: "8.00", status: "completo" },
              },
              fiscal: {
                profile: "RESICO",
                monthly: [
                  {
                    month: "2026-11",
                    pending_reason: null,
                  },
                ],
                vat_collected: metric,
                vat_creditable: metric,
                vat_due: metric,
                vat_favor: metric,
                isr_estimate: metric,
                isr_due: metric,
                notice: "Estimaciones documentadas",
              },
            },
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <TaxPage from="2026-11-01" />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return client;
}
it("guarda un costo mensual independiente y no exige registrar productos", async () => {
  const c = show();
  await screen.findByText("Impuestos y costo mensual");
  fireEvent.click(screen.getByRole("button", { name: "Capturar o corregir costo mensual" }));
  fireEvent.change(screen.getByLabelText("Costo vendido del mes, sin IVA recuperable"), {
    target: { value: "400" },
  });
  fireEvent.change(screen.getByLabelText("Fuente del costo y motivo"), {
    target: { value: "Reporte externo de costos mensual" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Guardar costo mensual" }));
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "monthly-cost",
      {
        month: "2026-11",
        amount: "400",
        reference: "Reporte externo de costos mensual",
        active: true,
      },
      expect.any(String),
    ),
  );
  expect(await screen.findByText("Costo mensual guardado.")).toBeTruthy();
  c.clear();
});
it("omite otras actividades y permite ajustes opcionales únicamente de esta tienda", async () => {
  const c = show();
  await screen.findByText("Impuestos y costo mensual");
  expect(screen.queryByLabelText("Otros ingresos cobrados sin IVA")).toBeNull();
  expect(screen.queryByText("Otras actividades del mismo RFC y ajustes mensuales")).toBeNull();
  fireEvent.change(screen.getByLabelText("ISR retenido de esta tienda"), {
    target: { value: "10" },
  });
  fireEvent.change(screen.getByLabelText("Referencia y respaldo de los ajustes de la tienda"), {
    target: { value: "Retención documentada de la tienda" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Guardar ajustes fiscales de la tienda" }));
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "monthly-tax",
      {
        month: "2026-11",
        isr_withheld: "10",
        vat_withheld: "0",
        vat_carry: "0",
        reference: "Retención documentada de la tienda",
      },
      expect.any(String),
    ),
  );
  c.clear();
});
it("permite comprobar IVA con UUID y fecha sin modificar el importe del gasto", async () => {
  const c = show();
  await screen.findByText("Renta");
  fireEvent.click(screen.getByRole("button", { name: "Ver / editar" }));
  fireEvent.change(screen.getByLabelText("Tratamiento fiscal"), {
    target: { value: "creditable" },
  });
  expect((screen.getByLabelText("UUID del CFDI") as HTMLInputElement).value).toBe(
    "11111111-1111-4111-8111-111111111111",
  );
  expect(
    (screen.getByLabelText("Respaldo y observaciones fiscales") as HTMLTextAreaElement).value,
  ).toBe("Comprobación del gasto Renta ya registrado");
  fireEvent.change(screen.getByLabelText("UUID del CFDI"), {
    target: { value: "11111111-1111-4111-8111-111111111111" },
  });
  fireEvent.change(screen.getByLabelText("Fecha de comprobación fiscal"), {
    target: { value: "2026-11-16" },
  });
  fireEvent.change(screen.getByLabelText("Respaldo y observaciones fiscales"), {
    target: { value: "CFDI revisado y requisitos comprobados" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Guardar comprobación fiscal" }));
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "tax-document",
      expect.objectContaining({
        id: "expense",
        type: "expense",
        status: "creditable",
        invoice_vat: "16.00",
        eligible_on: "2026-11-16",
        invoice_uuid: "11111111-1111-4111-8111-111111111111",
      }),
      expect.any(String),
    ),
  );
  c.clear();
});

it("muestra automáticamente gastos, pagos e IVA sin convertir compras en costo vendido", async () => {
  const c = show();
  await screen.findByText("Datos tomados automáticamente de tus registros");
  expect(screen.getByText("Gastos operativos registrados, IVA incluido")).toBeTruthy();
  expect(screen.getByText("Pagos de gastos y activos realizados en el periodo")).toBeTruthy();
  expect(screen.getByText("IVA pagado pendiente de comprobación al cierre")).toBeTruthy();
  expect(screen.getByText("Pendiente de dato del PDV")).toBeTruthy();
  expect(mocks.action).not.toHaveBeenCalled();
  c.clear();
});
