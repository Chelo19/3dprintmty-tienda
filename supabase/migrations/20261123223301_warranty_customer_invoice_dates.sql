alter table public.serial_records
 add column sale_date date,
 add column invoice_date date;
-- The former start date described client assignment/sale, not a confirmed invoice.
update public.serial_records set sale_date=warranty_start where customer_name is not null;
alter table public.serial_records drop constraint serial_records_assignment_complete;
alter table public.serial_records add constraint serial_records_assignment_complete check (
 num_nonnulls(customer_name,customer_phone,customer_email,sale_date) in (0,4)
);
alter table public.serial_records add constraint serial_records_invoice_customer check (
 invoice_date is null or customer_name is not null
);
-- Keep warranty_start unchanged as historical data. Never infer invoice_date from it.
