-- v2.6d: correct reference photo for Office + reception floor = reception floor (Jimmy, 17 Nov 2026). Data only, one row.
-- Office correct photo still to come; when it arrives, ref/office-reception.jpg becomes a stacked image of both.
update public.gp_emp_checks set ref_photo = 'ref/office-reception.jpg', updated_by = 'jimmy', updated_at = now()
 where id = 'chk-office-clean';
select id, title, ref_photo, jsonb_array_length(bad_photos) n_bad from public.gp_emp_checks where id = 'chk-office-clean';
