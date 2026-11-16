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
} from "./index";
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
