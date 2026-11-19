-- ============================================================
--  GP QC — save a half-finished QC as Pending
--  19 Nov 2026
--
--  A driver can now tap Save partway through. Everything goes up,
--  photos and video included, so reopening the same link brings
--  the whole form back. Ops sees the job as Pending until it is
--  actually submitted.
--
--  Additive only. qc_submit is untouched; a QC that is filled in
--  one sitting behaves exactly as it does today.
-- ============================================================


-- ---- 1. when the draft was last saved ----------------------
-- Kept apart from out_actual_at / in_actual_at on purpose: those two
-- are what jobState reads to say "Delivered" or "Returned", so writing
-- them on a draft would make a half-finished QC look complete.

alter table gp_checklists add column if not exists out_draft_at timestamptz;
alter table gp_checklists add column if not exists in_draft_at  timestamptz;


-- ---- 2. the draft save -------------------------------------
/* Same columns qc_submit writes, with three deliberate differences:
     - no out_actual_at / in_actual_at   (not delivered or returned yet)
     - no customer_signed_at             (signature is not final)
     - status 'pending', not awaiting_return / completed
   Everything passed is written as given, so a second save overwrites
   the first and the latest state always wins. */

create or replace function qc_save_draft(p_token text, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id    text;
  v_stage text;
begin
  if coalesce(p_token,'') = '' then
    return jsonb_build_object('ok', false, 'error', 'no token');
  end if;

  select id into v_id from gp_checklists where out_share_token = p_token;
  if found then
    v_stage := 'out';
  else
    select id into v_id from gp_checklists where in_share_token = p_token;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'link not found');
    end if;
    v_stage := 'in';
  end if;

  if v_stage = 'out' then
    update gp_checklists set
      out_mileage         = nullif(p->>'mileage','')::numeric,
      out_petrol          = p->>'petrol',
      out_defects         = p->'defects',
      out_checks          = p->'checks',
      out_items           = p->'items',
      out_photos          = p->'photos',
      out_defect_photos   = p->'defect_photos',
      out_interior_photos = p->'interior_photos',
      out_videos          = p->'videos',
      out_sig_inspector   = p->>'sig_inspector',
      out_sig_customer    = p->>'sig_customer',
      out_driver          = coalesce(nullif(p->>'driver',''), out_driver),
      remark              = coalesce(nullif(p->>'remark',''), remark),
      diagram_w           = nullif(p->>'diagram_w','')::numeric,
      diagram_h           = nullif(p->>'diagram_h','')::numeric,
      out_draft_at        = now(),
      status              = 'pending',
      updated_at          = now()
    where id = v_id;
  else
    update gp_checklists set
      in_mileage         = nullif(p->>'mileage','')::numeric,
      in_petrol          = p->>'petrol',
      in_defects         = p->'defects',
      in_checks          = p->'checks',
      in_items           = p->'items',
      in_photos          = p->'photos',
      in_defect_photos   = p->'defect_photos',
      in_interior_photos = p->'interior_photos',
      in_videos          = p->'videos',
      in_sig_inspector   = p->>'sig_inspector',
      in_sig_customer    = p->>'sig_customer',
      in_driver          = coalesce(nullif(p->>'driver',''), in_driver),
      remark             = coalesce(nullif(p->>'remark',''), remark),
      in_draft_at        = now(),
      status             = 'pending',
      updated_at         = now()
    where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'stage', v_stage, 'saved_at', now());
end;
$$;

grant execute on function qc_save_draft(text,jsonb) to anon, authenticated;


-- ---- 3. qc_load also returns the saved work ----------------
/* Adds the photo and video URLs, the signatures, the remark and the
   draft timestamp. Without these a reopened link came back with the
   answers but no pictures. */

