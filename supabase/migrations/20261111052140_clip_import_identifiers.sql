-- Alternate Clip identities let overlapping reports and API results refer to one income.
alter table public.incomes
  add column clip_transaction_id text unique,
  add column clip_payment_id text unique,
  add column clip_receipt_no text unique;
