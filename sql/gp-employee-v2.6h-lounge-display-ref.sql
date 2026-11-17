-- v2.6h: Lounge display set up (Iqa) -> new TV cabinet reference photo (Jimmy, 17 Nov 2026). Data only, one row.
-- Old photo ref/lounge.jpg is kept in the repo (not deleted).
update public.gp_emp_checks set ref_photo = 'ref/lounge-display-v2.jpg',
  ref_note = 'TV cabinet set up exactly like the reference photo, left to right: AX Film box, books, diffuser, colour books, orange box. Sofa pillows left and right. Catalogues on the table.',
  ref_note_bm = 'Kabinet TV disusun sama seperti gambar rujukan, dari kiri ke kanan: kotak AX Film, buku, diffuser, buku berwarna, kotak oren. Bantal sofa kiri dan kanan. Katalog di atas meja.',
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-lounge';
select id, title, ref_photo from public.gp_emp_checks where id = 'chk-lounge';
