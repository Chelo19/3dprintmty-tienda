-- Preserve CSV meanings independently from sale VAT and processing commissions.
alter table incomes
  add column clip_base_cents bigint check (clip_base_cents >= 0),
  add column clip_tip_cents bigint check (clip_tip_cents >= 0),
  add column clip_financing_cents bigint check (clip_financing_cents >= 0),
  add column clip_report_net_cents bigint check (clip_report_net_cents >= 0),
  add column clip_financial_raw jsonb,
  add column settlement_date date,
  add column processing_fee_cents bigint check (processing_fee_cents >= 0),
  add column financing_withheld_cents bigint check (financing_withheld_cents >= 0),
  add column fee_creditable_tax_cents bigint check (fee_creditable_tax_cents >= 0),
  add column deposited_cents bigint check (deposited_cents >= 0),
  add column settlement_reference text,
  add column settlement_cash_id uuid unique references cash_movements(id),
  add column settled_at timestamptz;
alter table incomes add constraint income_settlement_complete check (
  (settled_at is null and num_nonnulls(settlement_date,processing_fee_cents,financing_withheld_cents,fee_creditable_tax_cents,deposited_cents,settlement_reference,settlement_cash_id)=0)
  or (settled_at is not null and settlement_date is not null and settlement_date >= from_date
    and processing_fee_cents is not null and financing_withheld_cents is not null
    and fee_creditable_tax_cents is not null and deposited_cents is not null
    and settlement_reference is not null and length(trim(settlement_reference)) >= 5
    and gross_cents = deposited_cents + processing_fee_cents + financing_withheld_cents
    and fee_creditable_tax_cents <= processing_fee_cents + financing_withheld_cents
    and fees_cents = processing_fee_cents + financing_withheld_cents - fee_creditable_tax_cents
    and fees_cents is not null
    and ((deposited_cents=0 and settlement_cash_id is null) or (deposited_cents>0 and settlement_cash_id is not null)))
);
alter table incomes add constraint income_clip_breakdown_total check (
  clip_base_cents is null or clip_tip_cents is null or clip_financing_cents is null
  or gross_cents = clip_base_cents + clip_tip_cents + clip_financing_cents
);
