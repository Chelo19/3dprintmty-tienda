alter table public.fee_rules add column installments smallint check(installments between 2 and 120);
alter table public.fee_rules add constraint fee_rule_msi_term check(installments is null or method='MSI');
alter table public.fee_rules drop constraint fee_rules_method_key;
create unique index fee_rules_without_term on public.fee_rules(method) where installments is null;
create unique index fee_rules_with_term on public.fee_rules(method,installments) where installments is not null;
alter table public.cash_movements drop constraint cash_movements_kind_check;
alter table public.cash_movements add constraint cash_movements_kind_check check (
 kind in ('opening','collection','purchase','expense','refund','transfer','contribution','withdrawal','recovery','clip_fee','clip_fee_estimate','clip_fee_adjustment','clip_msi_fee_estimate')
);
alter table public.cash_movements add constraint clip_msi_fee_document check (
 kind <> 'clip_msi_fee_estimate' or (income_id is not null and account_id='clip' and amount_cents<0)
);
create unique index cash_clip_msi_fee_once on public.cash_movements(income_id) where kind='clip_msi_fee_estimate';
create table public.income_msi_fee_estimates (
 income_id uuid primary key references public.income_card_fee_estimates(income_id),
 installments smallint not null check(installments between 2 and 120),
 date date not null,
 financing_cents bigint not null check(financing_cents>=0),
 tax_cents bigint not null check(tax_cents>=0 and tax_cents<=financing_cents),
 rule_snapshot jsonb not null check(jsonb_typeof(rule_snapshot)='object'),
 cash_id uuid unique references public.cash_movements(id),
 applied_at timestamptz not null default now(),
 check((financing_cents=0 and cash_id is null) or (financing_cents>0 and cash_id is not null))
);
alter table public.income_msi_fee_estimates enable row level security;
alter table public.income_msi_fee_estimates force row level security;
create policy private_owner on public.income_msi_fee_estimates to tienda_api
 using(current_setting('app.author',true)=current_setting('app.owner',true) and current_setting('app.owner',true)<>'')
 with check(current_setting('app.author',true)=current_setting('app.owner',true) and current_setting('app.owner',true)<>'');
grant select,insert on public.income_msi_fee_estimates to tienda_api;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then
  revoke all on public.income_msi_fee_estimates from anon,authenticated;
 end if;
end $$;
