/* ============================================================
   GP QC — standalone delivery / return checklist
   Run once in Supabase Studio → SQL Editor on gpdb.grandlab.com.my
   ------------------------------------------------------------
   Everything here is additive. No existing column, policy or row
   is changed, so gp-checklist.html keeps working exactly as it is.

   Design note: the driver link has no login, and ANON_KEY is public
   (it sits in supa.js in a public repo). So the driver page never
   touches gp_checklists directly — it calls these three security
   definer functions, which only ever read or write the single row
   matching the link's token.
   ============================================================ */

-- ---------- 1. new columns ----------
-- "if not exists" so this is safe to re-run and safe if some already exist.

alter table gp_checklists add column if not exists out_items      jsonb;       -- items handed over at delivery
alter table gp_checklists add column if not exists in_items       jsonb;       -- items returned
alter table gp_checklists add column if not exists out_actual_at  timestamptz; -- when the driver actually delivered
alter table gp_checklists add column if not exists in_actual_at   timestamptz; -- when the car actually came back
alter table gp_checklists add column if not exists out_driver     text;
alter table gp_checklists add column if not exists in_driver      text;
alter table gp_checklists add column if not exists out_location   text;
alter table gp_checklists add column if not exists in_location    text;
alter table gp_checklists add column if not exists sched_date     date;        -- what ops planned
alter table gp_checklists add column if not exists sched_time     text;
alter table gp_checklists add column if not exists ops_remark     text;        -- instructions ops leaves the driver
alter table gp_checklists add column if not exists qc_sent_at     timestamptz; -- when the link was created
alter table gp_checklists add column if not exists fuel_type      text;
alter table gp_checklists add column if not exists lease_from     date;
alter table gp_checklists add column if not exists lease_to       date;
alter table gp_checklists add column if not exists mileage_given  numeric;
alter table gp_checklists add column if not exists per_km         numeric;
alter table gp_checklists add column if not exists drive_folder_url text;      -- Drive folder holding the QC photos

-- Token lookups must be fast and unambiguous.
create unique index if not exists gp_checklists_out_token_idx on gp_checklists (out_share_token) where out_share_token is not null;
create unique index if not exists gp_checklists_in_token_idx  on gp_checklists (in_share_token)  where in_share_token  is not null;

-- pgcrypto gives us gen_random_bytes for the tokens.
create extension if not exists pgcrypto;


-- ---------- 2. ops creates a QC link ----------
/* stage 'out' with no checklist_id  -> new row (delivery)
   stage 'in'  with a checklist_id   -> adds a return link to that same row,
                                        so delivery and return stay one record. */
create or replace function qc_create(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_stage text := coalesce(p->>'stage','out');
  v_id    text := coalesce(nullif(p->>'checklist_id',''), null);
  v_tok   text := encode(gen_random_bytes(16),'hex');
begin
  if v_stage not in ('out','in') then
    return jsonb_build_object('ok', false, 'error', 'stage must be out or in');
  end if;

  if v_id is null then
    v_id := 'qc' || to_char(now() at time zone 'Asia/Kuala_Lumpur','YYMMDDHH24MISS')
                 || substr(md5(random()::text),1,4);

    insert into gp_checklists (
      id, plan, status, job_id,
      customer_name, customer_contact, car_model, car_plate, car_type,
      sched_date, sched_time, fuel_type, lease_from, lease_to,
      mileage_given, per_km, ops_remark, created_by, qc_sent_at
    ) values (
      v_id,
      coalesce(p->>'plan','lease'),
      'awaiting_delivery',
      nullif(p->>'job_id','')::uuid,
      upper(coalesce(p->>'customer_name','')),
      p->>'customer_contact',
      upper(coalesce(p->>'car_model','')),
      upper(coalesce(p->>'car_plate','')),
      coalesce(p->>'car_type','sedan'),
      nullif(p->>'sched_date','')::date,
      p->>'sched_time',
      p->>'fuel_type',
      nullif(p->>'lease_from','')::date,
      nullif(p->>'lease_to','')::date,
      nullif(p->>'mileage_given','')::numeric,
      nullif(p->>'per_km','')::numeric,
      p->>'ops_remark',
      coalesce(p->>'created_by','ops'),
      now()
    );
  else
    -- return link on an existing delivery row
    if not exists (select 1 from gp_checklists where id = v_id) then
      return jsonb_build_object('ok', false, 'error', 'checklist not found');
    end if;
  end if;

  if v_stage = 'out' then
    update gp_checklists
       set out_share_token = v_tok,
           out_driver      = coalesce(nullif(p->>'driver',''),   out_driver),
           out_location    = coalesce(nullif(p->>'location',''), out_location),
           qc_sent_at      = now(),
           updated_at      = now()
     where id = v_id;
  else
    update gp_checklists
       set in_share_token = v_tok,
           in_driver      = coalesce(nullif(p->>'driver',''),   in_driver),
           in_location    = coalesce(nullif(p->>'location',''), in_location),
           status         = 'awaiting_return',
           qc_sent_at     = now(),
           updated_at     = now()
     where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'token', v_tok, 'stage', v_stage);
end;
$$;


