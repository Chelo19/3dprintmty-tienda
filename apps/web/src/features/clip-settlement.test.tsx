// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ClipSettlement } from "./clip-settlement";
const mocks = vi.hoisted(() => ({ action: vi.fn() }));
vi.mock("../lib/api", () => mocks);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const income = {
  id: "card",
  source: "clip_import",
  status: "active",
  channel: "clip",
  gross_cents: "33781",
  clip_base_cents: "30100",
  clip_tip_cents: "0",
  clip_financing_cents: "3681",
  clip_report_net_cents: "30100",
};
it("muestra los importes originales y permite conciliar con cargos y depósito explícitos", async () => {
  mocks.action.mockResolvedValue({ settled: true });
  const done = vi.fn(),
    client = new QueryClient();
  render(
    <QueryClientProvider client={client}>
      <ClipSettlement income={income} onSuccess={done} />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Total cobrado al cliente")).toBeTruthy();
  expect(screen.getByText(/Comisión y depósito pendientes/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Conciliar depósito" }));
  const set = (label: string, value: string) =>
    fireEvent.input(screen.getByLabelText(label, { exact: false }), { target: { value } });
  set("Comisión de procesamiento retenida, IVA incluido", "10");
  set("Financiamiento retenido, IVA incluido", "36.81");
  set("IVA acreditable documentado de los cargos", "1.38");
  set("Depósito neto de esta transacción", "291.01");
  expect(screen.getByRole("alert").textContent).toContain("-$0.01");
  set("Depósito neto de esta transacción", "291.00");
  expect(screen.queryByRole("alert")).toBeNull();
  set("Referencia del estado de cuenta o liquidación", "Liquidación 123");
  fireEvent.submit(
    screen
      .getByRole("button", { name: "Confirmar conciliación y registrar depósito" })
      .closest("form")!,
  );
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "settle-clip",
      expect.objectContaining({
        id: "card",
        processing_fee: "10",
        financing_withheld: "36.81",
        deposited: "291.00",
        creditable_tax: "1.38",
      }),
      expect.any(String),
    ),
  );
  expect(done).toHaveBeenCalledOnce();
  client.clear();
});
it("el efectivo no genera depósitos y una liquidación conciliada no ofrece volver a registrar", () => {
  const { rerender } = render(
    <ClipSettlement income={{ ...income, channel: "cash" }} onSuccess={() => {}} />,
  );
  expect(screen.queryByRole("button", { name: "Conciliar depósito" })).toBeNull();
  rerender(
    <ClipSettlement
      income={{
        ...income,
        settled_at: "2025-11-11",
        settlement_date: "2025-11-11",
        deposited_cents: "29100",
      }}
      onSuccess={() => {}}
    />,
  );
  expect(screen.getByText("Depósito conciliado")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Conciliar depósito" })).toBeNull();
});
