-- v2.6i: Lounge display set up (Iqa) shows all 3 lounge photos (same stacked image as Lounge floor) (Jimmy, 17 Nov 2026). Data only, one row.
update public.gp_emp_checks set ref_photo = 'ref/lounge-clean.jpg', updated_by = 'jimmy', updated_at = now()
 where id = 'chk-lounge';
select id, title, ref_photo from public.gp_emp_checks where id in ('chk-lounge','chk-lounge-clean') order by id;
