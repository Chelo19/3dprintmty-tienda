/** Calendar months, clamped to the last valid day of the destination month. */
export function warrantyExpiry(start: string, months: number): string {
  const original = new Date(start + "T00:00:00Z");
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
    isNaN(original.getTime()) ||
    original.toISOString().slice(0, 10) !== start ||
    !Number.isInteger(months) ||
    months < 1 ||
    months > 120
  )
    throw new Error("Fecha o vigencia de garantía inválida.");
  const end = new Date(original);
  end.setUTCDate(1);
  end.setUTCMonth(end.getUTCMonth() + months);
  const last = new Date(end);
  last.setUTCMonth(last.getUTCMonth() + 1);
  last.setUTCDate(0);
  end.setUTCDate(Math.min(original.getUTCDate(), last.getUTCDate()));
  return end.toISOString().slice(0, 10);
}

export function warrantyDetails(
  invoiceDate: string | null,
  months: number | null,
  assigned: boolean,
  asOf: string,
  willInvoice = true,
  saleDate: string | null = null,
) {
  if (!assigned)
    return { warranty_end: null, warranty_status: "Sin asignar", days_remaining: null };
  const startDate = willInvoice ? invoiceDate : saleDate;
  if (!startDate)
    return {
      warranty_end: null,
      warranty_status: willInvoice ? "Pendiente de facturar" : "Fecha de venta por definir",
      days_remaining: null,
    };
  if (months == null)
    return { warranty_end: null, warranty_status: "Vigencia por definir", days_remaining: null };
  const end = warrantyExpiry(startDate, months);
  const days = Math.round(
    (Date.parse(end + "T00:00:00Z") - Date.parse(asOf + "T00:00:00Z")) / 86400000,
  );
  // Coverage includes the displayed expiration date.
  const status =
    asOf < startDate
      ? "Por iniciar"
      : asOf > end
        ? "Vencida"
        : days <= 30
          ? "Por vencer"
          : "Vigente";
  return { warranty_end: end, warranty_status: status, days_remaining: Math.max(0, days) };
}
