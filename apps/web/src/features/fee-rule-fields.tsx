import { useState } from "react";
import { defaultCardFeeRule } from "@tienda/domain";
import { Field, MoneyInput, Notice } from "../components/ui";
import { amount } from "../lib/format";

export function FeeRuleFields({
  rules,
  initial,
}: {
  rules: any[];
  initial?: { method: string; installments?: number | null };
}) {
  const [method, setMethod] = useState(initial?.method ?? "Tarjeta");
  const [term, setTerm] = useState(String(initial?.installments ?? 3));
  const selected = rules.find(
    (r) => r.method === method && (method !== "MSI" || r.installments === Number(term)),
  );
  const base = selected ?? defaultCardFeeRule(rules);
  return (
    <>
      <div className="form-grid">
        <Field label="Método">
          <select name="method" value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="Tarjeta">Tarjeta (débito y crédito)</option>
            <option>Débito</option>
            <option>Crédito</option>
            <option>MSI</option>
            <option>SPEI</option>
            <option>Efectivo</option>
          </select>
        </Field>
        {method === "MSI" && (
          <Field
            label="Plazo MSI (meses)"
            hint="Cada plazo guarda su propia tarifa; puedes configurar 3, 6, 9, 12 u otro."
          >
            <input
              type="number"
              name="installments"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              min="2"
              max="120"
              step="1"
              list="msi-terms"
              required
            />
            <datalist id="msi-terms">
              {[3, 6, 9, 12, 18, 24].map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </Field>
        )}
      </div>
      <div className="form-grid" key={method + ":" + term}>
        <Field label="Porcentaje base">
          <input
            name="percent"
            type="number"
            min="0"
            max="100"
            step="0.0001"
            defaultValue={base?.percent ?? "0"}
            required
          />
        </Field>
        <Field label="Comisión fija">
          <MoneyInput name="fixed" defaultValue={amount(base?.fixed_cents ?? "0")} required />
        </Field>
        <Field label="IVA sobre comisión %">
          <input
            name="tax_percent"
            type="number"
            min="0"
            max="100"
            step="0.0001"
            defaultValue={base?.tax_percent ?? "0"}
            required
          />
        </Field>
        {method === "MSI" ? (
          <Field
            label="Recargo MSI %"
            hint="Adicional al porcentaje base y cargo fijo. Se calcula su IVA por separado."
          >
            <input
              name="msi_percent"
              type="number"
              min="0"
              max="100"
              step="0.0001"
              defaultValue={selected?.msi_percent ?? ""}
              required
            />
          </Field>
        ) : (
          <input type="hidden" name="msi_percent" value="0" />
        )}
      </div>
      {method === "MSI" && (
        <Notice>
          Esta tarifa corresponde únicamente a {term || "—"} meses. No se reutiliza en otros plazos.
          El recargo MSI se descuenta de Clip además de la comisión de procesamiento, conservando el
          total cobrado al cliente.
        </Notice>
      )}
    </>
  );
}
