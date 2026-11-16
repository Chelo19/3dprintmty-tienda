drop index income_cash_once;
create table inventory_reconciliations (id uuid primary key, date date not null, reason text not null, snapshot jsonb not null, created_at timestamptz not null default now());
create table income_refunds (id uuid primary key, income_id uuid not null references incomes(id), date date not null, gross_cents bigint not null check(gross_cents>0), net_cents bigint check(net_cents>=0), cogs_cents bigint check(cogs_cents>=0), quantity numeric(20,6) check(quantity>0), reason text not null, created_at timestamptz not null default now());
alter table inventory_movements drop constraint inventory_movements_kind_check;
alter table inventory_movements add constraint inventory_movements_kind_check check(kind in ('opening','purchase','sale','adjustment','reversal','return'));
alter table inventory_movements add column refund_id uuid unique references income_refunds(id);
alter table cash_movements add column refund_id uuid references income_refunds(id);
do $$ declare t text; begin
 foreach t in array array['inventory_reconciliations','income_refunds'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('alter table public.%I force row level security',t);
  execute format('create policy private_owner on public.%I to tienda_api using (current_setting(''app.author'',true) = current_setting(''app.owner'',true) and current_setting(''app.owner'',true) <> '''') with check (current_setting(''app.author'',true) = current_setting(''app.owner'',true) and current_setting(''app.owner'',true) <> '''')',t);
  execute format('grant select,insert,update on public.%I to tienda_api',t);
  if exists(select 1 from pg_roles where rolname='anon') then execute format('revoke all on public.%I from anon,authenticated',t);end if;
 end loop;
end $$;
