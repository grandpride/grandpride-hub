-- v2.6g: correct reference photos for keybox + polish wall rack (Jimmy, 17 Nov 2026). Data only, two rows.
update public.gp_emp_checks set ref_photo = 'ref/keybox.jpg',
  ref_note = 'Before going home: glass door closed and locked. Every key on its own hook, like the photo.',
  ref_note_bm = 'Sebelum balik: pintu kaca ditutup dan dikunci. Setiap kunci di cangkuk sendiri, seperti gambar.',
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-keybox';
update public.gp_emp_checks set ref_photo = 'ref/toolwall-v2.jpg',
  ref_note = 'Wall racks exactly like the reference photos (top: polish wall, bottom: wash wall). Polish wall: Koch Chemie bottles on top, brushes in their holders, polishing machines at the bottom with cables tied. Every bottle and tool back in its own place. Trolleys: compound bottles, spray bottles, tape, sponges and blades put back in their own place after work, tray wiped clean, nothing left lying on the tray. Side shelf: polish pads not in use put away or thrown, no bottles, no phones or personal stuff. Do not write names or anything on the walls or pillars.',
  ref_note_bm = 'Rak dinding sama seperti gambar rujukan (atas: dinding polish, bawah: dinding cuci). Dinding polish: botol Koch Chemie di atas, berus di pemegangnya, mesin polish di bawah dengan kabel diikat. Setiap botol dan alat kembali ke tempatnya. Troli: botol compound, botol spray, tape, span dan pisau diletak semula di tempatnya selepas kerja, dulang dilap bersih, tiada barang tertinggal atas dulang. Rak tepi: pad polish yang tidak digunakan disimpan atau dibuang, tiada botol, tiada telefon atau barang peribadi. Jangan tulis nama atau apa-apa di dinding atau tiang.',
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-toolwall';
select id, ref_photo, jsonb_array_length(bad_photos) n_bad from public.gp_emp_checks where id in ('chk-keybox','chk-toolwall') order by id;
