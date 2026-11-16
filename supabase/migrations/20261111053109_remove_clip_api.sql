-- Clip now enters the system exclusively through uploaded reports.
-- Keep historical income source values and transaction identities for traceability.
alter table public.imports drop column sync_id;
drop table public.sync_runs;
