// @vitest-environment jsdom
import { afterEach, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SerialRecords } from "./serial-records";
const mocks = vi.hoisted(() => ({ api: vi.fn(), action: vi.fn() }));
vi.mock("../lib/api", () => mocks);
HTMLDialogElement.prototype.showModal = function () {
  this.setAttribute("open", "");
};
HTMLDialogElement.prototype.close = function () {
  this.removeAttribute("open");
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const row = {
  id: "serial-1",
  equipment: "Bambu Lab A1",
  serial_number: "A1-123",
  customer_name: "Cliente Uno",
  customer_phone: "8112345678",
  customer_email: "cliente@example.com",
  date: "2026-11-23",
  warranty_months: 12,
  sale_date: "2026-11-23",
  invoice_date: "2026-11-25",
  will_invoice: true,
  billing_status: "Facturada",
  warranty_end: "2027-11-25",
  warranty_status: "Vigente",
  days_remaining: 365,
};
function show(rows: any[] = []) {
  mocks.api.mockResolvedValue(rows);
  mocks.action.mockResolvedValue({ id: "new" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <SerialRecords />
    </QueryClientProvider>,
  );
  return client;
}
const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label, { exact: false, selector: "input" }), {
    target: { value },
  });
it("registra una impresora con vigencia sin requerir cliente ni iniciar la garantía", async () => {
  const client = show();
  await screen.findByText("Aún no hay impresoras registradas");
  fireEvent.click(screen.getByRole("button", { name: "Registrar impresora" }));
  expect(screen.queryByLabelText("Nombre de cliente")).toBeNull();
  fill("Equipo", row.equipment);
  fill("Número de serie", row.serial_number);
  fill("Vigencia de garantía (meses)", "12");
  fill("Fecha de registro", row.date);
  fireEvent.submit(screen.getByRole("button", { name: "Guardar impresora" }).closest("form")!);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "serial-record",
      {
        equipment: row.equipment,
        serial_number: row.serial_number,
        date: row.date,
        warranty_months: 12,
        will_invoice: true,
      },
      expect.any(String),
    ),
  );
  client.clear();
});
it("asigna después el cliente y su fecha de venta sin crear otra impresora", async () => {
  const client = show([
    {
      ...row,
      customer_name: null,
      customer_phone: null,
      customer_email: null,
      sale_date: null,
      invoice_date: null,
      warranty_end: null,
      warranty_status: "Sin asignar",
      days_remaining: null,
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "Asignar cliente" }));
  fill("Nombre de cliente", "Cliente Nuevo");
  fill("Teléfono de cliente", "8112345678");
  fill("Correo de cliente", "nuevo@example.com");
  fill("Fecha de venta", "2026-12-31");
  expect(screen.getByText(/Pendiente de facturar: la garantía todavía no inicia/)).toBeTruthy();
  fireEvent.submit(
    screen.getByRole("button", { name: "Asignar cliente y registrar venta" }).closest("form")!,
  );
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "serial-record-assign",
      {
        id: row.id,
        customer_name: "Cliente Nuevo",
        customer_phone: "8112345678",
        customer_email: "nuevo@example.com",
        sale_date: "2026-12-31",
        invoice_date: null,
        invoice_folio: null,
        will_invoice: true,
      },
      expect.any(String),
    ),
  );
  client.clear();
});
it("busca por cliente y edita una garantía conservando venta y facturación", async () => {
  const client = show([
    row,
    {
      ...row,
      id: "second",
      serial_number: "X1-456",
      customer_name: "Cliente Dos",
      warranty_status: "Vencida",
    },
  ]);
  await screen.findByText("A1-123");
  fireEvent.change(screen.getByRole("textbox", { name: "Buscar registros" }), {
    target: { value: "Cliente Uno" },
  });
  expect(screen.queryByText("X1-456")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Ver / editar" }));
  expect(
    (
      screen.getByLabelText("Fecha de facturación al cliente", {
        exact: false,
        selector: "input",
      }) as HTMLInputElement
    ).value,
  ).toBe(row.invoice_date);
  fill("Teléfono de cliente", "8187654321");
  fill("Folio de factura", "F-2026-123");
  fireEvent.submit(screen.getByRole("button", { name: "Guardar cambios" }).closest("form")!);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "serial-record-update",
      expect.objectContaining({
        id: row.id,
        customer_phone: "8187654321",
        invoice_date: row.invoice_date,
        invoice_folio: "F-2026-123",
        sale_date: row.sale_date,
        warranty_months: 12,
      }),
      expect.any(String),
    ),
  );
  client.clear();
});
it("permite filtrar garantías vencidas", async () => {
  const client = show([
    row,
    {
      ...row,
      id: "second",
      serial_number: "EXPIRED-1",
      warranty_status: "Vencida",
      days_remaining: 0,
    },
  ]);
  await screen.findByText("EXPIRED-1");
  fireEvent.change(screen.getByLabelText("Filtrar por Garantía"), { target: { value: "Vencida" } });
  expect(screen.queryByText("A1-123")).toBeNull();
  expect(screen.getByText("EXPIRED-1")).toBeTruthy();
  client.clear();
});
it("conserva la captura si el número de serie ya está registrado", async () => {
  const client = show();
  mocks.action.mockRejectedValue(new Error("Este número de serie ya está registrado."));
  fireEvent.click(screen.getByRole("button", { name: "Registrar impresora" }));
  fill("Número de serie", "A1-123");
  fill("Vigencia de garantía (meses)", "6");
  fireEvent.submit(screen.getByRole("button", { name: "Guardar impresora" }).closest("form")!);
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "Este número de serie ya está registrado.",
  );
  expect(
    (
      screen.getByLabelText("Número de serie", {
        exact: false,
        selector: "input",
      }) as HTMLInputElement
    ).value,
  ).toBe("A1-123");
  client.clear();
});

