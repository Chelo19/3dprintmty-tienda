// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Settings } from "./operations";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  action: vi.fn(),
  download: vi.fn(),
  downloadBackup: vi.fn(),
}));
vi.mock("../lib/api", () => mocks);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function show(available = true) {
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/backups/status"
        ? { available, database: "postgres", running: false }
        : path === "/settings"
          ? {
              database: "postgres",
              opening_done: true,
              opening_date: "2026-11-10",
              owner_email: "owner@example.com",
            }
          : [],
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Settings />
    </QueryClientProvider>,
  );
  return client;
}
it("descarga el respaldo sin fechas y desactiva el botón mientras se genera", async () => {
  let finish!: () => void;
  mocks.downloadBackup.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const client = show();
  const button = await screen.findByRole("button", { name: "Descargar respaldo" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  expect(
    (screen.getByRole("button", { name: "Preparando respaldo…" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(button);
  expect(mocks.downloadBackup).toHaveBeenCalledTimes(1);
  expect(mocks.downloadBackup).toHaveBeenCalledWith();
  finish();
  await screen.findByText(/Respaldo generado y enviado al navegador/);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  client.clear();
});
it("permite reintentar si falla y explica cuando el servidor no está preparado", async () => {
  mocks.downloadBackup.mockRejectedValue(new Error("No se pudo generar el respaldo."));
  const client = show();
  const button = await screen.findByRole("button", { name: "Descargar respaldo" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await screen.findByText("No se pudo generar el respaldo.");
  expect(screen.queryByText(/Respaldo generado y enviado al navegador/)).toBeNull();
  expect((button as HTMLButtonElement).disabled).toBe(false);
  client.clear();
});
it("no ofrece una descarga cuando faltan herramientas de respaldo", async () => {
  const client = show(false);
  await screen.findByText(/El servidor necesita la conexión de migraciones/);
  expect(
    (screen.getByRole("button", { name: "Descargar respaldo" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  client.clear();
});
