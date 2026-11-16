// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({
  createClient: vi.fn(),
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: auth.createClient }));
let callback: (event: string, session: { access_token: string } | null) => void;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sessionStorage.clear();
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null });
  auth.onAuthStateChange.mockImplementation((fn) => {
    callback = fn;
    queueMicrotask(() => fn("INITIAL_SESSION", null));
    return { data: { subscription: { unsubscribe: vi.fn() } } };
  });
  auth.createClient.mockReturnValue({
    auth: {
      getSession: auth.getSession,
      onAuthStateChange: auth.onAuthStateChange,
      stopAutoRefresh: vi.fn(),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());
const config = {
  local: false,
  supabaseUrl: "https://example.supabase.co",
  publishableKey: "test-publishable",
};
describe("Ciclo de sesión y solicitudes", () => {
  it("comparte una inicialización aun con efectos concurrentes y config nueva equivalente", async () => {
    const api = await import("./api");
    await Promise.all([api.setupAuth(config), api.setupAuth({ ...config }), api.setupAuth(config)]);
    expect(auth.createClient).toHaveBeenCalledTimes(1);
    expect(auth.onAuthStateChange).toHaveBeenCalledTimes(1);
  });
  it("no publica cambios por INITIAL_SESSION vacío ni por notificaciones repetidas", async () => {
    const api = await import("./api");
    const listener = vi.fn();
    window.addEventListener("tienda-auth", listener);
    try {
      await api.setupAuth(config);
      callback("INITIAL_SESSION", null);
      callback("SIGNED_OUT", null);
      expect(listener).not.toHaveBeenCalled();
      callback("SIGNED_IN", { access_token: "session-a" });
      callback("SIGNED_IN", { access_token: "session-a" });
      expect(listener).toHaveBeenCalledTimes(1);
      callback("SIGNED_OUT", null);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("tienda-auth", listener);
    }
  });
  it("un 401 sin sesión no vuelve a iniciar el ciclo de autenticación", async () => {
    const api = await import("./api");
    const listener = vi.fn();
    window.addEventListener("tienda-auth", listener);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: "Inicia sesión" }), { status: 401 }),
        ),
    );
    try {
      await expect(api.api("/settings")).rejects.toThrow("Inicia sesión");
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("tienda-auth", listener);
    }
  });
  it("un 401 atrasado no elimina una sesión recién renovada", async () => {
    const api = await import("./api");
    api.setToken("old-session");
    let finish!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      ),
    );
    const pending = api.api("/settings");
    api.setToken("new-session");
    finish(new Response(JSON.stringify({ message: "Sesión anterior vencida" }), { status: 401 }));
    await expect(pending).rejects.toThrow();
    expect(api.token).toBe("new-session");
  });
});
