// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ClipSettlement } from "./clip-settlement";
import { estimateCardFee } from "@tienda/domain";
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
  gross_cents: "10000",
  clip_base_cents: "10000",
  clip_tip_cents: "0",
  clip_financing_cents: "0",
  clip_report_net_cents: "10000",
};
const fee_estimate = estimateCardFee("10000", [
  { method: "Crédito", percent: "2.99", fixed_cents: "100", tax_percent: "16" },
]);
function show(extra: any = {}) {
  const client = new QueryClient();
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <ClipSettlement
          income={{
            ...income,
            fee_estimate,
            fee_applied: true,
            fee_applied_cents: "463",
            fee_net_applied_cents: "9537",
            ...extra,
          }}
          onSuccess={() => {}}
        />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return client;
}
it.each(["debit_card", "credit_card"])(
  "muestra la comisión calculada de %s sin exigir conciliación ni crear depósitos",
  (method) => {
    const client = show({ method });
    expect(screen.getByText("Calculada según tarifa · aplicada en Clip")).toBeTruthy();
    expect(screen.getByText(/No necesitas conciliar cada cobro/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Efectivo" }).getAttribute("href")).toBe(
      "/app/efectivo",
    );
    expect(screen.queryByRole("button", { name: "Conciliar depósito" })).toBeNull();
    expect(screen.queryByText("Comisión y depósito pendientes de verificar.")).toBeNull();
    expect(mocks.action).not.toHaveBeenCalled();
    client.clear();
  },
);
it("permite aplicar una tarifa excepcional pendiente sin generar un depósito a Banco", async () => {
  mocks.action.mockResolvedValue({ applied_count: 1 });
  const client = show({
    fee_applied: false,
    fee_needs_apply: true,
    import_collection_id: "receipt",
  });
  fireEvent.click(screen.getByRole("button", { name: "Aplicar comisión a Clip" }));
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith("apply-card-fee", { id: "card" }, expect.any(String)),
  );
  expect(mocks.action.mock.calls.every((call) => call[0] !== "settle-clip")).toBe(true);
  client.clear();
});
it("conserva las liquidaciones históricas como información de solo lectura", () => {
  const client = show({
    settled_at: "2025-11-11",
    settlement_date: "2025-11-11",
    deposited_cents: "9537",
    fee_estimate: null,
  });
  expect(screen.getByText("Depósito conciliado")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Conciliar depósito" })).toBeNull();
  client.clear();
});
it("conserva el desglose MSI sin pedir conciliación por venta", () => {
  const raw = { Installment: "3", "Installment Type": "msi" };
  const quote = estimateCardFee(
    "100000",
    [
      { method: "Crédito", percent: "2.99", fixed_cents: "100", tax_percent: "16" },
      {
        method: "MSI",
        installments: 3,
        percent: "2.99",
        fixed_cents: "100",
        tax_percent: "16",
        msi_percent: "4.57",
      },
    ],
    raw,
  );
  const client = show({
    gross_cents: "100000",
    clip_financial_raw: raw,
    fee_estimate: quote,
    msi_fee_applied: true,
    fee_applied_cents: "8885",
    fee_net_applied_cents: "91115",
  });
  expect(screen.getByText(/Tarifa MSI 3 meses/)).toBeTruthy();
  const breakdown = screen.getByRole("region", { name: "Desglose de comisiones" });
  const item = (label: string) =>
    Array.from(breakdown.querySelectorAll("dt")).find((n) => n.textContent === label)
      ?.nextElementSibling?.textContent;
  expect(item("Comisión porcentual (2.99%)")).toBe("$29.90");
  expect(item("Cargo fijo")).toBe("$1.00");
  expect(item("IVA del procesamiento (16%)")).toBe("$4.94");
  expect(item("Recargo MSI de 3 meses (4.57%)")).toBe("$45.70");
  expect(item("IVA del recargo MSI (16%)")).toBe("$7.31");
  expect(item("Total de comisiones con IVA")).toBe("$88.85");
  expect(item("Neto después de comisiones")).toBe("$911.15");
  expect(screen.queryByRole("button", { name: "Conciliar depósito" })).toBeNull();
  expect(mocks.action).not.toHaveBeenCalled();
  client.clear();
});
