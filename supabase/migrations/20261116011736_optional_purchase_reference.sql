-- Purchases without an invoice/reference are independent documents.
drop index public.purchases_active_reference;
create unique index purchases_active_reference on public.purchases(supplier_id, reference)
  where status = 'active' and reference <> '';
alter table public.purchases alter column reference set default '';
