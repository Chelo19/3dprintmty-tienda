import { describe, it, expect } from "vitest";
import {
  cents,
  major,
  allocate,
  outflowCost,
  lineCost,
  margin,
  monthBounds,
  localDate,
  estimateCardFee,
  defaultCardFeeRule,
  cardInstallmentPlan,
} from "./index";
describe("Tarifa predeterminada de tarjeta", () => {
  const rule = { method: "Crédito", percent: "2.9900", fixed_cents: "100", tax_percent: "16.0000" };
  it("identifica MSI aunque el diferimiento del reporte sea cero y exige la tarifa del plazo exacto", () => {
    const msi = { ...rule, method: "MSI", installments: 3, msi_percent: "4.57" };
    const raw = { Installment: "3", "Installment Type": "MSI", "Deferral Comission": "0.00" };
    expect(cardInstallmentPlan(raw)).toMatchObject({
      msi: true,
      installments: 3,
      needsReview: false,
    });
    expect(estimateCardFee("100000", [rule, msi], raw)).toMatchObject({
      processing_cents: "3584",
      financing_cents: "5301",
      tax_cents: "1225",
      total_cents: "8885",
      deposited_cents: "91115",
    });
    expect(estimateCardFee("100000", [rule, msi], { ...raw, Installment: "6" })).toBeNull();
    expect(estimateCardFee("100000", [rule, { ...msi, installments: null }], raw)).toBeNull();
    expect(
      estimateCardFee("100000", [rule, msi], { ...raw, "Installment Type": "deferred_payment" }),
    ).toBeNull();
    expect(estimateCardFee("100000", [rule, msi], { ...raw, Installment: "1" })).toBeNull();
  });
  it("calcula porcentaje, cargo fijo e IVA al centavo y conserva el total", () => {
    expect(estimateCardFee("10000", [rule])).toMatchObject({
      base_cents: "399",
      tax_cents: "64",
      processing_cents: "463",
      deposited_cents: "9537",
    });
    expect(estimateCardFee("33781", [rule])).toMatchObject({
      base_cents: "1110",
      tax_cents: "178",
      processing_cents: "1288",
      deposited_cents: "32493",
    });
    expect(estimateCardFee("1", [rule])?.deposited_cents).toBeNull();
  });
  it("reutiliza una sola tarifa existente de débito o crédito para todas las tarjetas", () => {
    expect(defaultCardFeeRule([rule])?.method).toBe("Crédito");
    expect(defaultCardFeeRule([{ ...rule, method: "Débito" }])?.percent).toBe("2.9900");
    expect(estimateCardFee("10000", [{ ...rule, method: "Efectivo" }])).toBeNull();
  });
  it("la tarifa común tiene prioridad y no elige arbitrariamente entre tarifas distintas", () => {
    const debit = { ...rule, method: "Débito", percent: "2" };
    expect(defaultCardFeeRule([rule, debit])).toBeUndefined();
    expect(
      defaultCardFeeRule([rule, { ...rule, method: "Débito", percent: "2.99" }])?.percent,
    ).toBe("2.9900");
    expect(
      defaultCardFeeRule([rule, debit, { ...rule, method: "Tarjeta", percent: "3" }])?.percent,
    ).toBe("3");
  });
});
describe("Dinero y valuación", () => {
  it("no pierde centavos ni acepta precisión implícita", () => {
    expect(cents("0.29")).toBe(29n);
    expect(major(9007199254740993n)).toBe("90071992547409.93");
    expect(() => cents("1.001")).toThrow();
  });
  it("conserva el prorrateo con residuos", () => {
    expect(allocate(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(() => allocate(1n, [0n])).toThrow();
  });
  it("valúa por promedio y bloquea negativos", () => {
    expect(outflowCost("3", "10", 101n)).toBe(30n);
    expect(outflowCost("10", "10", 101n)).toBe(101n);
    expect(() => outflowCost("11", "10", 101n)).toThrow();
  });
  it("separa descuento y redondeo de costo unitario", () => {
    expect(lineCost("3", "10.125", "0.38")).toBe(3000n);
    expect(() => lineCost("1", "1", "2")).toThrow();
  });
  it("no inventa margen y usa fecha local", () => {
    expect(margin(null, 100n)).toBeNull();
    expect(margin(20n, 0n)).toBeNull();
    expect(monthBounds("2026-12").to).toBe("2027-01-01");
    expect(localDate("2026-11-01T03:00:00Z")).toBe("2026-10-31");
  });
});
