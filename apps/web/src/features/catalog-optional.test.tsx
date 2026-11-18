// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Settings } from "./operations";
import { Records } from "./records";
// jsdom has no native dialog implementation; keep the component's real form behavior.
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
const mocks = vi.hoisted(() => ({ api: vi.fn(), action: vi.fn(), download: vi.fn() }));
vi.mock("../lib/api", () => mocks);
it("permite editar y guardar una tarifa MSI por plazo sin sustituir otros plazos", async () => {
  const fee = (installments: number, msi_percent: string) => ({
    method: "MSI",
    installments,
    percent: "2.99",
    fixed_cents: "100",
    tax_percent: "16",
    msi_percent,
  });
  const client = show(<Settings />, { opening_done: true, opening_date: "2026-11-10" }, (path) =>
    path === "/fee-rules" ? [fee(3, "4.57"), fee(6, "7")] : [],
  );
  mocks.action.mockResolvedValue({ ok: true });
  fireEvent.click(await screen.findByRole("button", { name: "Editar tarifa MSI 6 meses" }));
  expect(
    (screen.getByLabelText("Plazo MSI (meses)", { exact: false }) as HTMLInputElement).value,
  ).toBe("6");
  expect((screen.getByLabelText("Recargo MSI %", { exact: false }) as HTMLInputElement).value).toBe(
    "7",
  );
  fireEvent.change(screen.getByLabelText("Recargo MSI %", { exact: false }), {
    target: { value: "7.5" },
  });
  fireEvent.submit(screen.getByRole("button", { name: "Guardar registro" }).closest("form")!);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "fee-rule",
      expect.objectContaining({ method: "MSI", installments: "6", msi_percent: "7.5" }),
      expect.any(String),
    ),
  );
  client.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
function show(element: React.ReactNode, settings: any, data?: (path: string) => any) {
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(path === "/settings" ? settings : data ? data(path) : []),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>{element}</QueryClientProvider>
    </MemoryRouter>,
  );
  return client;
}
it("permite registrar apertura sin productos ni inventario", async () => {
  const client = show(<Settings />, { opening_done: false, inventory_mode: "external" });
  fireEvent.click(await screen.findByRole("button", { name: "Registrar apertura" }));
  expect(screen.getByText(/No necesitas registrar productos ni inventario inicial/)).toBeTruthy();
  expect(screen.queryByText("Control de inventario")).toBeNull();
  expect(screen.queryByText("Valor total del inventario inicial a costo")).toBeNull();
  expect(screen.queryByText("Agregar producto")).toBeNull();
  client.clear();
});
it("la compra por totales no incluye selectores de productos", async () => {
  const client = show(<Records resource="purchases" from="2026-11-01" to="2026-12-01" />, {
    opening_done: true,
    inventory_mode: "external",
  });
  fireEvent.click(await screen.findByRole("button", { name: "Registrar compra" }));
  expect(screen.getByText("Importe de mercancía sin IVA recuperable")).toBeTruthy();
  expect(
    (screen.getByLabelText("Factura o referencia única (opcional)") as HTMLInputElement).required,
  ).toBe(false);
  expect(screen.queryByText("Agregar producto")).toBeNull();
  client.clear();
});
it("conserva la apertura existente y deja de solicitar inventario inicial", async () => {
  const client = show(<Settings />, {
    opening_done: true,
    opening_date: "2026-11-10",
    inventory_mode: "external",
    opening_inventory_cents: null,
  });
  expect(await screen.findByText("Apertura registrada")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Completar inventario inicial" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Corregir valor inicial" })).toBeNull();
  client.clear();
});
it.each(["purchases", "expenses"])(
  "permite cancelar un registro de %s con motivo y muestra el resultado",
  async (resource) => {
    const doc = {
      id: "doc",
      date: "2026-11-10",
      status: "active",
      reference: "FACTURA",
      concept: "Gasto",
      summary_cost_cents: "10000",
      total_cents: "11600",
      amount_cents: "10000",
      tax_cents: "1600",
      paid_cents: "0",
      recovered_cents: "0",
      recoverable_cents: "0",
    };
    let cancelled = false;
    const client = show(
      <Records resource={resource} from="2026-11-01" to="2026-12-01" />,
      { opening_done: true, inventory_mode: "external" },
      (path) =>
        path === "/" + resource
          ? [
              {
                ...doc,
                ...(cancelled
                  ? {
                      status: "cancelled",
                      cancelled_at: "2026-11-11T06:00:00Z",
                      cancellation_reason: "Registro capturado por error",
                    }
                  : {}),
              },
            ]
          : [],
    );
    mocks.action.mockImplementation(async () => {
      cancelled = true;
      return { cancelled: true };
    });
    fireEvent.click(await screen.findByRole("button", { name: "Ver / editar" }));
    const buttonName = resource === "purchases" ? "Cancelar compra" : "Cancelar gasto";
    fireEvent.change(screen.getByLabelText("Motivo de la cancelación"), {
      target: { value: "Registro capturado por error" },
    });
    fireEvent.click(screen.getByRole("button", { name: buttonName }));
    await waitFor(() =>
      expect(mocks.action).toHaveBeenCalledWith(
        resource === "purchases" ? "cancel-purchase" : "cancel-expense",
        { id: "doc", reason: "Registro capturado por error" },
        expect.any(String),
      ),
    );
    await screen.findByText(resource === "purchases" ? "Cancelada" : "Cancelado");
    fireEvent.click(screen.getByRole("button", { name: "Ver / editar" }));
    expect(screen.getByText(/Documento cancelado el/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: buttonName })).toBeNull();
    expect(screen.queryByText("Registrar pago en Efectivo")).toBeNull();
    client.clear();
  },
);

