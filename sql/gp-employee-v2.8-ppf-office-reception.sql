-- v2.8 (17 Nov 2026, Jimmy): office + reception move to PPF room staff (2 reception + 2 office, after PPF room),
-- car wash group keeps car wash bay (2 people) + outside bay + lounge. Weekly rotation from Mon 23 Nov.
-- Needs build 24 (per_week = 2 people per week). Data only. Nothing deleted.

-- Car wash group: 4 people, 3 places, car wash bay takes 2 (each person: 2 weeks bay, 1 outside, 1 lounge)
update public.gp_emp_checks set rotation = '{"start":"2026-11-23","order":["shaker","mg","winchay","jojo"],"per_week":2}'::jsonb, updated_by='jimmy', updated_at=now() where id='chk-washfloor';
update public.gp_emp_checks set rotation = '{"start":"2026-11-23","order":["winchay","jojo","shaker","mg"]}'::jsonb, updated_by='jimmy', updated_at=now() where id='chk-wash-outside';
update public.gp_emp_checks set rotation = '{"start":"2026-11-23","order":["jojo","shaker","mg","winchay"]}'::jsonb, updated_by='jimmy', updated_at=now() where id='chk-lounge-clean';

-- PPF team: reception 2 people, office the other 2, swap pairs weekly
update public.gp_emp_checks set
  title='Reception floor + counter', title_bm='Lantai + kaunter penyambut', active=true, mode='rotation', doers='[]'::jsonb,
  rotation='{"start":"2026-11-23","order":["koko","myo","sadik","shahadat"],"per_week":2}'::jsonb,
  checker='shafiq', start_date='2026-11-23', ref_photo='ref/office-reception.jpg',
  ref_note='After the PPF room is done. Reception floor like the photo: no dust at all, sweep, mop and wipe, including corners and along the walls. Counter wiped and tidy, nothing left on the counter.',
  ref_note_bm='Selepas bilik PPF siap. Lantai kaunter seperti gambar: tiada habuk langsung, sapu, mop dan lap, termasuk sudut dan tepi dinding. Kaunter dilap dan kemas, tiada barang tertinggal atas kaunter.',
  updated_by='jimmy', updated_at=now()
 where id='chk-reception-clean';
update public.gp_emp_checks set
  title='Office floor', title_bm='Lantai pejabat', mode='rotation', doers='[]'::jsonb,
  rotation='{"start":"2026-11-23","order":["sadik","shahadat","koko","myo"],"per_week":2}'::jsonb,
  ref_photo=null,
  ref_note='After the PPF room is done. Office floor: no dust at all. Sweep, then mop and wipe the whole floor, including under the desks, chairs and along the walls. No film bits, paper or stains left. Bins emptied.',
  ref_note_bm='Selepas bilik PPF siap. Lantai pejabat: tiada habuk langsung. Sapu, kemudian mop dan lap seluruh lantai, termasuk bawah meja, kerusi dan tepi dinding. Tiada sisa filem, kertas atau kesan kotor. Tong sampah dikosongkan.',
  updated_by='jimmy', updated_at=now()
 where id='chk-office-clean';

-- Team incentive: office moves from Car Wash & Detailing to PPF Room; reception added to PPF Room
update public.gp_settings set data = jsonb_set(data, '{teams}', (
  select jsonb_agg(case
    when t->>'id'='gl-wash-detail' then jsonb_set(t,'{areas}', (select coalesce(jsonb_agg(a),'[]'::jsonb) from jsonb_array_elements(t->'areas') a where a #>> '{}' <> 'chk-office-clean'))
    when t->>'id'='gl-ppf' then jsonb_set(t,'{areas}', (select jsonb_agg(distinct a) from (select a from jsonb_array_elements(t->'areas') a union all select '"chk-office-clean"'::jsonb union all select '"chk-reception-clean"'::jsonb) z))
    else t end order by n)
  from jsonb_array_elements(data->'teams') with ordinality x(t,n)))
 where id='emp_team_incentive';

select id, title, active, rotation from public.gp_emp_checks where id in ('chk-washfloor','chk-wash-outside','chk-lounge-clean','chk-office-clean','chk-reception-clean') order by id;
select t->>'id' team, t->'areas' areas from public.gp_settings, jsonb_array_elements(data->'teams') t where id='emp_team_incentive';
