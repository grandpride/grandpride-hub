-- v2.6b: lounge — vacuum the sofa holes (Jimmy, 17 Nov 2026). Data only, one row.
update public.gp_emp_checks set
  ref_note = 'Make it look exactly like the reference photos: floor mopped and shiny, all windows wiped, sofa holes (button tufts) vacuumed with the soft brush — no small stones, sofa pillows one at the left and one at the right end of each sofa, catalogues laid out on the table like the photo, TV cabinet boxes and diffuser arranged like the photo.',
  ref_note_bm = 'Sama seperti gambar rujukan: lantai dimop dan berkilat, semua tingkap dilap, lubang sofa divakum dengan berus lembut — tiada batu kecil, bantal sofa satu di kiri dan satu di kanan setiap sofa, katalog disusun di atas meja seperti gambar, kotak dan diffuser di kabinet TV disusun seperti gambar.',
  bad_photos = '[{"src":"ref/bad/lounge-sofa-holes.jpg","note":"Small stones collect in the sofa holes — vacuum with the soft brush"}]'::jsonb,
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-lounge-clean';
select id, title, jsonb_array_length(bad_photos) n_bad, left(ref_note, 80) note from public.gp_emp_checks where id = 'chk-lounge-clean';