it("permite capturar un solo total sin IVA acreditable y cambiar al desglose", async () => {
  const client = show(<Records resource="expenses" from="2026-11-01" to="2026-12-01" />, {
    opening_done: true,
  });
  mocks.action.mockResolvedValue({ id: "expense" });
  fireEvent.click(await screen.findByRole("button", { name: "Registrar gasto" }));
  expect(screen.getByLabelText("Total del gasto")).toBeTruthy();
  expect(screen.queryByLabelText("IVA acreditable")).toBeNull();
  fireEvent.change(screen.getByLabelText("Captura del gasto"), { target: { value: "itemized" } });
  fireEvent.change(screen.getByLabelText("IVA acreditable"), { target: { value: "160" } });
  fireEvent.change(screen.getByLabelText("Captura del gasto"), {
    target: { value: "total_no_credit" },
  });
  fireEvent.change(screen.getByLabelText("Total del gasto"), { target: { value: "1160" } });
  fireEvent.change(screen.getByLabelText("Concepto"), { target: { value: "Comprobante" } });
  fireEvent.submit(screen.getByRole("button", { name: "Guardar registro" }).closest("form")!);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "expense",
      expect.objectContaining({ amount: "1160", tax: "0", tax_mode: "total_no_credit" }),
      expect.any(String),
    ),
  );
  client.clear();
});

it.each(["purchases", "expenses"])(
  "permite registrar como pagado al crear %s con cuenta y fecha",
  async (resource) => {
    const client = show(
      <Records resource={resource} from="2026-11-01" to="2026-12-01" />,
      { opening_done: true },
      (path) => (path === "/suppliers" ? [{ id: "supplier", name: "Proveedor" }] : []),
    );
    mocks.action.mockResolvedValue({ id: "paid-doc" });
    fireEvent.click(
      await screen.findByRole("button", {
        name: resource === "purchases" ? "Registrar compra" : "Registrar gasto",
      }),
    );
    expect(screen.queryByLabelText("Cuenta de pago")).toBeNull();
    fireEvent.click(screen.getByRole("checkbox", { name: "Registrar como pagado" }));
    fireEvent.change(screen.getByLabelText("Cuenta de pago"), { target: { value: "bank" } });
    fireEvent.change(screen.getByLabelText("Fecha del pago (opcional)", { exact: false }), {
      target: { value: "2026-11-15" },
    });
    if (resource === "purchases") {
      fireEvent.change(screen.getByLabelText("Proveedor"), { target: { value: "supplier" } });
      fireEvent.change(
        screen.getByLabelText("Importe de mercancía sin IVA recuperable", { exact: false }),
        { target: { value: "100" } },
      );
    } else {
      fireEvent.change(screen.getByLabelText("Concepto"), { target: { value: "Pagado" } });
      fireEvent.change(screen.getByLabelText("Total del gasto"), { target: { value: "100" } });
    }
    fireEvent.submit(screen.getByRole("button", { name: "Guardar registro" }).closest("form")!);
    await waitFor(() =>
      expect(mocks.action).toHaveBeenCalledWith(
        resource === "purchases" ? "purchase" : "expense",
        expect.objectContaining({ initial_payment: { account_id: "bank", date: "2026-11-15" } }),
        expect.any(String),
      ),
    );
    client.clear();
  },
);

it.each(["expenses", "purchases"])(
  "vincula un pago parcial desde el detalle de %s al documento correcto",
  async (resource) => {
    const doc = {
      id: "existing-doc",
      date: "2026-11-10",
      status: "active",
      concept: "Renta",
      category: "Renta",
      reference: "FAC-1",
      summary_cost_cents: "10000",
      total_cents: "11600",
      amount_cents: "10000",
      tax_cents: "1600",
      paid_cents: "2000",
      recovered_cents: "0",
    };
    const client = show(
      <Records resource={resource} from="2026-11-01" to="2026-12-01" />,
      { opening_done: true },
      (path) => (path === "/" + resource ? [doc] : []),
    );
    mocks.action.mockResolvedValue({ ok: true });
    fireEvent.click(await screen.findByRole("button", { name: "Ver / editar" }));
    const amount = screen.getByLabelText("Importe del pago") as HTMLInputElement;
    expect(amount.value).toBe("96.00");
    fireEvent.change(amount, { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Cuenta de pago"), { target: { value: "bank" } });
    fireEvent.change(screen.getByLabelText("Fecha del pago"), { target: { value: "2026-11-16" } });
    fireEvent.click(
      screen.getByRole("button", {
        name: resource === "expenses" ? "Guardar pago de gasto" : "Guardar pago de compra",
      }),
    );
    await waitFor(() =>
      expect(mocks.action).toHaveBeenCalledWith(
        "cash",
        expect.objectContaining({
          kind: resource === "expenses" ? "expense" : "purchase",
          [resource === "expenses" ? "expense_id" : "purchase_id"]: "existing-doc",
          account_id: "bank",
          amount: "50",
          date: "2026-11-16",
        }),
        expect.any(String),
      ),
    );
    const body = mocks.action.mock.calls[0]![1];
    expect(body[resource === "expenses" ? "purchase_id" : "expense_id"]).toBeUndefined();
    client.clear();
  },
);
