import { useEffect, useRef, useState, type ReactNode, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Search, X, ChevronLeft, ChevronRight, ArrowUpRight, LoaderCircle } from "lucide-react";
import { action } from "../lib/api";
export function Notice({ children, tone = "info" }: { children: ReactNode; tone?: string }) {
  return (
    <div className={"notice " + tone} role={tone === "error" ? "alert" : "status"}>
      {children}
    </div>
  );
}
export function Loading() {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={20} /> Cargando información…
    </div>
  );
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
export function MoneyInput({
  name,
  defaultValue = "",
  required = false,
  placeholder = "0.00",
}: {
  name: string;
  defaultValue?: string;
  required?: boolean;
  placeholder?: string;
}) {
  return (
    <input
      name={name}
      inputMode="decimal"
      type="number"
      min="0"
      step="0.01"
      max="999999999999.99"
      defaultValue={defaultValue}
      required={required}
      placeholder={placeholder}
    />
  );
}
export function Badge({ children, tone = "neutral" }: { children: ReactNode; tone?: string }) {
  return <span className={"badge " + tone}>{children}</span>;
}
export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <ArrowUpRight size={24} />
      <h3>{title}</h3>
      <p>{children ?? "Los registros aparecerán aquí cuando los agregues."}</p>
    </div>
  );
}
export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    ref.current?.showModal();
    const d = ref.current;
    const h = (e: Event) => {
      e.preventDefault();
      closeRef.current();
    };
    d?.addEventListener("cancel", h);
    return () => {
      d?.removeEventListener("cancel", h);
      d?.close();
    };
  }, []);
  return (
    <dialog ref={ref} aria-labelledby="dialog-title" className="modal">
      <header>
        <h2 id="dialog-title">{title}</h2>
        <button className="icon-button" aria-label="Cerrar" onClick={onClose}>
          <X size={20} />
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Capture({
  name,
  onSuccess,
  children,
  transform,
  submit = "Guardar registro",
}: {
  name: string;
  onSuccess: () => void;
  children: ReactNode;
  transform?: (values: any, form: HTMLFormElement) => any;
  submit?: string;
}) {
  const client = useQueryClient();
  const fingerprint = useRef("");
  const key = useRef(crypto.randomUUID());
  const mutation = useMutation({
    mutationFn: (body: any) => {
      const next = JSON.stringify(body);
      if (next !== fingerprint.current) {
        key.current = crypto.randomUUID();
        fingerprint.current = next;
      }
      return action(name, body, key.current);
    },
    onSuccess: () => {
      void client.invalidateQueries();
      onSuccess();
    },
  });
  function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setLocalError("");
    const form = e.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    try {
      mutation.mutate(transform ? transform(values, form) : values);
    } catch (err) {
      mutation.reset();
      setLocalError((err as Error).message);
    }
  }
  const [localError, setLocalError] = useState("");
  return (
    <form onSubmit={save} className="capture">
      {children}
      {(mutation.error || localError) && (
        <Notice tone="error">{mutation.error?.message ?? localError}</Notice>
      )}
      <footer>
        <span className="muted">Los cambios se guardan al confirmar.</span>
        <button className="button primary" disabled={mutation.isPending}>
          {mutation.isPending ? (
            <>
              <LoaderCircle size={16} className="spin" /> Guardando…
            </>
          ) : (
            submit
          )}
        </button>
      </footer>
    </form>
  );
}
export interface Column {
  key: string;
  label: string;
  render?: (row: any) => ReactNode;
  align?: "right";
  filterable?: boolean;
}
export function DataTable({
  rows,
  columns,
  empty = "Todavía no hay registros",
  onRow,
}: {
  rows: any[];
  columns: Column[];
  empty?: string;
  onRow?: (row: any) => void;
}) {
  const [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const [filters, setFilters] = useState<Record<string, string>>({});
  const filtered = rows.filter(
    (r) =>
      JSON.stringify(r).toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es")) &&
      Object.entries(filters).every(([key, value]) => !value || String(r[key] ?? "") === value),
  );
  const pages = Math.max(1, Math.ceil(filtered.length / 12));
  const current = Math.min(page, pages - 1);
  const visible = filtered.slice(current * 12, current * 12 + 12);
  return (
    <div className="table-panel">
      <div className="table-toolbar">
        <label className="search">
          <Search size={16} />
          <input
            aria-label="Buscar registros"
            placeholder="Buscar en los registros…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
          />
        </label>
        <div className="table-filters">
          {columns
            .filter((c) => c.filterable)
            .map((c) => (
              <select
                key={c.key}
                aria-label={"Filtrar por " + c.label}
                value={filters[c.key] ?? ""}
                onChange={(e) => {
                  setFilters({ ...filters, [c.key]: e.target.value });
                  setPage(0);
                }}
              >
                <option value="">{c.label}: todos</option>
                {[...new Set(rows.map((r) => String(r[c.key] ?? "")).filter(Boolean))]
                  .sort()
                  .map((v) => (
                    <option key={v}>{v}</option>
                  ))}
              </select>
            ))}
          <span className="muted">{filtered.length} registros</span>
        </div>
      </div>
      {!rows.length ? (
        <Empty title={empty} />
      ) : (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key} className={c.align ?? ""}>
                      {c.label}
                    </th>
                  ))}
                  {onRow && <th>Acciones</th>}
                </tr>
              </thead>
              <tbody>
                {visible.map((r, i) => (
                  <tr key={r.id ?? i}>
                    {columns.map((c) => (
                      <td key={c.key} className={c.align ?? ""}>
                        {c.render ? c.render(r) : (r[c.key] ?? "—")}
                      </td>
                    ))}
                    {onRow && (
                      <td>
                        <button className="text-button" onClick={() => onRow(r)}>
                          Ver / editar
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!visible.length && <Empty title="No hay coincidencias" />}
          <div className="pagination">
            <span>
              {filtered.length ? current * 12 + 1 : 0}–
              {Math.min((current + 1) * 12, filtered.length)} de {filtered.length}
            </span>
            <div>
              <button
                className="icon-button"
                aria-label="Página anterior"
                disabled={current === 0}
                onClick={() => setPage(current - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {current + 1} / {pages}
              </span>
              <button
                className="icon-button"
                aria-label="Página siguiente"
                disabled={current >= pages - 1}
                onClick={() => setPage(current + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
