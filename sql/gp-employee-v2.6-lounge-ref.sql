-- v2.6: lounge reference photos (Jimmy, 17 Nov 2026). Data only, one row.
update public.gp_emp_checks set
  ref_photo = 'ref/lounge-clean.jpg',
  ref_note = 'Make it look exactly like the reference photos: floor mopped and shiny, all windows wiped, sofa pillows one at the left and one at the right end of each sofa, catalogues laid out on the table like the photo, TV cabinet boxes and diffuser arranged like the photo.',
  ref_note_bm = 'Sama seperti gambar rujukan: lantai dimop dan berkilat, semua tingkap dilap, bantal sofa satu di kiri dan satu di kanan setiap sofa, katalog disusun di atas meja seperti gambar, kotak dan diffuser di kabinet TV disusun seperti gambar.',
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-lounge-clean';
select id, title, ref_photo, rotation->'order' as rotation_order from public.gp_emp_checks where id = 'chk-lounge-clean';
