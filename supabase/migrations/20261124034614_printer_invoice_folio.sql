alter table public.serial_records
  add column invoice_folio text,
  add constraint serial_records_invoice_folio_valid check (
    invoice_folio is null or (
      invoice_folio = btrim(invoice_folio)
      and char_length(invoice_folio) between 1 and 120
      and invoice_date is not null
    )
  );
