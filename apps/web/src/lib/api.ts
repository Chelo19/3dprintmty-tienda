import { createClient, type SupabaseClient } from "@supabase/supabase-js";
export let supabase: SupabaseClient | null = null;
export let token = sessionStorage.getItem("tienda-token") ?? "";
export function setToken(value: string) {
  token = value;
  if (value) sessionStorage.setItem("tienda-token", value);
  else sessionStorage.removeItem("tienda-token");
}
let authInitialization: Promise<void> | null = null;
let authSubscription: { unsubscribe(): void } | null = null;

function updateSessionToken(value: string) {
  const changed = token !== value;
  setToken(value);
  if (changed) window.dispatchEvent(new Event("tienda-auth"));
}

export function setupAuth(config: {
  local: boolean;
  supabaseUrl?: string;
  publishableKey?: string;
}): Promise<void> {
  if (config.local) return Promise.resolve();
  if (!config.supabaseUrl || !config.publishableKey) {
    return Promise.reject(new Error("Supabase Auth no está configurado."));
  }
  if (!authInitialization) {
    authInitialization = initializeAuth(config.supabaseUrl, config.publishableKey).catch(
      (error) => {
        authInitialization = null;
        throw error;
      },
    );
  }
  return authInitialization;
}

async function initializeAuth(url: string, key: string) {
  const client = createClient(url, key, {
    auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
  });
  supabase = client;
  const { data, error } = await client.auth.getSession();
  if (error) throw error;
  updateSessionToken(data.session?.access_token ?? "");
  const { data: listener } = client.auth.onAuthStateChange((_event, session) => {
    updateSessionToken(session?.access_token ?? "");
  });
  authSubscription = listener.subscription;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    authSubscription?.unsubscribe();
    supabase?.auth.stopAutoRefresh();
  });
}
export async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const requestToken = token;
  const response = await fetch("/api/v1" + path, {
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof FormData)
        ? { "Content-Type": "application/json" }
        : {}),
      ...(requestToken ? { Authorization: "Bearer " + requestToken } : {}),
      ...options.headers,
    },
  });
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ message: "No se pudo conectar con el servidor." }));
    if (response.status === 401 && requestToken && requestToken === token) {
      updateSessionToken("");
    }
    throw new Error(body.message ?? "No se pudo completar la operación.");
  }
  return response.json();
}
export const action = (name: string, body: any, key = crypto.randomUUID()) =>
  api("/actions/" + name, {
    method: "POST",
    headers: { "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
export async function download(resource: string, from: string, to: string, format = "xlsx") {
  const res = await fetch(`/api/v1/exports/${resource}?from=${from}&to=${to}&format=${format}`, {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) throw new Error((await res.json()).message);
  const href = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = href;
  link.download = `tienda-${resource}-${from}.${format}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export async function downloadBackup() {
  const requestToken = token;
  const res = await fetch("/api/v1/backups/database", {
    method: "POST",
    headers: { Authorization: "Bearer " + requestToken },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ message: "No se pudo descargar el respaldo." }));
    throw new Error(body.message ?? "No se pudo descargar el respaldo.");
  }
  const href = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = href;
  const filename = /filename="(tienda-backup-[a-zA-Z0-9.-]+\.zip)"/.exec(
    res.headers.get("Content-Disposition") ?? "",
  )?.[1];
  link.download = filename ?? `tienda-backup-${new Date().toISOString().slice(0, 10)}.zip`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}
