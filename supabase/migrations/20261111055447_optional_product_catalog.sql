-- Preserve existing SKU-based accounting. New, unopened stores start with totals.
alter table public.settings
  add column inventory_mode text not null default 'summary' check (inventory_mode in ('summary','detailed')),
  add column opening_inventory_cents bigint check (opening_inventory_cents >= 0);
update public.settings set inventory_mode='detailed'
where exists(select 1 from public.inventory_movements)
   or exists(select 1 from public.purchase_lines)
   or exists(select 1 from public.incomes where product_id is not null);
alter table public.purchases add column summary_cost_cents bigint
  check (summary_cost_cents >= 0 and summary_cost_cents <= total_cents - tax_cents);
create table public.inventory_counts (
  id uuid primary key,
  date date not null unique,
  value_cents bigint not null check (value_cents >= 0),
  reason text not null check (length(reason) >= 8),
  created_at timestamptz not null default now()
);
alter table public.inventory_counts enable row level security;
alter table public.inventory_counts force row level security;
create policy private_owner on public.inventory_counts to tienda_api
  using (current_setting('app.author',true)=current_setting('app.owner',true) and current_setting('app.owner',true)<>'')
  with check (current_setting('app.author',true)=current_setting('app.owner',true) and current_setting('app.owner',true)<>'');
grant select,insert,update on public.inventory_counts to tienda_api;
do $$ begin
  if exists(select 1 from pg_roles where rolname='anon') then
    revoke all on public.inventory_counts from anon, authenticated;
  end if;
end $$;
