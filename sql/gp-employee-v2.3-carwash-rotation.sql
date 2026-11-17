-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v2.3 Car wash group: 4 places, weekly rotation (Jimmy, 17 Nov 2026)
--  Data only. Nothing deleted. Safe to re-run.
--  Car wash group = JOJO, Shaker, Mg Soe (mg), Win Chay (winchay). One person per place,
--  everyone moves to the next place every Monday. Rotation weeks start Mon 23 Nov 2026.
--    Week of 23 Nov : wash bay Shaker | outside Mg Soe | lounge Win Chay | office+reception JOJO
--    Week of 30 Nov : wash bay Mg Soe | outside Win Chay | lounge JOJO | office+reception Shaker
--    ... and so on (4-week cycle). This week (17-22 Nov) JOJO keeps the wash bay.
--  * chk-washfloor      -> "Car wash bay" incl. longkang (rotation of 4)
--  * chk-wash-outside   -> NEW "Outside car wash bay" (grass slope, bin corner, manhole corner)
--  * chk-lounge-clean   -> lounge floor, moved from PPF team to car wash group (rotation)
--  * chk-office-clean   -> "Office + reception floor", moved to car wash group (rotation)
--  * chk-reception-clean-> switched OFF (active=false), merged into office + reception. Not deleted.
--  * Incentive: Car Wash & Detailing team + winchay, shaker, mg; lounge/office move to it.
--    PPF Room team keeps PPF room tidy + deep clean only.
-- =====================================================================

update public.gp_emp_checks set
  title = 'Car wash bay', title_bm = 'Ruang cuci kereta',
  mode = 'rotation', doers = '[]',
  rotation = '{"start":"2026-11-23","order":["shaker","mg","winchay","jojo"]}',
  ref_note = 'Before finish work: no leaves, no film off-cuts, no standing water on the bay floor. Longkang (drain) along the bay cleaned out: no leaves, mud, film or rubbish under the grating.',
  ref_note_bm = 'Sebelum habis kerja: tiada daun, tiada sisa filem, tiada air bertakung di lantai. Longkang di tepi ruang cuci dibersihkan: tiada daun, lumpur, filem atau sampah.',
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-washfloor';

insert into public.gp_emp_checks
  (id, title, title_bm, icon, slot, days, due_time, mode, doers, backups, rotation, checker, ref_photo, ref_note, ref_note_bm, start_date, sort)
values
  ('chk-wash-outside', 'Outside car wash bay', 'Kawasan luar ruang cuci', '🌿', 'closing', '[1,2,3,4,5,6]', '18:00', 'rotation',
   '[]', '[]', '{"start":"2026-11-23","order":["mg","winchay","jojo","shaker"]}', 'shafiq', null,
   'Grass slope, bin corner and manhole corner: no tissue, plastic or rubbish. Bin lid closed. Nothing left lying around.',
   'Cerun rumput, sudut tong sampah dan sudut lubang: tiada tisu, plastik atau sampah. Tutup tong sampah. Tiada barang bersepah.',
   '2026-11-23', 25)
on conflict (id) do nothing;

update public.gp_emp_checks set
  title = 'Lounge floor', title_bm = 'Lantai lounge',
  mode = 'rotation', doers = '[]',
  rotation = '{"start":"2026-11-23","order":["winchay","jojo","shaker","mg"]}',
  ref_note = 'Floor mopped and wiped, sofa and tables wiped, no cups or rubbish left.',
  ref_note_bm = 'Lantai dimop dan dilap, sofa dan meja dilap, tiada cawan atau sampah.',
  start_date = '2026-11-23', updated_by = 'jimmy', updated_at = now()
 where id = 'chk-lounge-clean';

update public.gp_emp_checks set
  title = 'Office + reception floor', title_bm = 'Lantai pejabat + kaunter',
  mode = 'rotation', doers = '[]',
  rotation = '{"start":"2026-11-23","order":["jojo","shaker","mg","winchay"]}',
  ref_note = 'Office and reception floors mopped and wiped, counter wiped, bins emptied.',
  ref_note_bm = 'Lantai pejabat dan kaunter dimop dan dilap, kaunter dilap, tong sampah dikosongkan.',
  start_date = '2026-11-23', updated_by = 'jimmy', updated_at = now()
 where id = 'chk-office-clean';

update public.gp_emp_checks set active = false, updated_by = 'jimmy', updated_at = now()
 where id = 'chk-reception-clean';

-- incentive teams
update public.gp_settings s set data = jsonb_set(s.data, '{teams}', (
  select jsonb_agg(
    case t->>'id'
      when 'gl-wash-detail' then t
        || jsonb_build_object('members', (select jsonb_agg(distinct m) from jsonb_array_elements_text(coalesce(t->'members','[]') || '["jojo","shaker","mg","winchay"]') m))
        || jsonb_build_object('areas', '["chk-washfloor","chk-wash-outside","chk-lounge-clean","chk-office-clean","chk-toolwall"]'::jsonb)
      when 'gl-ppf' then t || jsonb_build_object('areas', '["chk-ppfroom","chk-ppfdeep"]'::jsonb)
      else t end order by n)
  from jsonb_array_elements(s.data->'teams') with ordinality a(t, n)))
 where s.id = 'emp_team_incentive';

select id, title, mode, rotation->'order' as rotation_order, start_date, active, checker from public.gp_emp_checks order by sort;
select t->>'id' team, t->'members' members, t->'areas' areas from public.gp_settings, jsonb_array_elements(data->'teams') t where id = 'emp_team_incentive';
