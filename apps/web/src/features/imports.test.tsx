// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Imports } from "./imports";
const mocks = vi.hoisted(() => ({ api: vi.fn(), action: vi.fn() }));
vi.mock("../lib/api", () => mocks);
vi.mock("./records", () => ({ useRows: () => ({ data: [] }) }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it("reconoce el reporte, previsualiza sin mapeo manual y muestra existentes antes de confirmar", async () => {
  const file = {
    filename: "clip.csv",
    profile: "clip_report",
    headers: ["Date", "Paid Amount"],
    rows: [{ Date: "2026-11-10 14:36", "Paid Amount": "116", "Payment Status": "approved" }],
    file_hash: "x".repeat(64),
  };
  const batch = {
    id: "batch",
    filename: "clip.csv",
    source: "clip_import",
    status: "preview",
    errors: [],
    duplicates: 1,
    new_count: 0,
    changed_count: 0,
    unchanged_count: 1,
    cash_count: 1,
    total: "116",
    rows: [
      {
        external_id: "clip:r",
        date: "2026-11-10",
        gross: "116",
        net: null,
        method: "cash",
        duplicate: true,
        changed: false,
        status: "active",
      },
    ],
  };
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/settings" ? { opening_done: true } : path === "/imports/read" ? file : batch,
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <Imports />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Seleccionar archivo CSV o Excel"), {
    target: { files: [new File(["csv"], "clip.csv", { type: "text/csv" })] },
  });
  expect(await screen.findByText("Reporte de Clip reconocido")).toBeTruthy();
  expect(screen.getByText(/hora de Monterrey/)).toBeTruthy();
  expect(screen.queryByText("Relacionar columnas")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Validar y previsualizar/ }));
  expect(await screen.findByText("Existentes (no se duplican)")).toBeTruthy();
  expect(screen.getByText("Existente")).toBeTruthy();
  expect(mocks.action).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(mocks.api.mock.calls.filter((c) => c[0] === "/imports/preview")).toHaveLength(1),
  );
  expect(screen.queryByText("Consultar API Clip")).toBeNull();
  expect(screen.queryByText("Consultas a la API")).toBeNull();
  const confirm = screen.getByRole("button", { name: "Confirmar lote" }) as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  act(() => client.setQueryData(["settings"], { opening_done: false }));
  await waitFor(() => expect(confirm.disabled).toBe(true));
  expect(screen.getByText(/Para confirmar el lote, registra primero/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Ir a Configuración" }).getAttribute("href")).toBe(
    "/app/configuracion",
  );
  client.clear();
});
it("permite rechazar sin apertura y oculta las acciones cuando el lote queda rechazado", async () => {
  const batch = {
    id: "reject-batch",
    filename: "archivo.csv",
    source: "clip_import",
    status: "preview",
    errors: [{ row: 2, message: "Importe inválido" }],
    rows: [],
    total: "0",
    duplicates: 0,
  };
  const rejected = {
    ...batch,
    status: "rejected",
    rejection_reason: "Periodo incorrecto",
    rejected_at: "2026-11-11T06:00:00Z",
  };
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/settings"
        ? { opening_done: false }
        : path === "/imports/read"
          ? { filename: "archivo.csv", headers: [], rows: [], profile: "clip_report" }
          : path === "/imports/preview"
            ? batch
            : rejected,
    ),
  );
  mocks.action.mockResolvedValue({ rejected: true });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <Imports />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Seleccionar archivo CSV o Excel"), {
    target: { files: [new File(["csv"], "archivo.csv")] },
  });
  await screen.findByText("Reporte de Clip reconocido");
  fireEvent.click(screen.getByRole("button", { name: /Validar y previsualizar/ }));
  await screen.findByText("Importe inválido", { exact: false });
  const button = screen.getByRole("button", { name: "Rechazar lote" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false);
  expect(
    (screen.getByRole("button", { name: "Confirmar lote" }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.change(screen.getByLabelText("Motivo del rechazo (opcional)"), {
    target: { value: "Periodo incorrecto" },
  });
  fireEvent.click(button);
  expect(await screen.findByText("Rechazado")).toBeTruthy();
  expect(mocks.action).toHaveBeenCalledWith("reject-import", {
    id: "reject-batch",
    reason: "Periodo incorrecto",
  });
  expect(screen.queryByRole("button", { name: "Confirmar lote" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Rechazar lote" })).toBeNull();
  expect(screen.getByText(/Puedes cargar de nuevo el archivo/)).toBeTruthy();
  client.clear();
});

it("pide una decisión por estatus y la envía al previsualizar", async () => {
  const file = {
    filename: "estatus.csv",
    profile: "clip_report",
    headers: [],
    file_hash: "s".repeat(64),
    rows: [
      { "Payment Status": "approved", "Paid Amount": "100" },
      { "Payment Status": "pending", "Paid Amount": "50" },
      { "Payment Status": "cancelled", "Paid Amount": "20" },
    ],
  };
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/settings"
        ? { opening_done: true }
        : path === "/imports/read"
          ? file
          : { id: "status", status: "preview", rows: [], errors: [], total: "0" },
    ),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <Imports />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Seleccionar archivo CSV o Excel"), {
    target: { files: [new File(["csv"], "estatus.csv")] },
  });
  await screen.findByText("Reporte de Clip reconocido");
  const validate = screen.getByRole("button", {
    name: /Validar y previsualizar/,
  }) as HTMLButtonElement;
  expect(validate.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Decisión para pending"), {
    target: { value: "include" },
  });
  expect(validate.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Decisión para cancelled"), {
    target: { value: "exclude" },
  });
  expect(validate.disabled).toBe(false);
  fireEvent.click(validate);
  await screen.findByText("Vista previa del lote");
  const request = mocks.api.mock.calls.find(([path]) => path === "/imports/preview");
  expect(JSON.parse(request![1].body).status_decisions).toEqual({
    pending: "include",
    cancelled: "exclude",
  });
  fireEvent.change(screen.getByLabelText("Decisión para pending"), {
    target: { value: "exclude" },
  });
  expect(screen.queryByText("Vista previa del lote")).toBeNull();
  client.clear();
});

