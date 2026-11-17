-- v2.6j: Boss room correct reference photos + rules (Jimmy, 17 Nov 2026). Data only, one row.
update public.gp_emp_checks set ref_photo = 'ref/bossroom.jpg',
  ref_note = 'Every Monday and Wednesday morning, like the photos: orange sofa pillows left and right in the same place, sheep in the middle of the sofa, tea table cups and teapots all in the same place. Drinking water bottle refilled when less than 70% full. Desk wiped, floor and carpet clean, bin emptied.',
  ref_note_bm = 'Setiap Isnin dan Rabu pagi, seperti gambar: bantal sofa oren kiri dan kanan di tempat sama, kambing di tengah sofa, cawan dan teko di meja teh semua di tempat sama. Botol air minuman diisi semula bila kurang dari 70%. Meja dilap, lantai dan karpet bersih, tong sampah dikosongkan.',
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-bossroom';
select id, title, doers, days, ref_photo from public.gp_emp_checks where id = 'chk-bossroom';