create or replace function qc_load(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r      gp_checklists%rowtype;
  v_stage text;
begin
  if coalesce(p_token,'') = '' then
    return jsonb_build_object('ok', false, 'error', 'no token');
  end if;

  select * into r from gp_checklists where out_share_token = p_token;
  if found then
    v_stage := 'out';
  else
    select * into r from gp_checklists where in_share_token = p_token;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'link not found');
    end if;
    v_stage := 'in';
  end if;

  return jsonb_build_object(
    'ok', true,
    'stage', v_stage,
    'id', r.id,
    'customer_name', r.customer_name,
    'customer_contact', r.customer_contact,
    'car_model', r.car_model,
    'car_plate', r.car_plate,
    'car_type', coalesce(r.car_type,'sedan'),
    'sched_date', r.sched_date,
    'sched_time', r.sched_time,
    'fuel_type', r.fuel_type,
    'lease_from', r.lease_from,
    'lease_to', r.lease_to,
    'mileage_given', r.mileage_given,
    'per_km', r.per_km,
    'ops_remark', r.ops_remark,
    'driver', case when v_stage='out' then r.out_driver else r.in_driver end,
    'location', case when v_stage='out' then r.out_location else r.in_location end,
    -- so a half-finished form can be reopened without losing work
    'done_at', case when v_stage='out' then r.out_actual_at else r.in_actual_at end,
    'draft_at', case when v_stage='out' then r.out_draft_at else r.in_draft_at end,
    'mileage', case when v_stage='out' then r.out_mileage else r.in_mileage end,
    'petrol',  case when v_stage='out' then r.out_petrol  else r.in_petrol end,
    'defects', case when v_stage='out' then r.out_defects else r.in_defects end,
    'checks',  case when v_stage='out' then r.out_checks  else r.in_checks end,
    'items',   case when v_stage='out' then r.out_items   else r.in_items end,
    'remark',  r.remark,
    -- already uploaded, so the form can show them again instead of
    -- asking the driver to pick every photo a second time
    'photos',          case when v_stage='out' then r.out_photos          else r.in_photos end,
    'interior_photos', case when v_stage='out' then r.out_interior_photos else r.in_interior_photos end,
    'defect_photos',   case when v_stage='out' then r.out_defect_photos   else r.in_defect_photos end,
    'videos',          case when v_stage='out' then r.out_videos          else r.in_videos end,
    'sig_inspector',   case when v_stage='out' then r.out_sig_inspector   else r.in_sig_inspector end,
    'sig_customer',    case when v_stage='out' then r.out_sig_customer    else r.in_sig_customer end,
    -- delivery mileage, shown on the return form so the driver can see the start
    'begin_mileage', r.out_mileage,
    'begin_petrol', r.out_petrol,
    -- delivery damage, so the return form can grey it out and the driver
    -- only marks what is genuinely new
    'begin_defects', coalesce(r.out_defects, '[]'::jsonb)
  );
end;
$$;

grant execute on function qc_load(text) to anon, authenticated;


-- ---- 4. the job list shows Pending -------------------------
-- Only the two draft columns are added to what it already returned,
-- plus the legacy filter from gp-qc-hide-legacy.sql which stays.

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
    v_want := null;
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
           out_draft_at, in_draft_at,
           out_pdf_url, in_pdf_url, drive_folder_url,
           (out_share_token is not null) as has_out_link,
           (in_share_token  is not null) as has_in_link,
           jsonb_array_length(coalesce(out_defects,'[]'::jsonb)) as out_marks,
           jsonb_array_length(coalesce(in_defects ,'[]'::jsonb)) as in_marks,
           coalesce(updated_at, created_at) as sort_at
    from gp_checklists
    where qc_sent_at is not null
    order by coalesce(updated_at, created_at) desc
    limit greatest(1, least(coalesce(p_limit,60), 200))
  ) t;

  return jsonb_build_object('ok', true, 'locked', coalesce(v_want,'') <> '', 'rows', v_rows);
end;
$$;

grant execute on function qc_list(text,int) to anon, authenticated;
