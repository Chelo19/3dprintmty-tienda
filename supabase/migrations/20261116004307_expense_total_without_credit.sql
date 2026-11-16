-- Existing entries retain their original breakdown; do not infer their tax treatment.
alter table expenses add column tax_mode text not null default 'itemized'
  check (tax_mode in ('itemized', 'total_no_credit'));
alter table expenses add constraint expenses_total_no_credit_tax_zero
  check (tax_mode <> 'total_no_credit' or tax_cents = 0);
alter table expense_templates add column tax_mode text not null default 'itemized'
  check (tax_mode in ('itemized', 'total_no_credit'));
alter table expense_templates add constraint expense_templates_total_no_credit_tax_zero
  check (tax_mode <> 'total_no_credit' or tax_cents = 0);
