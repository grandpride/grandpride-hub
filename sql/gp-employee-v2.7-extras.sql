-- v2.7 (build 24): "extra job today" banner per area. Additive: one new column, default empty.
-- extras = [{dow:0-6, nth:1-5 (which week of the month, optional), skip_nth (optional), text, text_bm}]
alter table public.gp_emp_checks add column if not exists extras jsonb not null default '[]'::jsonb;

-- Boss room (Shafiq): every Wednesday leather cream; first Wednesday of the month cleaner first.
update public.gp_emp_checks set extras = '[
  {"dow":3,"nth":1,
   "text":"FIRST WEDNESDAY OF THE MONTH - Leather: 1) wipe orange sofa + black leather chair with Commune #1 Leather Soft Cleaner, 2) then apply #2 Leather Protection Cream. Kit in the drawer.",
   "text_bm":"RABU PERTAMA BULAN INI - Kulit: 1) lap sofa oren + kerusi kulit hitam dengan Commune #1 Leather Soft Cleaner, 2) kemudian sapu #2 Leather Protection Cream. Kit dalam laci."},
  {"dow":3,"skip_nth":1,
   "text":"WEDNESDAY - Leather: wipe orange sofa + black leather chair with Commune #2 Leather Protection Cream. Kit in the drawer.",
   "text_bm":"RABU - Kulit: lap sofa oren + kerusi kulit hitam dengan Commune #2 Leather Protection Cream. Kit dalam laci."}
]'::jsonb, updated_by = 'jimmy', updated_at = now()
 where id = 'chk-bossroom';
select id, jsonb_array_length(extras) n_extras from public.gp_emp_checks where id = 'chk-bossroom';