it("registra la factura después de la venta sin volver a capturar cliente ni fechas anteriores", async () => {
  const client = show([
    {
      ...row,
      invoice_date: null,
      warranty_end: null,
      warranty_status: "Pendiente de facturar",
      days_remaining: null,
    },
  ]);
  fireEvent.click(await screen.findByRole("button", { name: "Registrar factura" }));
  fill("Fecha de facturación al cliente", "2027-01-15");
  fill("Folio de factura", "FAC-123");
  expect(screen.queryByLabelText("Nombre de cliente")).toBeNull();
  fireEvent.submit(
    screen.getByRole("button", { name: "Guardar facturación e iniciar garantía" }).closest("form")!,
  );
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "serial-record-invoice",
      { id: row.id, invoice_date: "2027-01-15", invoice_folio: "FAC-123" },
      expect.any(String),
    ),
  );
  client.clear();
});

it("marca No se va a facturar y usa la venta para el vencimiento sin pedir fecha de factura", async () => {
  const client = show([
    {
      ...row,
      invoice_date: null,
      will_invoice: false,
      billing_status: "No se facturará",
      warranty_status: "Vigente",
      warranty_end: "2027-11-23",
    },
  ]);
  await screen.findByText("A1-123");
  expect(screen.queryByRole("button", { name: "Registrar factura" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Ver / editar" }));
  expect(
    (screen.getByRole("checkbox", { name: "No se va a facturar" }) as HTMLInputElement).checked,
  ).toBe(true);
  expect(
    screen.queryByLabelText("Fecha de facturación al cliente", { exact: false, selector: "input" }),
  ).toBeNull();
  expect(screen.getByText(/No se va a facturar: calculado desde la fecha de venta/)).toBeTruthy();
  fill("Fecha de venta", "2026-12-01");
  fireEvent.submit(screen.getByRole("button", { name: "Guardar cambios" }).closest("form")!);
  await waitFor(() =>
    expect(mocks.action).toHaveBeenCalledWith(
      "serial-record-update",
      expect.objectContaining({
        id: row.id,
        will_invoice: false,
        invoice_date: null,
        sale_date: "2026-12-01",
      }),
      expect.any(String),
    ),
  );
  client.clear();
});
it("protege la fecha de una factura ya registrada antes de permitir cambiar la opción", async () => {
  const client = show([row]);
  await screen.findByText("A1-123");
  fireEvent.click(screen.getByRole("button", { name: "Ver / editar" }));
  expect(
    (screen.getByRole("checkbox", { name: "No se va a facturar" }) as HTMLInputElement).disabled,
  ).toBe(true);
  fill("Fecha de facturación al cliente", "");
  const checkbox = screen.getByRole("checkbox", {
    name: "No se va a facturar",
  }) as HTMLInputElement;
  expect(checkbox.disabled).toBe(false);
  fireEvent.click(checkbox);
  expect(
    screen.queryByLabelText("Fecha de facturación al cliente", { exact: false, selector: "input" }),
  ).toBeNull();
  client.clear();
});
