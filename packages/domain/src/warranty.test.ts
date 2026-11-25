import { describe, it, expect } from "vitest";
import { warrantyDetails, warrantyExpiry } from "./warranty";
describe("Vigencia por meses calendario", () => {
  it("calcula cambios de año, meses cortos y años bisiestos sin desbordar al mes siguiente", () => {
    expect(warrantyExpiry("2026-11-23", 12)).toBe("2027-11-23");
    expect(warrantyExpiry("2026-01-31", 1)).toBe("2026-02-28");
    expect(warrantyExpiry("2024-01-31", 1)).toBe("2024-02-29");
    expect(warrantyExpiry("2024-02-29", 12)).toBe("2025-02-28");
  });
  it("distingue impresoras sin asignar y datos históricos incompletos", () => {
    expect(warrantyDetails(null, 12, false, "2026-11-23")).toMatchObject({
      warranty_status: "Sin asignar",
      warranty_end: null,
      days_remaining: null,
    });
    expect(warrantyDetails("2026-11-23", null, true, "2026-11-23")).toMatchObject({
      warranty_status: "Vigencia por definir",
      warranty_end: null,
    });
  });
  it("no inicia garantía de una impresora vendida pero sin fecha de factura", () => {
    expect(warrantyDetails(null, 12, true, "2026-11-23")).toMatchObject({
      warranty_status: "Pendiente de facturar",
      warranty_end: null,
      days_remaining: null,
    });
  });
  it("incluye el día de vencimiento, avisa a 30 días y detecta inicios futuros", () => {
    expect(warrantyDetails("2026-01-31", 1, true, "2026-01-01").warranty_status).toBe(
      "Por iniciar",
    );
    expect(warrantyDetails("2026-01-31", 12, true, "2026-11-23").warranty_status).toBe("Vigente");
    expect(warrantyDetails("2026-01-31", 1, true, "2026-02-28")).toMatchObject({
      warranty_status: "Por vencer",
      days_remaining: 0,
    });
    expect(warrantyDetails("2026-01-31", 1, true, "2026-03-01").warranty_status).toBe("Vencida");
  });
  it("rechaza fechas imposibles y duraciones fraccionadas o fuera de rango", () => {
    expect(() => warrantyExpiry("2026-02-30", 1)).toThrow();
    for (const months of [0, -1, 1.5, 121])
      expect(() => warrantyExpiry("2026-11-23", months)).toThrow();
  });
  it("inicia desde la venta si no se facturará, manteniendo la factura como base en los demás casos", () => {
    expect(warrantyDetails(null, 12, true, "2026-11-23", false, "2026-11-01")).toMatchObject({
      warranty_end: "2027-11-01",
      warranty_status: "Vigente",
    });
    expect(warrantyDetails(null, 12, false, "2026-11-23", false, null)).toMatchObject({
      warranty_status: "Sin asignar",
      warranty_end: null,
    });
    expect(
      warrantyDetails("2026-11-15", 12, true, "2026-11-23", true, "2026-11-01").warranty_end,
    ).toBe("2027-11-15");
  });
});