it("toma el tipo del CSV, permite corregir solo ventas nuevas y envía la elección al confirmar", async () => {
  const batch = {
    id: "route",
    filename: "clip.csv",
    source: "clip_import",
    status: "preview",
    errors: [],
    duplicates: 1,
    new_count: 1,
    total: "116",
    rows: [
      {
        external_id: "clip:new",
        date: "2026-11-10",
        gross: "116",
        method: "cash",
        payment_type: "cash",
        status: "active",
        duplicate: false,
      },
      {
        external_id: "clip:old",
        date: "2026-11-10",
        gross: "200",
        method: "cash",
        payment_type: "transfer",
        status: "active",
        duplicate: true,
      },
    ],
  };
  mocks.api.mockImplementation((path: string) =>
    Promise.resolve(
      path === "/settings"
        ? { opening_done: true }
        : path === "/imports/read"
          ? {
              filename: "clip.csv",
              profile: "clip_report",
              headers: [],
              rows: [{ "Payment Status": "approved" }],
            }
          : path === "/imports/preview"
            ? batch
            : { ...batch, status: "confirmed" },
    ),
  );
  mocks.action.mockResolvedValue({ confirmed: 1 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <Imports />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText("Seleccionar archivo CSV o Excel"), {
    target: { files: [new File(["csv"], "clip.csv")] },
  });
  await screen.findByText("Reporte de Clip reconocido");
  fireEvent.click(screen.getByRole("button", { name: /Validar y previsualizar/ }));
  const select = (await screen.findByLabelText("Tipo de pago para clip:new")) as HTMLSelectElement;
  expect(select.value).toBe("cash");
  expect(screen.queryByLabelText("Tipo de pago para clip:old")).toBeNull();
  expect(screen.getByText("Transferencia / Banco")).toBeTruthy();
  fireEvent.change(select, { target: { value: "transfer" } });
  fireEvent.click(screen.getByRole("button", { name: "Confirmar lote" }));
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith("confirm-import", {
      id: "route",
      payment_types: { "clip:new": "transfer" },
    }),
  );
  await screen.findByText("Confirmado");
  client.clear();
});
