-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v2.1 PPF team incentive + new check areas (Jimmy, 11 Nov 2026)
--  Data only, no structure change. Safe to re-run (inserts skip if already there).
--  * New areas: Lounge / Office / Reception clean (PPF team, closing 6pm, checker Jimmy)
--               Boss room clean (Shafiq, Monday 9:30am, checker Jimmy, no incentive)
--  * PPF room + PPF deep clean checker: Shafiq -> Jimmy (Shafiq becomes PPF team head)
--  * Second incentive team "PPF Room": tiers RM200/250/400/600/800, head Shafiq 20%
-- =====================================================================

insert into public.gp_emp_checks
  (id, title, title_bm, icon, slot, days, due_time, mode, doers, backups, rotation, checker, ref_photo, ref_note, ref_note_bm, start_date, sort)
values
  ('chk-lounge-clean', 'Lounge clean', 'Lounge bersih', '🧽', 'closing', '[1,2,3,4,5,6]', '18:00', 'team',
   '["koko","myo","sadik","shahadat"]', '[]', '{}', 'jimmy', null,
   'Floor swept and mopped, sofa and tables wiped, no cups or rubbish left.',
   'Lantai disapu dan dimop, sofa dan meja dilap, tiada cawan atau sampah.', '2026-12-01', 70),
  ('chk-office-clean', 'Office clean', 'Pejabat bersih', '🗂️', 'closing', '[1,2,3,4,5,6]', '18:00', 'team',
   '["koko","myo","sadik","shahadat"]', '[]', '{}', 'jimmy', null,
   'Desks clear, floor clean, rubbish bin emptied.',
   'Meja kemas, lantai bersih, tong sampah dikosongkan.', '2026-12-01', 80),
  ('chk-reception-clean', 'Reception clean', 'Kaunter penyambut bersih', '🛎️', 'closing', '[1,2,3,4,5,6]', '18:00', 'team',
   '["koko","myo","sadik","shahadat"]', '[]', '{}', 'jimmy', null,
   'Counter wiped and tidy, floor clean, nothing left on the counter.',
   'Kaunter dilap dan kemas, lantai bersih, tiada barang di atas kaunter.', '2026-12-01', 90),
  ('chk-bossroom', 'Boss room clean', 'Bilik bos bersih', '🪑', 'opening', '[1]', '09:30', 'team',
   '["shafiq"]', '[]', '{}', 'jimmy', null,
   'Every Monday morning: desk wiped, floor clean, bin emptied, room tidy like the reference.',
   'Setiap Isnin pagi: meja dilap, lantai bersih, tong sampah dikosongkan, bilik kemas.', '2026-12-01', 100)
on conflict (id) do nothing;

-- Shafiq becomes PPF team head -> Jimmy checks the PPF team's photos
update public.gp_emp_checks set checker = 'jimmy', updated_by = 'jimmy', updated_at = now()
 where id in ('chk-ppfroom', 'chk-ppfdeep') and checker = 'shafiq';

-- second incentive team (added only if not there yet)
update public.gp_settings
   set data = jsonb_set(data, '{teams}', coalesce(data->'teams','[]'::jsonb) || '[{
     "id": "gl-ppf",
     "name": "PPF Room",
     "members": ["koko","myo","sadik","shahadat"],
     "head": "shafiq",
     "head_pct": 20,
     "areas": ["chk-ppfroom","chk-ppfdeep","chk-lounge-clean","chk-office-clean","chk-reception-clean"],
     "tiers": [200,250,400,600,800],
     "drop": 2,
     "warnings_allowed": 2,
     "start_month": "2026-12",
     "reporters": ["shafiq","jimmy"]
   }]'::jsonb)
 where id = 'emp_team_incentive'
   and not exists (select 1 from jsonb_array_elements(coalesce(data->'teams','[]'::jsonb)) t where t->>'id' = 'gl-ppf');

select id, title, slot, due_time, days, checker, start_date from public.gp_emp_checks order by sort;
select t->>'id' as team, t->>'name' as name, t->'tiers' as tiers, t->>'head' as head
  from public.gp_settings, jsonb_array_elements(data->'teams') t where id = 'emp_team_incentive';
