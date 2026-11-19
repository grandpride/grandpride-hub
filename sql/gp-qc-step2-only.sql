-- GP QC — hide the old gp-checklist.html rows from the QC job list.
-- Select all, copy, paste into Supabase Studio -> SQL Editor -> Run.
-- Nothing is deleted; only this one list is filtered.

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
