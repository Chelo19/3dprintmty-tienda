alter table public.serial_records add column will_invoice boolean not null default true;
alter table public.serial_records add constraint serial_records_billing_consistent check (
 will_invoice or invoice_date is null
);
