-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v2.4 Polish group: 3 places, weekly rotation + boss room Mon/Wed
--  (Jimmy, 17 Nov 2026). Data only. Nothing deleted. Safe to re-run.
--  Polish group = Zaw Min (zawmin), Ah Tun (ahtun), Bobo (bobo). One place each, moves every Monday
--  from Mon 23 Nov (3-week cycle):
--    Week of 23 Nov : polish bay Ah Tun | tool wall Bobo   | toilet + waiting area Zaw Min
--    Week of 30 Nov : polish bay Bobo   | tool wall Zaw Min| toilet + waiting area Ah Tun
--    Week of  7 Dec : polish bay Zaw Min| tool wall Ah Tun | toilet + waiting area Bobo
--  * chk-toolwall        -> "Equipment place / tool wall" (rotation) + reference photo ref/toolwall.jpg
--  * chk-polishbay       -> NEW "Polish bay" (floor, longkang, beside washing machine)
--  * chk-toilet-waiting  -> NEW "Toilet + waiting area"
--  * chk-bossroom        -> Monday AND Wednesday (Shafiq)
--  * Incentive: polishbay + toilet-waiting added to the Car Wash & Detailing team areas.
-- =====================================================================

update public.gp_emp_checks set
  title = 'Equipment place / tool wall', title_bm = 'Tempat peralatan / dinding alat',
  mode = 'rotation', doers = '[]',
  rotation = '{"start":"2026-11-23","order":["bobo","zawmin","ahtun"]}',
  ref_photo = 'ref/toolwall.jpg',
  ref_note = 'Rack exactly like the reference photo: every bottle and tool back in its own place. Side shelf: polish pads not in use put away or thrown, no bottles, no phones or personal stuff.',
  ref_note_bm = 'Rak sama seperti gambar rujukan: setiap botol dan alat di tempatnya. Rak tepi: pad polish yang tidak digunakan simpan atau buang, tiada botol, tiada telefon atau barang peribadi.',
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-toolwall';

insert into public.gp_emp_checks
  (id, title, title_bm, icon, slot, days, due_time, mode, doers, backups, rotation, checker, ref_photo, ref_note, ref_note_bm, start_date, sort)
values
  ('chk-polishbay', 'Polish bay', 'Ruang polish', '✨', 'closing', '[1,2,3,4,5,6]', '18:00', 'rotation',
   '[]', '[]', '{"start":"2026-11-23","order":["ahtun","bobo","zawmin"]}', 'shafiq', null,
   'Floor: no leaves, no film pieces, no rubbish along the bay edge. Longkang cleaned out. Floor beside the washing machine swept clean.',
   'Lantai: tiada daun, tiada sisa filem, tiada sampah di tepi ruang. Longkang dibersihkan. Lantai tepi mesin basuh disapu bersih.',
   '2026-11-23', 35),
  ('chk-toilet-waiting', 'Toilet + waiting area', 'Tandas + ruang menunggu', '🚻', 'closing', '[1,2,3,4,5,6]', '18:00', 'rotation',
   '[]', '[]', '{"start":"2026-11-23","order":["zawmin","ahtun","bobo"]}', 'shafiq', null,
   'Toilet: floor dry, sink and toilet clean, bin emptied. Waiting area: floor clean, table clear, chairs in place, no rubbish.',
   'Tandas: lantai kering, sinki dan tandas bersih, tong sampah dikosongkan. Ruang menunggu: lantai bersih, meja kosong, kerusi tersusun, tiada sampah.',
   '2026-11-23', 45)
on conflict (id) do nothing;

update public.gp_emp_checks set days = '[1,3]', updated_by = 'jimmy', updated_at = now()
 where id = 'chk-bossroom';

update public.gp_settings s set data = jsonb_set(s.data, '{teams}', (
  select jsonb_agg(
    case t->>'id'
      when 'gl-wash-detail' then t || jsonb_build_object('areas',
        '["chk-washfloor","chk-wash-outside","chk-lounge-clean","chk-office-clean","chk-polishbay","chk-toolwall","chk-toilet-waiting"]'::jsonb)
      else t end order by n)
  from jsonb_array_elements(s.data->'teams') with ordinality a(t, n)))
 where s.id = 'emp_team_incentive';

select id, title, mode, rotation->'order' as rotation_order, days, start_date, ref_photo, active from public.gp_emp_checks where active is not false order by sort;
select t->>'id' team, t->'areas' areas from public.gp_settings, jsonb_array_elements(data->'teams') t where id = 'emp_team_incentive';
