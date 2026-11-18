-- Preserve the gross sale and record the configured processing charge separately in Clip.
alter table public.cash_movements drop constraint cash_movements_kind_check;
alter table public.cash_movements add constraint cash_movements_kind_check check (
 kind in ('opening','collection','purchase','expense','refund','transfer','contribution','withdrawal','recovery','clip_fee','clip_fee_estimate','clip_fee_adjustment')
);
alter table public.cash_movements add constraint clip_fee_estimate_document check (
 kind <> 'clip_fee_estimate' or (income_id is not null and account_id='clip' and amount_cents<0)
);
alter table public.cash_movements add constraint clip_fee_adjustment_document check (
 kind <> 'clip_fee_adjustment' or (income_id is not null and account_id='clip')
);
create unique index cash_clip_fee_estimate_once on public.cash_movements(income_id) where kind='clip_fee_estimate';
create unique index cash_clip_fee_adjustment_once on public.cash_movements(income_id) where kind='clip_fee_adjustment';
create table public.income_card_fee_estimates (
 income_id uuid primary key references public.incomes(id),
 date date not null,
 processing_cents bigint not null check(processing_cents>=0),
 tax_cents bigint not null check(tax_cents>=0 and tax_cents<=processing_cents),
 rule_snapshot jsonb not null check(jsonb_typeof(rule_snapshot)='object'),
 cash_id uuid unique references public.cash_movements(id),
 applied_at timestamptz not null default now(),
 check ((processing_cents=0 and cash_id is null) or (processing_cents>0 and cash_id is not null))
);
alter table public.income_card_fee_estimates enable row level security;
alter table public.income_card_fee_estimates force row level security;
create policy private_owner on public.income_card_fee_estimates to tienda_api
 using(current_setting('app.author',true)=current_setting('app.owner',true) and current_setting('app.owner',true)<>'')
 with check(current_setting('app.author',true)=current_setting('app.owner',true) and current_setting('app.owner',true)<>'');
grant select,insert on public.income_card_fee_estimates to tienda_api;
do $$ begin
 if exists(select 1 from pg_roles where rolname='anon') then
  revoke all on public.income_card_fee_estimates from anon,authenticated;
 end if;
end $$;
