alter table public.settings add column fiscal_profile text check (fiscal_profile in ('resico_pf_16'));
-- The owner confirmed this profile; keep historical income/cash rows unchanged.
update public.settings set fiscal_profile='resico_pf_16' where id=1;
create table public.monthly_cogs (
 month text primary key check(month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 amount_cents bigint not null check(amount_cents>=0),
 source_signature text not null check(length(source_signature)=64),
 reference text not null check(length(trim(reference))>=5),
 active boolean not null default true,
 updated_at timestamptz not null default now()
);
create table public.monthly_tax_inputs (
 month text primary key check(month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
 other_income_cents bigint not null check(other_income_cents>=0),
 other_vat_collected_cents bigint not null check(other_vat_collected_cents>=0),
 other_vat_creditable_cents bigint not null check(other_vat_creditable_cents>=0),
 isr_withheld_cents bigint not null default 0 check(isr_withheld_cents>=0),
 vat_withheld_cents bigint not null default 0 check(vat_withheld_cents>=0),
 vat_carry_cents bigint not null default 0 check(vat_carry_cents>=0),
 reference text not null check(length(trim(reference))>=5),
 updated_at timestamptz not null default now()
);
create table public.tax_documents (
 id uuid primary key,
 purchase_id uuid unique references public.purchases(id),
 expense_id uuid unique references public.expenses(id),
 income_id uuid unique references public.incomes(id),
 status text not null check(status in ('pending','creditable','nonrecoverable')),
 invoice_uuid uuid,
 invoice_vat_cents bigint check(invoice_vat_cents>=0),
 eligible_on date,
 notes text not null check(length(trim(notes))>=5),
 updated_at timestamptz not null default now(),
 check(num_nonnulls(purchase_id,expense_id,income_id)=1),
 check((status='creditable' and invoice_uuid is not null and invoice_vat_cents is not null and eligible_on is not null)
   or (status<>'creditable' and num_nonnulls(invoice_uuid,invoice_vat_cents,eligible_on)=0))
);
create index tax_documents_invoice on public.tax_documents(invoice_uuid) where status='creditable';
do $$ declare t text; begin
 foreach t in array array['monthly_cogs','monthly_tax_inputs','tax_documents'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('create policy private_owner on public.%I to tienda_api using (current_setting(''app.author'',true)=current_setting(''app.owner'',true) and current_setting(''app.owner'',true)<>'''') with check (current_setting(''app.author'',true)=current_setting(''app.owner'',true) and current_setting(''app.owner'',true)<>'''')',t);
  execute format('grant select,insert,update on public.%I to tienda_api',t);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on public.%I from anon,authenticated',t); end if;
 end loop;
end $$;
