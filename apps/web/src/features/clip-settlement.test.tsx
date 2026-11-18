// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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
  gross_cents: "33781",
  clip_base_cents: "30100",
  clip_tip_cents: "0",
  clip_financing_cents: "3681",
  clip_report_net_cents: "30100",
};
it.each(["debit_card", "credit_card"])(
  "precarga la misma tarifa para %s, sin registrar dinero hasta confirmar",
  async (method) => {
    const client = new QueryClient(),
      done = vi.fn();
    mocks.action.mockResolvedValue({ settled: true });
    const fee_estimate = estimateCardFee("10000", [
      { method: "Crédito", percent: "2.99", fixed_cents: "100", tax_percent: "16" },
    ]);
    render(
      <QueryClientProvider client={client}>
        <ClipSettlement
          income={{
            ...income,
            method,
            gross_cents: "10000",
            clip_financing_cents: "0",
            fee_estimate,
          }}
          onSuccess={done}
        />
      </QueryClientProvider>,
    );
    expect(screen.getByText(/Tarifa predeterminada para débito y crédito/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Conciliar depósito" }));
    const value = (label: string) =>
      (screen.getByLabelText(label, { exact: false }) as HTMLInputElement).value;
    expect(value("Comisión de procesamiento retenida, IVA incluido")).toBe("4.63");
    expect(value("Financiamiento retenido, IVA incluido")).toBe("0.00");
    expect(value("IVA de los cargos")).toBe("0.64");
    expect(value("Depósito neto de esta transacción")).toBe("95.37");
    expect(mocks.action).not.toHaveBeenCalled();
    fireEvent.input(screen.getByLabelText("Referencia del estado de cuenta o liquidación"), {
      target: { value: "Liquidación Clip confirmada" },
    });
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Confirmar conciliación y registrar depósito" })
        .closest("form")!,
    );
    await waitFor(() =>
      expect(mocks.action).toHaveBeenCalledWith(
        "settle-clip",
        expect.objectContaining({
          processing_fee: "4.63",
          financing_withheld: "0.00",
          creditable_tax: "0.64",
          deposited: "95.37",
        }),
        expect.any(String),
      ),
    );
    client.clear();
  },
);
it("el financiamiento adicional exige revisión y permite corregir la tarifa calculada", () => {
  const client = new QueryClient();
  const fee_estimate = estimateCardFee(income.gross_cents, [
    { method: "Crédito", percent: "2.99", fixed_cents: "100", tax_percent: "16" },
  ]);
  render(
    <QueryClientProvider client={client}>
      <ClipSettlement income={{ ...income, fee_estimate }} onSuccess={() => {}} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Conciliar depósito" }));
  expect(
    (
      screen.getByLabelText("Financiamiento retenido, IVA incluido", {
        exact: false,
      }) as HTMLInputElement
    ).value,
  ).toBe("");
  expect(
    (screen.getByLabelText("Depósito neto de esta transacción") as HTMLInputElement).value,
  ).toBe("");
  fireEvent.input(screen.getByLabelText("Comisión de procesamiento retenida, IVA incluido"), {
    target: { value: "10" },
  });
  expect(
    (screen.getByLabelText("Comisión de procesamiento retenida, IVA incluido") as HTMLInputElement)
      .value,
  ).toBe("10");
  client.clear();
});
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
  set("IVA de los cargos", "1.38");
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
it("muestra el neto y la comisión ya descontada de Clip sin ofrecer aplicarla de nuevo", () => {
  const client = new QueryClient();
  const fee_estimate = estimateCardFee("10000", [
    { method: "Crédito", percent: "2.99", fixed_cents: "100", tax_percent: "16" },
  ]);
  render(
    <QueryClientProvider client={client}>
      <ClipSettlement
        income={{
          ...income,
          gross_cents: "10000",
          clip_financing_cents: "0",
          fee_estimate,
          fee_applied: true,
          import_collection_id: "receipt",
        }}
        onSuccess={() => {}}
      />
    </QueryClientProvider>,
  );
  expect(screen.getByText(/Comisión con IVA ya descontada de Clip/).textContent).toContain("$4.63");
  expect(screen.getByText(/Neto registrado de este cobro en Clip/).textContent).toContain("$95.37");
  expect(screen.queryByRole("button", { name: "Aplicar comisión a Clip" })).toBeNull();
  expect(mocks.action).not.toHaveBeenCalled();
  client.clear();
});
it("precarga procesamiento y financiamiento de la tarifa MSI de 3 meses aunque el diferimiento sea cero", () => {
  const client = new QueryClient();
  const raw = { Installment: "3", "Installment Type": "MSI" };
  const fee_estimate = estimateCardFee(
    "100000",
    [
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
  render(
    <QueryClientProvider client={client}>
      <ClipSettlement
        income={{
          ...income,
          gross_cents: "100000",
          clip_financing_cents: "0",
          clip_financial_raw: raw,
          fee_estimate,
          fee_applied: true,
          fee_applied_cents: "8885",
          fee_net_applied_cents: "91115",
        }}
        onSuccess={() => {}}
      />
    </QueryClientProvider>,
  );
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
  fireEvent.click(screen.getByRole("button", { name: "Conciliar depósito" }));
  const value = (label: string) =>
    (screen.getByLabelText(label, { exact: false }) as HTMLInputElement).value;
  expect(value("Comisión de procesamiento retenida, IVA incluido")).toBe("35.84");
  expect(value("Financiamiento retenido, IVA incluido")).toBe("53.01");
  expect(value("IVA de los cargos")).toBe("12.25");
  expect(value("Depósito neto de esta transacción")).toBe("911.15");
  expect(mocks.action).not.toHaveBeenCalled();
  client.clear();
});
