-- Do not reuse historical RFC-wide retentions or balances as store-only adjustments.
alter table public.monthly_tax_inputs add column scope text not null default 'legacy_rfc'
  check(scope in ('legacy_rfc','store'));
