import { TaxPage } from "./features/tax";
import { useEffect, useState, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { NavLink, Routes, Route, Navigate, useLocation, Link } from "react-router-dom";
import {
  LayoutDashboard,
  ArrowDownLeft,
  ShoppingCart,
  ReceiptText,
  Truck,
  Wallet,
  FileBarChart2,
  CalendarCheck,
  Settings as SettingsIcon,
  LogOut,
  Menu,
  X,
  ChevronDown,
  ShieldCheck,
  LoaderCircle,
} from "lucide-react";
import { monthBounds } from "@tienda/domain";
import { api, setToken, token, supabase, setupAuth } from "./lib/api";
import { today } from "./lib/format";
import { authConfigKey, clearPrivateQueries } from "./lib/auth-cache";
import { Notice, Loading } from "./components/ui";
import { Dashboard } from "./features/dashboard";
import { Records } from "./features/records";
import { Imports } from "./features/imports";
import { Cash, Reports, Closes, Settings } from "./features/operations";
const groups = [
  {
    label: "PANORAMA",
    items: [
      ["", "Resumen", LayoutDashboard],
      ["ingresos", "Ingresos", ArrowDownLeft],
      ["importaciones", "Datos de Clip", CloudIcon],
    ],
  },
  {
    label: "OPERACIÓN",
    items: [
      ["compras", "Compras", ShoppingCart],
      ["gastos", "Gastos", ReceiptText],
      ["proveedores", "Proveedores", Truck],
      ["efectivo", "Efectivo", Wallet],
    ],
  },
  {
    label: "ANÁLISIS",
    items: [
      ["reportes", "Reportes", FileBarChart2],
      ["impuestos", "Impuestos y costos", ReceiptText],
      ["cierres", "Cierre mensual", CalendarCheck],
    ],
  },
] as const;
function CloudIcon(props: any) {
  return <ArrowDownLeft {...props} />;
}
export function App() {
  const [ready, setReady] = useState(false),
    [authenticated, setAuthenticated] = useState(!!token),
    [authError, setAuthError] = useState("");
  const config = useQuery({
    queryKey: authConfigKey,
    queryFn: ({ signal }) => api("/auth/config", { signal }),
    staleTime: Infinity,
  });
  const sessionToken = useRef(token);
  const client = useQueryClient();
  useEffect(() => {
    let active = true;
    if (config.data)
      void setupAuth(config.data)
        .then(() => {
          if (!active) return;
          sessionToken.current = token;
          setAuthenticated(!!token);
          setReady(true);
        })
        .catch((e) => {
          if (active) setAuthError(e.message);
        });
    return () => {
      active = false;
    };
  }, [config.data]);
  useEffect(() => {
    const update = () => {
      const previous = sessionToken.current;
      sessionToken.current = token;
      setAuthenticated(!!token);
      if (previous && !token) void clearPrivateQueries(client);
    };
    window.addEventListener("tienda-auth", update);
    return () => window.removeEventListener("tienda-auth", update);
  }, [client]);
  if (config.error)
    return (
      <main className="login">
        <Notice tone="error">
          No se pudo conectar con la API. Verifica que esté iniciada.{" "}
          <button onClick={() => void config.refetch()}>Reintentar</button>
        </Notice>
      </main>
    );
  if (authError) return <Notice tone="error">{authError}</Notice>;
  if (!ready) return <Loading />;
  return authenticated ? (
    <Shell
      onLogout={async () => {
        if (supabase) await supabase.auth.signOut();
        setToken("");
        sessionToken.current = "";
        setAuthenticated(false);
        await clearPrivateQueries(client);
      }}
    />
  ) : (
    <Login local={config.data?.local} onLogin={() => setAuthenticated(true)} />
  );
}
function Login({ local, onLogin }: { local: boolean; onLogin: () => void }) {
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  return (
    <main className="login">
      <section className="login-story">
        <Link to="/" className="brand">
          3dprintmty<span>TIENDA</span>
        </Link>
        <div>
          <div className="eyebrow">CLARIDAD PARA CRECER</div>
          <h1>
            Conoce lo que
            <br />
            tu tienda genera.
          </h1>
          <p>
            Ventas, costos y efectivo en un solo lugar.
            <br />
            Cada decisión empieza con números confiables.
          </p>
          <div className="login-features">
            <span>
              <ShieldCheck size={18} /> Acceso privado
            </span>
            <span>
              <FileBarChart2 size={18} /> Información financiera
            </span>
          </div>
        </div>
        <small>Control comercial · Monterrey, México</small>
      </section>
      <section className="login-form">
        <div className="eyebrow">BIENVENIDO A TU TIENDA</div>
        <h2>Iniciar sesión</h2>
        <p className="muted">Acceso exclusivo para el propietario autorizado.</p>
        {error && <Notice tone="error">{error}</Notice>}
        {local ? (
          <>
            <Notice>
              Entorno de desarrollo local. Los datos permanecen en esta computadora; Supabase se
              activarán al configurar sus conexiones.
            </Notice>
            <button
              className="button primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const result = await api("/auth/local", { method: "POST" });
                  setToken(result.token);
                  onLogin();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <LoaderCircle size={18} className="spin" /> : null} Abrir entorno local
            </button>
          </>
        ) : (
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              const values = new FormData(e.currentTarget);
              try {
                if (!supabase) throw new Error("Configura Supabase Auth en el servidor.");
                const { data, error } = await supabase.auth.signInWithPassword({
                  email: String(values.get("email")),
                  password: String(values.get("password")),
                });
                if (error)
                  throw new Error("No se pudo iniciar sesión. Revisa tu correo y contraseña.");
                setToken(data.session?.access_token ?? "");
                onLogin();
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label className="field">
              <span>Correo</span>
              <input type="email" name="email" autoComplete="username" required />
            </label>
            <label className="field">
              <span>Contraseña</span>
              <input type="password" name="password" autoComplete="current-password" required />
            </label>
            <button className="button primary" disabled={busy}>
              {busy ? "Iniciando sesión…" : "Entrar"}
            </button>
          </form>
        )}
        <p className="tiny muted">
          Clip administra tu punto de venta. Tienda te ayuda a entender su resultado.
        </p>
      </section>
    </main>
  );
}
function Shell({ onLogout }: { onLogout: () => Promise<void> }) {
  const [month, setMonth] = useState(today().slice(0, 7)),
    [custom, setCustom] = useState(false),
    [range, setRange] = useState(monthBounds(month)),
    [mobile, setMobile] = useState(false),
    [logoutError, setLogoutError] = useState("");
  const location = useLocation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: () => api("/settings") });
  useEffect(() => {
    setMobile(false);
  }, [location.pathname]);
  const { from, to } = custom ? range : monthBounds(month);
  return (
    <div className="shell">
      <aside className={"sidebar " + (mobile ? "mobile-open" : "")}>
        <div className="brand-line">
          <Link to="/app" className="brand">
            3dprintmty<span>TIENDA</span>
          </Link>
          <button
            className="icon-button mobile-only"
            aria-label="Cerrar menú"
            onClick={() => setMobile(false)}
          >
            <X size={20} />
          </button>
        </div>
        <div className="workspace-label">
          <span className="workspace-avatar">3D</span>
          <div>
            <strong>Tienda Monterrey</strong>
            <small>Control financiero</small>
          </div>
        </div>
        <nav aria-label="Navegación principal">
          {groups.map((g) => (
            <div className="nav-group" key={g.label}>
              <span className="nav-label">{g.label}</span>
              {g.items.map(([path, label, Icon]) => (
                <NavLink key={path} to={"/app" + (path ? "/" + path : "")} end>
                  <Icon size={18} />
                  <span>{label}</span>
                  {path === "importaciones" && <span className="nav-dot" />}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <NavLink className="settings-link" to="/app/configuracion">
            <SettingsIcon size={18} /> Configuración
          </NavLink>
          <div className="user-card">
            <span className="avatar">MD</span>
            <div>
              <strong>Mi tienda</strong>
              <small>{settings.data?.owner_email ?? "Propietario"}</small>
            </div>
            <button
              className="icon-button"
              aria-label="Cerrar sesión"
              onClick={() => onLogout().catch((e) => setLogoutError(e.message))}
            >
              <LogOut size={17} />
            </button>
          </div>
          <small className="version">3dprintmty Tienda · v0.1.0</small>
        </div>
      </aside>
      {mobile && (
        <button
          className="sidebar-backdrop"
          aria-label="Cerrar navegación"
          onClick={() => setMobile(false)}
        />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-only"
              aria-label="Abrir menú"
              onClick={() => setMobile(true)}
            >
              <Menu size={21} />
            </button>
            <span>Tienda</span>
            <span className="slash">/</span>
            <strong>
              {location.pathname === "/app"
                ? "Resumen financiero"
                : location.pathname.split("/").at(-1)?.replaceAll("-", " ")}
            </strong>
          </div>
          <div className="topbar-right">
            <BadgeLocal local={settings.data?.local} />
            <span className="currency">MXN</span>
            <span className="avatar small">MD</span>
          </div>
        </header>
        <main className="main">
          {logoutError && <Notice tone="error">{logoutError}</Notice>}
          <div className="period-bar">
            <div>
              <span className="period-dot" /> Información de tu tienda{" "}
              <span className="muted period-zone">· America/Monterrey</span>
            </div>
            <div className="period-controls">
              <select
                aria-label="Tipo de periodo"
                value={custom ? "custom" : "month"}
                onChange={(e) => {
                  setCustom(e.target.value === "custom");
                  setRange(monthBounds(month));
                }}
              >
                <option value="month">Mes</option>
                <option value="custom">Rango personalizado</option>
              </select>
              {custom ? (
                <>
                  <input
                    aria-label="Fecha inicial"
                    type="date"
                    value={range.from}
                    onChange={(e) =>
                      e.target.value &&
                      e.target.value < range.to &&
                      setRange({ ...range, from: e.target.value })
                    }
                  />
                  <input
                    aria-label="Fecha final exclusiva"
                    title="Fecha final exclusiva"
                    type="date"
                    value={range.to}
                    onChange={(e) =>
                      e.target.value &&
                      e.target.value > range.from &&
                      setRange({ ...range, to: e.target.value })
                    }
                  />
                </>
              ) : (
                <input
                  aria-label="Mes de consulta"
                  type="month"
                  value={month}
                  onChange={(e) => e.target.value && setMonth(e.target.value)}
                />
              )}
            </div>
          </div>
          <Routes>
            <Route path="/app" element={<Dashboard from={from} to={to} />} />
            {["proveedores", "compras", "gastos", "ingresos"].map((path, i) => (
              <Route
                key={path}
                path={"/app/" + path}
                element={
                  <Records
                    key={path}
                    resource={["suppliers", "purchases", "expenses", "incomes"][i]!}
                    from={from}
                    to={to}
                  />
                }
              />
            ))}
            <Route path="/app/importaciones" element={<Imports />} />
            <Route path="/app/efectivo" element={<Cash from={from} to={to} />} />
            <Route path="/app/impuestos" element={<TaxPage from={from} />} />
            <Route path="/app/reportes" element={<Reports from={from} to={to} />} />
            <Route path="/app/cierres" element={<Closes />} />
            <Route path="/app/configuracion" element={<Settings />} />
            <Route path="*" element={<Navigate to="/app" replace />} />
          </Routes>
          <footer className="page-footer">
            <span>3dprintmty · Inteligencia financiera comercial</span>
            <span>Clip opera. Tú decides con datos.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function BadgeLocal({ local }: { local: boolean }) {
  return (
    <span className={"connection-pill " + (local ? "local" : "")}>
      <i />
      {local ? "Entorno local" : "Acceso privado"}
    </span>
  );
}
