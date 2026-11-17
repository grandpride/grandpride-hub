-- v2.6c: office + reception floor rules and "not like this" photos (Jimmy, 17 Nov 2026). Data only, one row.
update public.gp_emp_checks set
  ref_note = 'Office and reception floors: no dust at all. Sweep, then mop and wipe the whole floor, including under the desks, chairs and along the walls. No film bits, paper or stains left. Counter wiped, bins emptied.',
  ref_note_bm = 'Lantai pejabat dan kaunter: tiada habuk langsung. Sapu, kemudian mop dan lap seluruh lantai, termasuk bawah meja, kerusi dan tepi dinding. Tiada sisa filem, kertas atau kesan kotor. Kaunter dilap, tong sampah dikosongkan.',
  bad_photos = '[
    {"src":"ref/bad/office-floor-1.jpg","note":"Film bits and dust under the chairs and along the wall"},
    {"src":"ref/bad/office-floor-2.jpg","note":"Dust and marks on the floor"},
    {"src":"ref/bad/office-floor-3.jpg","note":"Dust, stains and bits in the corners"}]'::jsonb,
  updated_by = 'jimmy', updated_at = now()
 where id = 'chk-office-clean';
select id, title, jsonb_array_length(bad_photos) n_bad, rotation->'order' rotation_order from public.gp_emp_checks where id = 'chk-office-clean';