-- ---------- 3. driver opens the link ----------
/* Returns ONLY the one row the token belongs to, and only the fields the
   driver needs. No other checklist is reachable with this token. */
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
    'mileage', case when v_stage='out' then r.out_mileage else r.in_mileage end,
    'petrol',  case when v_stage='out' then r.out_petrol  else r.in_petrol end,
    'defects', case when v_stage='out' then r.out_defects else r.in_defects end,
    'checks',  case when v_stage='out' then r.out_checks  else r.in_checks end,
    'items',   case when v_stage='out' then r.out_items   else r.in_items end,
    -- delivery mileage, shown on the return form so the driver can see the start
    'begin_mileage', r.out_mileage,
    'begin_petrol', r.out_petrol,
    -- delivery damage, so the return form can grey it out and the driver
    -- only marks what is genuinely new
    'begin_defects', coalesce(r.out_defects, '[]'::jsonb)
  );
end;
$$;


-- ---------- 4. driver submits ----------
/* Photos and videos are uploaded to storage by the browser first; only their
   URLs come in here. Base64 in the row is what caused the 11MB rows and the
   save hangs before, so the row stays small by design. */
create or replace function qc_submit(p_token text, p jsonb)
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
      out_date            = coalesce(nullif(p->>'date','')::date, current_date),
      out_time            = p->>'time',
      out_actual_at       = now(),
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
      status              = 'awaiting_return',
      customer_signed_at  = case when coalesce(p->>'sig_customer','') <> ''
                                 then now() else customer_signed_at end,
      updated_at          = now()
    where id = v_id;
  else
    update gp_checklists set
      in_date            = coalesce(nullif(p->>'date','')::date, current_date),
      in_time            = p->>'time',
      in_actual_at       = now(),
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
      status             = 'completed',
      updated_at         = now()
    where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id, 'stage', v_stage);
end;
$$;


-- ---------- 5. who may call them ----------
/* anon can call the functions, but still cannot select/update the table
   itself -- that is the whole point of security definer here. */
grant execute on function qc_create(jsonb)       to anon, authenticated;
grant execute on function qc_load(text)          to anon, authenticated;
grant execute on function qc_submit(text, jsonb) to anon, authenticated;


-- ---------- 6. check it worked ----------
select 'columns added' as step,
       count(*) filter (where column_name in
         ('out_items','in_items','out_actual_at','in_actual_at',
          'out_driver','in_driver','out_location','in_location',
          'sched_date','sched_time','ops_remark','qc_sent_at')) as new_cols
from information_schema.columns where table_name = 'gp_checklists';

select 'functions created' as step, string_agg(proname, ', ' order by proname) as fns
from pg_proc where proname in ('qc_create','qc_load','qc_submit');


/* ============================================================
   7. qc_list — the ops job list
   ------------------------------------------------------------
   The ops page shows customer names, contacts and plates, so unlike
   qc_create this one is gated. The gate lives in gp_app_config, which
   means you turn it on or off from Studio with no code change:

     -- lock it
     insert into gp_app_config (key, value) values ('qc_ops_code','{"code":"4821"}')
       on conflict (key) do update set value = excluded.value;

     -- open it again
     delete from gp_app_config where key = 'qc_ops_code';

   With no row, it is open — which is how it ships.
   ============================================================ */
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
    order by coalesce(updated_at, created_at) desc
    limit greatest(1, least(coalesce(p_limit,60), 200))
  ) t;

  return jsonb_build_object('ok', true, 'locked', coalesce(v_want,'') <> '', 'rows', v_rows);
end;
$$;

/* Re-issue a link for a job already in the list (ops taps "Return QC"). */
create or replace function qc_relink(p_code text, p_id text, p_stage text, p_driver text default '', p_location text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_want text;
begin
  begin
    select value->>'code' into v_want from gp_app_config where key = 'qc_ops_code';
  exception when undefined_table then
    v_want := null;
  end;
  if coalesce(v_want,'') <> '' and coalesce(p_code,'') <> v_want then
    return jsonb_build_object('ok', false, 'error', 'locked');
  end if;

  return qc_create(jsonb_build_object(
    'stage', p_stage, 'checklist_id', p_id,
    'driver', p_driver, 'location', p_location));
end;
$$;

grant execute on function qc_list(text, int)                       to anon, authenticated;
grant execute on function qc_relink(text, text, text, text, text)  to anon, authenticated;


/* ============================================================
   8. qc_set_pdf — store the Drive links after the PDF is made
   ------------------------------------------------------------
   gp-qc.html calls this once Apps Script has filed the PDF, so the
   job list can link straight to Drive. Token-scoped like the rest:
   it can only write to the row that token belongs to.
   ============================================================ */
create or replace function qc_set_pdf(p_token text, p_pdf text, p_photos text default '')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id text;
begin
  if coalesce(p_token,'') = '' then
    return jsonb_build_object('ok', false, 'error', 'no token');
  end if;

  select id into v_id from gp_checklists where out_share_token = p_token;
  if found then
    update gp_checklists
       set out_pdf_url = nullif(p_pdf,''),
           drive_folder_url = coalesce(nullif(p_photos,''), drive_folder_url),
           updated_at = now()
     where id = v_id;
  else
    select id into v_id from gp_checklists where in_share_token = p_token;
    if not found then
      return jsonb_build_object('ok', false, 'error', 'link not found');
    end if;
    update gp_checklists
       set in_pdf_url = nullif(p_pdf,''),
           drive_folder_url = coalesce(nullif(p_photos,''), drive_folder_url),
           updated_at = now()
     where id = v_id;
  end if;

  return jsonb_build_object('ok', true, 'id', v_id);
end;
$$;

grant execute on function qc_set_pdf(text, text, text) to anon, authenticated;
