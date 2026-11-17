-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v2.5 "Not like this" example photos per area (Jimmy, 17 Nov 2026)
--  Additive: one new column. Safe to re-run. Photos live in the app repo under employee/ref/bad/.
-- =====================================================================
alter table public.gp_emp_checks add column if not exists bad_photos jsonb not null default '[]'::jsonb;

update public.gp_emp_checks set bad_photos = '[
  {"src":"ref/bad/washbay-floor.jpg","note":"Leaf / rubbish and water left on the floor"},
  {"src":"ref/bad/washbay-drain.jpg","note":"Rubbish inside the longkang"},
  {"src":"ref/bad/washbay-edge.jpg","note":"Rubbish and stains at the bay edge"}]'::jsonb
 where id = 'chk-washfloor';

update public.gp_emp_checks set bad_photos = '[
  {"src":"ref/bad/outside-grass-1.jpg","note":"Rubbish on the grass"},
  {"src":"ref/bad/outside-grass-2.jpg","note":"Litter on the slope"},
  {"src":"ref/bad/outside-bin.jpg","note":"Litter around the bin"},
  {"src":"ref/bad/outside-manhole.jpg","note":"Rubbish at the manhole corner"}]'::jsonb
 where id = 'chk-wash-outside';

update public.gp_emp_checks set bad_photos = '[
  {"src":"ref/bad/polish-leaf.jpg","note":"Leaf on the floor"},
  {"src":"ref/bad/polish-film.jpg","note":"Film piece on the floor"},
  {"src":"ref/bad/polish-edge.jpg","note":"Rubbish along the bay edge"},
  {"src":"ref/bad/polish-longkang.jpg","note":"Longkang not cleaned"},
  {"src":"ref/bad/polish-washer.jpg","note":"Rubbish beside the washing machine"}]'::jsonb
 where id = 'chk-polishbay';

update public.gp_emp_checks set bad_photos = '[
  {"src":"ref/bad/toolwall-pads.jpg","note":"Loose pads and bottle on the side shelf"},
  {"src":"ref/bad/toolwall-personal.jpg","note":"Phones / personal stuff on the shelf"}]'::jsonb
 where id = 'chk-toolwall';

select id, title, jsonb_array_length(bad_photos) as not_like_this, ref_photo from public.gp_emp_checks where active is not false order by sort;

-- ---------- PPF room: film storage + cutting table corner (Shahadat, daily) ----------
insert into public.gp_emp_checks
  (id, title, title_bm, icon, slot, days, due_time, mode, doers, backups, rotation, checker, ref_photo, ref_note, ref_note_bm, start_date, sort)
values
  ('chk-ppf-store', 'PPF room — film storage + table', 'Bilik PPF — simpanan filem + meja', '📦', 'closing', '[1,2,3,4,5,6]', '18:00', 'team',
   '["shahadat"]', '[]', '{}', 'shafiq', 'ref/ppf-store.jpg',
   'Keep it exactly like the reference: all film boxes stacked neatly, no extra film or off-cuts lying around, all bottles lined up under the table.',
   'Sama seperti gambar rujukan: semua kotak filem disusun kemas, tiada filem lebih atau sisa filem bersepah, semua botol disusun di bawah meja.',
   '2026-11-23', 32)
on conflict (id) do nothing;

update public.gp_settings s set data = jsonb_set(s.data, '{teams}', (
  select jsonb_agg(case when t->>'id' = 'gl-ppf' and not (t->'areas' @> '["chk-ppf-store"]')
                        then t || jsonb_build_object('areas', (t->'areas') || '["chk-ppf-store"]'::jsonb) else t end order by n)
  from jsonb_array_elements(s.data->'teams') with ordinality a(t, n)))
 where s.id = 'emp_team_incentive';

select id, title, doers, ref_photo from public.gp_emp_checks where id = 'chk-ppf-store';
select t->>'id' team, t->'areas' areas from public.gp_settings, jsonb_array_elements(data->'teams') t where id = 'emp_team_incentive';
