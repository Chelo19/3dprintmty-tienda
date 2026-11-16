alter table public.purchases
 add column status text not null default 'active' check(status in ('active','cancelled')),
 add column cancelled_at timestamptz,
 add column cancellation_reason text not null default '',
 add constraint purchases_cancellation_metadata check((status='cancelled')=(cancelled_at is not null) and (status<>'cancelled' or length(cancellation_reason)>=8));
alter table public.expenses
 add column status text not null default 'active' check(status in ('active','cancelled')),
 add column cancelled_at timestamptz,
 add column cancellation_reason text not null default '',
 add constraint expenses_cancellation_metadata check((status='cancelled')=(cancelled_at is not null) and (status<>'cancelled' or length(cancellation_reason)>=8));
alter table public.inventory_movements add column voided_at timestamptz;
-- Retain cancelled documents, but allow entering a corrected invoice with the same reference.
alter table public.purchases drop constraint purchases_supplier_id_reference_key;
create unique index purchases_active_reference on public.purchases(supplier_id,reference) where status='active';
alter table public.cash_movements drop constraint cash_movements_kind_check;
alter table public.cash_movements add constraint cash_movements_kind_check
 check(kind in ('opening','collection','purchase','expense','refund','transfer','contribution','withdrawal','recovery'));
alter table public.cash_movements add constraint recovery_document
 check(kind<>'recovery' or (num_nonnulls(purchase_id,expense_id)=1 and amount_cents>0));

create index cash_purchase_document on public.cash_movements(purchase_id,date) where purchase_id is not null;
create index cash_expense_document on public.cash_movements(expense_id,date) where expense_id is not null;
