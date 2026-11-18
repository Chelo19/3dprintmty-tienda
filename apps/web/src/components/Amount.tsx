import { Decimal } from "@tienda/domain";
import { money, mxn } from "../lib/format";

export type AmountEffect = "income" | "expense" | "signed" | "neutral";
export function Amount({
  value,
  cents = false,
  effect = "neutral",
  showSign = false,
}: {
  value: string | number | null | undefined;
  cents?: boolean;
  effect?: AmountEffect;
  showSign?: boolean;
}) {
  const n = value == null ? null : new Decimal(String(value));
  const tone =
    !n || n.isZero()
      ? "muted"
      : n.isNegative() || effect === "expense"
        ? "negative"
        : effect === "income" || effect === "signed"
          ? "positive"
          : "neutral";
  const display = n && showSign && effect === "expense" ? n.abs().neg().toString() : value;
  const prefix =
    n?.isPositive() && showSign && (effect === "income" || effect === "signed") ? "+" : "";
  return (
    <span className={"money-value money-" + tone}>
      {prefix}
      {cents ? money(display) : mxn(display)}
    </span>
  );
}

export function MoneyLegend() {
  return (
    <p className="money-legend" aria-label="Código de colores de importes">
      <span className="money-positive">+ Verde: suma / a favor</span>
      <span className="money-negative">− Rojo: resta / cargos</span>
      <span className="money-neutral">Negro: totales y saldos</span>
      <span className="money-muted">Gris: cero o pendiente</span>
    </p>
  );
}
