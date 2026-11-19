-- ============================================================
--  GP QC — show only QC-app rows in the job list
--  19 Nov 2026
--
--  Why: qc_list reads gp_checklists with no filter, and that
--  table is shared with the old gp-checklist.html app. Old rows
--  (VNS31, CE1, anything from before this build) were showing up
--  in the GP QC list.
--
--  Nothing is deleted. qc_sent_at is stamped by qc_create, so it
--  is only ever set on rows GP QC itself made; legacy rows have
--  it null and simply stop appearing in this one list. The old
--  app is untouched and still sees everything.
-- ============================================================


-- ---- STEP 1 — look before changing anything -----------------
-- Run this on its own first. It shows what is in the table and
-- which side of the line each row falls on.

select id,
       car_plate,
       customer_name,
       created_at,
       qc_sent_at,
       case when qc_sent_at is null then 'OLD — from gp-checklist.html'
            else 'GP QC' end as came_from
  from gp_checklists
 order by coalesce(updated_at, created_at) desc
 limit 50;

-- Expect VNS31 and CE1 to come back as "OLD". If either one says
-- "GP QC", it is a row you made tonight — see step 3.


-- ---- STEP 2 — the filter ------------------------------------
-- Only one line differs from the version you already ran:
--     where qc_sent_at is not null

create or replace function qc_list(p_code text default '', p_limit int default 60)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_want text;
  v_rows jsonb;
begin
  begin
    select value->>'code' into v_want from gp_app_config where key = 'qc_ops_code';
  exception when undefined_table then
    v_want := null;             -- no config table on this server: stay open
  end;

  if coalesce(v_want,'') <> '' and coalesce(p_code,'') <> v_want then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;

  select coalesce(jsonb_agg(row_to_json(t)::jsonb order by t.sort_at desc), '[]'::jsonb)
    into v_rows
  from (
    select id, customer_name, customer_contact, car_model, car_plate, car_type,
           status, sched_date, sched_time,
           out_actual_at, in_actual_at, out_mileage, in_mileage,
           out_pdf_url, in_pdf_url, drive_folder_url,
           (out_share_token is not null) as has_out_link,
           (in_share_token  is not null) as has_in_link,
           jsonb_array_length(coalesce(out_defects,'[]'::jsonb)) as out_marks,
           jsonb_array_length(coalesce(in_defects ,'[]'::jsonb)) as in_marks,
           coalesce(updated_at, created_at) as sort_at
    from gp_checklists
    where qc_sent_at is not null          -- <<< only rows GP QC created
    order by coalesce(updated_at, created_at) desc
    limit greatest(1, least(coalesce(p_limit,60), 200))
  ) t;

  return jsonb_build_object('ok', true, 'locked', coalesce(v_want,'') <> '', 'rows', v_rows);
end;
$$;

grant execute on function qc_list(text,int) to anon, authenticated;


-- ---- STEP 3 — only for real test rows you made tonight ------
-- Leave this alone unless step 1 showed a row marked "GP QC"
-- that you know is a test. Deleting is permanent — there is no
-- undo and no trash. Put the exact ids in by hand; never run it
-- against a plate or a name.
--
-- delete from gp_checklists where id in ('qc261119...','qc261119...');
