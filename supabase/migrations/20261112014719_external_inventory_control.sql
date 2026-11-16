-- Inventory is managed outside this application. Preserve historical records and links.
alter table public.settings drop constraint settings_inventory_mode_check;
alter table public.settings add constraint settings_inventory_mode_check check(inventory_mode in ('external','summary','detailed'));
alter table public.settings alter column inventory_mode set default 'external';
update public.settings set inventory_mode='external';
