-- Only new imports generate receipts. Historical records remain unchanged.
alter table public.incomes add column import_collection_id uuid unique references public.cash_movements(id);
alter table public.cash_movements drop constraint cash_movements_kind_check;
alter table public.cash_movements add constraint cash_movements_kind_check
  check (kind in ('opening','collection','purchase','expense','refund','transfer','contribution','withdrawal','recovery','clip_fee'));
alter table public.cash_movements add constraint clip_fee_document
  check (kind <> 'clip_fee' or (income_id is not null and account_id='clip' and amount_cents<0));
create unique index cash_clip_fee_once on public.cash_movements(income_id) where kind='clip_fee';
