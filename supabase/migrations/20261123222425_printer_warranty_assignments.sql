alter table public.serial_records
 add column warranty_months smallint check(warranty_months between 1 and 120),
 add column warranty_start date,
 alter column customer_name drop not null,
 alter column customer_phone drop not null,
 alter column customer_email drop not null;
-- Preserve existing client dates without inventing an unknown warranty duration.
update public.serial_records set warranty_start=date;
alter table public.serial_records add constraint serial_records_assignment_complete check (
 num_nonnulls(customer_name,customer_phone,customer_email,warranty_start) in (0,4)
);
