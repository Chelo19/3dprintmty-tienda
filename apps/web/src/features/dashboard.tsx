import { Amount, MoneyLegend, type AmountEffect } from "../components/Amount";
import { FiscalCards } from "./tax";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowDownLeft,
  Wallet,
  ShoppingBag,
  Download,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { useState } from "react";
import type { Metric, Report } from "@tienda/shared";
import { api, download } from "../lib/api";
import { mxn, shortDate } from "../lib/format";
import { Badge, Notice, Loading, Empty } from "../components/ui";
export function Dashboard({ from, to }: { from: string; to: string }) {
  const {
    data: r,
    error,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["report", from, to],
    queryFn: () => api<Report>(`/report?from=${from}&to=${to}`),
  });
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api("/settings") });
  const [exportError, setExportError] = useState("");
  const duration = Date.parse(to) - Date.parse(from);
  const previousFrom = new Date(Date.parse(from) - duration).toISOString().slice(0, 10);
  const previous = useQuery({
    queryKey: ["report", previousFrom, from],
    queryFn: () => api<Report>(`/report?from=${previousFrom}&to=${from}`),
  });
  if (error)
    return (
      <Notice tone="error">
        {error.message}{" "}
        <button className="text-button" onClick={() => refetch()}>
          Reintentar
        </button>
      </Notice>
    );
  if (!r) return <Loading />;
  const warnings = r.financial?.warnings ?? [];
  const tiles: [string, Metric, any, string][] = [
    [
      "Cobros registrados",
      r.collected,
      ShoppingBag,
      "IVA incluido · incluye Clip por liquidar y descuenta devoluciones",
    ],
    [
      "Compras pagadas",
      r.sourceSummary?.purchases_paid ?? unavailable,
      ArrowDownLeft,
      "Pagos realizados en el periodo · IVA incluido",
    ],
    [
      "Gastos y activos pagados",
      r.sourceSummary?.expenses_paid ?? unavailable,
      ArrowDownLeft,
      "Pagos realizados en el periodo · IVA incluido",
    ],
    ["Flujo de caja disponible", r.cash, Wallet, "Entradas menos salidas en Efectivo y Banco"],
  ];
  const currentValue = r.collected.value;
  const previousValue = previous.data?.collected.value;
  const change =
    previousValue && currentValue && Number(previousValue) > 0
      ? ((Number(currentValue) / Number(previousValue) - 1) * 100).toFixed(1)
      : null;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">TU TIENDA, EN NÚMEROS</div>
          <h1>Resumen financiero</h1>
          <p>Cobros, pagos y movimientos de dinero de la tienda.</p>
        </div>
        <div className="heading-actions">
          <button
            className="button"
            onClick={() => void refetch()}
            aria-label="Actualizar dashboard"
          >
            <RefreshCw size={16} className={isFetching ? "spin" : ""} />
          </button>
          <button
            className="button"
            onClick={() => download("financial", from, to).catch((e) => setExportError(e.message))}
          >
            <Download size={16} /> Exportar
          </button>
          <Link className="button primary" to="/app/importaciones">
            Importar CSV de Clip <ArrowUpRight size={16} />
          </Link>
        </div>
      </div>
      {exportError && <Notice tone="error">{exportError}</Notice>}
      {!settings.data?.opening_done && (
        <div className="setup-banner">
          <div className="setup-icon">
            <Wallet size={24} />
          </div>
          <div>
            <strong>Todo empieza con una buena base</strong>
            <p>Registra tus saldos de apertura para comenzar a medir la tienda.</p>
          </div>
          <Link className="button primary" to="/app/configuracion">
            Configurar apertura <ArrowUpRight size={16} />
          </Link>
        </div>
      )}
      <MoneyLegend />
      <div className="section-top">
        <h2>Cobros y pagos del periodo</h2>
        <Badge tone={warnings.length ? "warning" : "success"}>
          {warnings.length ? <AlertCircle size={12} /> : <CheckCircle2 size={12} />}{" "}
          {warnings.length ? "Conciliación por revisar" : "Sin alertas de conciliación"}
        </Badge>
      </div>
      <div className="kpi-grid">
        {tiles.map(([label, m, Icon, sub], i) => (
          <article className={"kpi " + (i === 3 ? "highlight" : "")} key={label}>
            <div className="kpi-label">
              {label}
              <Icon size={18} />
            </div>
            <strong>
              <Amount
                value={m.value}
                effect={i === 0 ? "income" : i === 3 ? "signed" : "expense"}
                showSign
              />
            </strong>
            <div className="kpi-bottom">
              {m.value === null ? (
                <span>{m.reason ?? "Actualiza los datos del periodo."}</span>
              ) : (
                <span>{sub ?? "MXN · sin IVA"}</span>
              )}
              {i === 0 && change !== null && (
                <Badge tone={Number(change) >= 0 ? "success" : "warning"}>
                  {Number(change) >= 0 ? "+" : ""}
                  {change}%
                </Badge>
              )}
            </div>
          </article>
        ))}
      </div>
      {change !== null && (
        <p className="tiny muted">
          Comparación de cobros registrados contra los {Math.round(duration / 86400000)} días
          anteriores.
        </p>
      )}
      <Notice>
        Este resumen muestra movimientos de dinero, no utilidad contable. No requiere inventario ni
        capturar costos de lo vendido. Los cobros con tarjeta permanecen en Clip hasta su
        liquidación; las transferencias se registran en Banco y el efectivo en Efectivo. El flujo
        excluye saldos de apertura, aportaciones y retiros del propietario.
      </Notice>
      <FiscalCards report={r} financialOnly />
      <div className="dashboard-columns">
        <section className="panel trend-panel">
          <div className="panel-heading">
            <div>
              <h2>Evolución de la tienda</h2>
              <p>Flujo neto en Efectivo y Banco por mes · MXN</p>
            </div>
          </div>
          {r.financial?.months.length ? (
            <div
              className="bar-chart"
              role="img"
              aria-label="Flujo de caja disponible mensual en pesos mexicanos"
            >
              {r.financial.months.map((m) => {
                const max = Math.max(
                  ...r.financial!.months.map((x) => Math.abs(Number(x.cash))),
                  1,
                );
                return (
                  <div className="chart-column" key={m.month}>
                    <div className="bar-group">
                      <div
                        title={`Flujo de caja: ${mxn(m.cash)}`}
                        className={"bar " + (Number(m.cash) < 0 ? "negative" : "positive")}
                        style={{
                          height: `${Number(m.cash) === 0 ? 0 : Math.max(2, (Math.abs(Number(m.cash)) / max) * 150)}px`,
                        }}
                      />
                    </div>
                    <span>{m.month}</span>
                    <small>
                      <Amount value={m.cash} effect="signed" />
                    </small>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty title="Sin movimientos de dinero disponible en este periodo" />
          )}
          <p className="chart-caption">
            Movimientos confirmados · {shortDate(from)} al{" "}
            {shortDate(new Date(Date.parse(to) - 86400000).toISOString())}. Los importes negativos
            indican que salió más dinero del que entró.
          </p>
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Entradas y salidas de dinero</h2>
              <p>Composición del flujo en Efectivo y Banco · MXN</p>
            </div>
          </div>
          <div className="waterfall">
            {(r.financial?.movements ?? []).map((m) => (
              <div key={m.name}>
                <span>{m.name}</span>
                <strong>
                  <Amount value={m.amount} effect="signed" showSign />
                </strong>
              </div>
            ))}
            <div className="result-line">
              <span>Flujo de caja disponible</span>
              <strong>
                <Amount value={r.cash.value} effect="signed" />
              </strong>
            </div>
          </div>
          <p className="chart-caption">
            Incluye pagos, devoluciones, recuperaciones y depósitos netos de Clip. Las
            transferencias entre Efectivo y Banco se compensan; no crean ingresos.
          </p>
          <Link className="text-button" to="/app/efectivo">
            Revisar movimientos <ArrowUpRight size={14} />
          </Link>
        </section>
      </div>
      <div className="dashboard-columns">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Cobros por categoría</h2>
              <p>Clasificación disponible en los ingresos · IVA incluido</p>
            </div>
          </div>
          {r.categories.length ? (
            <div className="category-list">
              {r.categories.map((c) => (
                <div key={c.name}>
                  <span>{c.name}</span>
                  <strong>
                    <Amount value={c.collected} effect="income" />
                  </strong>
                </div>
              ))}
            </div>
          ) : (
            <Empty title="Sin cobros en este periodo" />
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Conciliación del dinero</h2>
              <p>Depósitos, devoluciones y recuperaciones por revisar</p>
            </div>
          </div>
          {warnings.length ? (
            <ul className="quality-list">
              {warnings.map((w) => (
                <li key={w}>
                  <AlertCircle size={16} />
                  {w}
                </li>
              ))}
            </ul>
          ) : (
            <div className="quality-ok">
              <CheckCircle2 size={24} />
              <strong>Sin pendientes de conciliación</strong>
              <p>
                No se detectaron alertas en los movimientos del periodo. La comprobación fiscal se
                revisa por separado.
              </p>
            </div>
          )}
          <Link className="text-button" to="/app/ingresos">
            Revisar ingresos <ArrowUpRight size={14} />
          </Link>
        </section>
      </div>
      <div className="dashboard-columns">
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Gastos por categoría</h2>
              <p>
                Costos reconocidos sin IVA recuperable; pueden incluir gastos aún no pagados · MXN
              </p>
            </div>
          </div>
          <MetricBars
            effect="expense"
            rows={r.expenseCategories}
            empty="Sin gastos en este periodo"
          />
        </section>
        <section className="panel">
          <div className="panel-heading">
            <div>
              <h2>Métodos de pago</h2>
              <p>Cobros menos devoluciones del periodo · MXN</p>
            </div>
          </div>
          <MetricBars effect="income" rows={r.payments} empty="Sin cobros en este periodo" />
        </section>
      </div>
      <div className="dashboard-columns">
        <section className="panel">
          <div className="panel-heading">
            <h2>Compras recientes</h2>
            <Link to="/app/compras">
              Ver todas <ArrowUpRight size={14} />
            </Link>
          </div>
          {r.recentPurchases.length ? (
            r.recentPurchases.map((p) => (
              <div className="recent-row" key={p.id}>
                <div>
                  <strong>{p.supplier}</strong>
                  <small>
                    {p.reference || "Sin referencia"} · {shortDate(p.date)}
                  </small>
                </div>
                <strong>
                  <Amount value={p.total_cents} cents />
                </strong>
              </div>
            ))
          ) : (
            <Empty title="Sin compras en este periodo" />
          )}
        </section>
        <section className="panel">
          <div className="panel-heading">
            <h2>Gastos recientes · IVA incluido</h2>
            <Link to="/app/gastos">
              Ver todos <ArrowUpRight size={14} />
            </Link>
          </div>
          {r.recentExpenses.length ? (
            r.recentExpenses.map((e) => (
              <div className="recent-row" key={e.id}>
                <div>
                  <strong>{e.concept}</strong>
                  <small>
                    {e.category} · {shortDate(e.date)}
                  </small>
                </div>
                <strong>
                  <Amount
                    value={
                      e.total_cents ??
                      (BigInt(e.amount_cents) + BigInt(e.tax_cents ?? 0)).toString()
                    }
                    cents
                    effect="expense"
                  />
                </strong>
              </div>
            ))
          ) : (
            <Empty title="Sin gastos en este periodo" />
          )}
        </section>
      </div>
    </>
  );
}

const unavailable: Metric = {
  value: null,
  status: "no_disponible",
  reason: "Actualiza el resumen financiero.",
};

function MetricBars({
  rows,
  empty,
  effect = "neutral",
}: {
  rows: any[];
  empty: string;
  effect?: AmountEffect;
}) {
  const max = Math.max(...rows.map((r) => Math.abs(Number(r.amount))), 1);
  return rows.length ? (
    <div className="metric-bars">
      {rows.map((r) => (
        <div key={r.name}>
          <div>
            <span>{r.name}</span>
            <strong>
              <Amount value={r.amount} effect={effect} />
            </strong>
          </div>
          <div className="metric-track">
            <span
              style={{
                width: (Math.abs(Number(r.amount)) / max) * 100 + "%",
                background:
                  Number(r.amount) < 0 || effect === "expense"
                    ? "var(--money-negative)"
                    : effect === "income"
                      ? "var(--money-positive)"
                      : undefined,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  ) : (
    <Empty title={empty} />
  );
}
