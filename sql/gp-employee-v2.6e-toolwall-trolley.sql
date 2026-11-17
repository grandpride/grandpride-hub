-- v2.6e: polish trolleys + no names on wall (Jimmy, 17 Nov 2026). Data only, one row. Adds 2 "not like this" photos (now 4).
update public.gp_emp_checks set
  ref_note = 'Rack exactly like the reference photo: every bottle and tool back in its own place. Trolleys: compound bottles, spray bottles, tape, sponges and blades put back in their own place after work, tray wiped clean, nothing left lying on the tray. Side shelf: polish pads not in use put away or thrown, no bottles, no phones or personal stuff. Do not write names or anything on the walls or pillars.',
  ref_note_bm = 'Rak sama seperti gambar rujukan: setiap botol dan alat kembali ke tempatnya. Troli: botol compound, botol spray, tape, span dan pisau diletak semula di tempatnya selepas kerja, dulang dilap bersih, tiada barang tertinggal atas dulang. Rak tepi: pad polish yang tidak digunakan disimpan atau dibuang, tiada botol, tiada telefon atau barang peribadi. Jangan tulis nama atau apa-apa di dinding atau tiang.',
  bad_photos = (select coalesce(jsonb_agg(b), '[]'::jsonb) from jsonb_array_elements(bad_photos) b
                 where b->>'src' not in ('ref/bad/toolwall-trolley.jpg','ref/bad/toolwall-names.jpg'))
               || '[{"src":"ref/bad/toolwall-trolley.jpg","note":"Compound, tape, sponge, blade left on the trolley, tray dirty"},
                    {"src":"ref/bad/toolwall-names.jpg","note":"Names written on the pillar + personal bottle on the shelf"}]'::jsonb,
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-toolwall';
select id, jsonb_array_length(bad_photos) n_bad, rotation->'order' rotation_order from public.gp_emp_checks where id = 'chk-toolwall';
