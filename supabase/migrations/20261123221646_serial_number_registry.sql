create table public.serial_records (
 id uuid primary key,
 equipment text not null check(length(trim(equipment)) between 1 and 200),
 serial_number text not null check(length(trim(serial_number)) between 1 and 120),
 customer_name text not null check(length(trim(customer_name)) between 1 and 200),
 customer_phone text not null check(length(trim(customer_phone)) between 7 and 40),
 customer_email text not null check(length(trim(customer_email)) between 1 and 254),
 date date not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index serial_records_number_unique on public.serial_records(lower(trim(serial_number)));
create index serial_records_by_date on public.serial_records(date desc,created_at desc,id);
alter table public.serial_records enable row level security;
alter table public.serial_records force row level security;
create policy private_owner on public.serial_records to tienda_api
 using(current_setting('app.author',true)=current_setting('app.owner',true) and current_setting('app.owner',true)<>'')
 with check(current_setting('app.author',true)=current_setting('app.owner',true) and current_setting('app.owner',true)<>'');
grant select,insert,update on public.serial_records to tienda_api;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then
  revoke all on public.serial_records from anon,authenticated;
 end if;
end $$;
