-- v2.6f: polish bay daily dust wipe spots (Jimmy, 17 Nov 2026). Data only, one row. Adds 3 photos (now 8).
update public.gp_emp_checks set
  ref_note = 'Floor: no leaves, no film pieces, no rubbish along the bay edge. Longkang cleaned out. Floor beside the washing machine swept clean. Wipe dust DAILY: keybox glass and frame, signboard and wall panel above it, pillar shelf and switches, speaker top.',
  ref_note_bm = 'Lantai: tiada daun, tiada sisa filem, tiada sampah di tepi bay. Longkang dibersihkan. Lantai tepi mesin basuh disapu bersih. Lap habuk SETIAP HARI: kaca dan bingkai kotak kunci, papan tanda dan panel dinding di atasnya, rak tiang dan suis, bahagian atas speaker.',
  bad_photos = (select coalesce(jsonb_agg(b), '[]'::jsonb) from jsonb_array_elements(bad_photos) b
                 where b->>'src' not like 'ref/bad/polish-dust-%')
               || '[{"src":"ref/bad/polish-dust-keybox.jpg","note":"Dust on keybox glass, frame and panel above - wipe daily"},
                    {"src":"ref/bad/polish-dust-shelf.jpg","note":"Dust on pillar shelf and switches - wipe daily"},
                    {"src":"ref/bad/polish-dust-speaker.jpg","note":"Dust on speaker top - wipe daily"}]'::jsonb,
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-polishbay';
select id, jsonb_array_length(bad_photos) n_bad, rotation->'order' rotation_order from public.gp_emp_checks where id = 'chk-polishbay';
