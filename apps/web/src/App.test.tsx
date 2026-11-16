// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
const auth = vi.hoisted(() => ({
  createClient: vi.fn(),
  callbacks: [] as ((event: string, session: null) => void)[],
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: auth.createClient }));
import { App } from "./App";
import { authConfigKey, clearPrivateQueries } from "./lib/auth-cache";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("no repite config por eventos de sesión vacía, incluso en StrictMode", async () => {
  auth.createClient.mockReturnValue({
    auth: {
      getSession: async () => ({ data: { session: null }, error: null }),
      onAuthStateChange: (callback: (event: string, session: null) => void) => {
        auth.callbacks.push(callback);
        queueMicrotask(() => callback("INITIAL_SESSION", null));
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
      stopAutoRefresh: vi.fn(),
    },
  });
  const request = vi.fn().mockImplementation(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          local: false,
          supabaseUrl: "https://example.supabase.co",
          publishableKey: "test-key",
        }),
        { status: 200 },
      ),
    ),
  );
  vi.stubGlobal("fetch", request);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <StrictMode>
      <QueryClientProvider client={client}>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <App />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
  expect(await screen.findByRole("heading", { name: "Iniciar sesión" })).toBeTruthy();
  // StrictMode can cancel the first mount request and make one replacement.
  const initialRequests = request.mock.calls.length;
  expect(initialRequests).toBeGreaterThan(0);
  expect(initialRequests).toBeLessThanOrEqual(2);
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      for (const callback of auth.callbacks) callback("INITIAL_SESSION", null);
      await Promise.resolve();
    }
  });
  expect(request).toHaveBeenCalledTimes(initialRequests);
  expect(auth.createClient).toHaveBeenCalledTimes(1);
  expect(client.getQueryData(authConfigKey)).toBeTruthy();
  client.clear();
});
it("limpia los datos privados al salir sin borrar la configuración pública", async () => {
  const client = new QueryClient();
  client.setQueryData(authConfigKey, { local: false });
  client.setQueryData(["products"], [{ name: "Privado" }]);
  client.setQueryData(["report", "2026-11"], { total: 10 });
  await clearPrivateQueries(client);
  expect(client.getQueryData(authConfigKey)).toEqual({ local: false });
  expect(client.getQueryData(["products"])).toBeUndefined();
  expect(client.getQueryData(["report", "2026-11"])).toBeUndefined();
  client.clear();
});
