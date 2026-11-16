alter table public.imports drop constraint imports_status_check;
alter table public.imports
  add constraint imports_status_check check (status in ('preview','confirmed','rejected')),
  add column rejected_at timestamptz,
  add column rejection_reason text not null default '',
  add constraint imports_rejection_metadata check ((status='rejected') = (rejected_at is not null));
-- Re-uploading a rejected file creates a fresh preview without losing its rejection history.
alter table public.imports drop constraint imports_payload_hash_key;
create unique index imports_payload_hash_active on public.imports(payload_hash) where status <> 'rejected';
