-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v1.9 Grandlab Closing Check (additive, safe to re-run)
--  * gp_emp_checks    : one row per area (Keybox, Wash floor, PPF room …)
--                       reference photo + who does it + who checks + when
--  * gp_emp_check_log : one row per area per day — staff photo + Follow / Not follow
--  * storage bucket   : emp-checks (public read, staff upload) for the photos
--  Touches NOTHING that already exists (attendance, payroll, SOP, docs untouched).
-- =====================================================================

-- ---------- areas ----------
create table if not exists public.gp_emp_checks (
  id          text primary key,
  title       text not null,
  title_bm    text,
  icon        text,
  company     text not null default 'Grandlab',
  slot        text not null default 'closing',           -- 'opening' | 'closing'
  days        jsonb not null default '[1,2,3,4,5,6]'::jsonb,  -- 0=Sun … 6=Sat
  due_time    text not null default '18:00',              -- HH:MM, photo due by
  mode        text not null default 'team',              -- 'team' | 'rotation'
  doers       jsonb not null default '[]'::jsonb,        -- usernames (team mode)
  backups     jsonb not null default '[]'::jsonb,        -- usernames who may cover
  rotation    jsonb not null default '{}'::jsonb,        -- {"start":"YYYY-MM-DD","order":[usernames]} weekly
  checker     text,                                      -- username
  ref_photo   text,                                      -- URL of the "OK" reference photo
  ref_note    text,                                      -- what OK looks like (EN)
  ref_note_bm text,                                      -- (BM)
  start_date  text,                                      -- YYYY-MM-DD, first day it counts
  sort        int  not null default 0,
  active      boolean not null default true,
  updated_by  text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.gp_emp_checks enable row level security;
drop policy if exists emp_checks_read on public.gp_emp_checks;
create policy emp_checks_read on public.gp_emp_checks for select to authenticated
  using (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_checks_write on public.gp_emp_checks;
create policy emp_checks_write on public.gp_emp_checks for all to authenticated
  using (public.gp_emp_is_mgmt()) with check (public.gp_emp_is_mgmt());

-- ---------- daily log ----------
create table if not exists public.gp_emp_check_log (
  id          text primary key,                          -- check_id|YYYY-MM-DD
  check_id    text not null,
  date_key    text not null,
  photo       text,
  sent_by     text,
  sent_at     timestamptz,
  status      text not null default 'sent',              -- 'sent' | 'follow' | 'notfollow'
  checked_by  text,
  checked_at  timestamptz,
  note        text,
  history     jsonb not null default '[]'::jsonb,        -- earlier attempts after a Not follow
  updated_at  timestamptz not null default now()
);
create index if not exists gp_emp_check_log_date_idx on public.gp_emp_check_log (date_key);
alter table public.gp_emp_check_log enable row level security;
drop policy if exists emp_checklog_read on public.gp_emp_check_log;
create policy emp_checklog_read on public.gp_emp_check_log for select to authenticated
  using (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_checklog_insert on public.gp_emp_check_log;
create policy emp_checklog_insert on public.gp_emp_check_log for insert to authenticated
  with check (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_checklog_update on public.gp_emp_check_log;
create policy emp_checklog_update on public.gp_emp_check_log for update to authenticated
  using (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()))
  with check (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_checklog_delete on public.gp_emp_check_log;
create policy emp_checklog_delete on public.gp_emp_check_log for delete to authenticated
  using (public.gp_emp_is_mgmt());

-- ---------- photo storage ----------
insert into storage.buckets (id, name, public)
values ('emp-checks', 'emp-checks', true)
on conflict (id) do nothing;
drop policy if exists emp_checks_obj_read on storage.objects;
create policy emp_checks_obj_read on storage.objects for select to public
  using (bucket_id = 'emp-checks');
drop policy if exists emp_checks_obj_write on storage.objects;
create policy emp_checks_obj_write on storage.objects for insert to authenticated
  with check (bucket_id = 'emp-checks' and exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_checks_obj_delete on storage.objects;
create policy emp_checks_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'emp-checks' and public.gp_emp_is_mgmt());

-- ---------- starting areas (only inserted if missing — never overwrites your edits) ----------
insert into public.gp_emp_checks
  (id, title, title_bm, icon, slot, days, due_time, mode, doers, backups, rotation, checker, ref_photo, ref_note, ref_note_bm, start_date, sort)
values
  ('chk-keybox', 'Keybox locked', 'Kotak kunci dikunci', '🔑', 'closing', '[1,2,3,4,5,6]', '18:00', 'team',
   '["shafiq"]', '["koko"]', '{}', 'jimmy', null,
   'Glass door closed and locked. Every key on its own hook.',
   'Pintu kaca ditutup dan dikunci. Setiap kunci di cangkuk sendiri.',
   '2026-11-16', 10),
  ('chk-washfloor', 'Wash area floor clean', 'Lantai kawasan cuci bersih', '🧹', 'closing', '[1,2,3,4,5,6]', '18:00', 'rotation',
   '[]', '[]', '{"start":"2026-11-16","order":[]}', null, null,
   'Swept and mopped. No rubbish, no leaves, no dried water patches, no tyre marks.',
   'Disapu dan dimop. Tiada sampah, daun, kesan air kering atau kesan tayar.',
   '2026-11-16', 20),
  ('chk-ppfroom', 'PPF room tidy', 'Bilik PPF kemas', '🎞️', 'closing', '[1,2,3,4,5,6]', '18:00', 'team',
   '["koko","myo","sadik","shahadat"]', '[]', '{}', 'shafiq', null,
   'No film offcut on the floor. Rolls stored, boxes off the floor, chair in its place.',
   'Tiada sisa filem di lantai. Gulungan disimpan, kotak tidak di lantai, kerusi di tempatnya.',
   '2026-11-23', 30),
  ('chk-toolwall', 'Polish tool wall in place', 'Dinding alat polish tersusun', '🧰', 'closing', '[1,2,3,4,5,6]', '18:00', 'team',
   '["ahtun","bobo"]', '[]', '{}', 'shafiq', null,
   'Every polisher, pad, bottle and towel back in its own place. Cables coiled.',
   'Setiap mesin polish, pad, botol dan tuala di tempatnya. Kabel digulung kemas.',
   '2026-11-23', 40),
  ('chk-lounge', 'Lounge display set up', 'Paparan lounge disusun', '🛋️', 'opening', '[1,2,3,4,5,6]', '10:00', 'team',
   '["iqa"]', '["sha"]', '{}', 'shafiq', 'ref/lounge.jpg',
   'Set up exactly like the reference photo, left to right.',
   'Susun sama seperti gambar rujukan, dari kiri ke kanan.',
   '2026-11-30', 50),
  ('chk-ppfdeep', 'PPF room deep clean + longkang', 'Cuci mendalam bilik PPF + longkang', '🕳️', 'closing', '[6]', '18:00', 'team',
   '["koko","myo","sadik","shahadat"]', '[]', '{}', 'shafiq', null,
   'Whole room tidied, floor cleared and washed, longkang (drain) clean.',
   'Seluruh bilik dikemas, lantai dibersih, longkang bersih.',
   '2026-11-30', 60)
on conflict (id) do nothing;

select 'v1.9 closing check ready' as result,
       (select count(*) from public.gp_emp_checks) as areas,
       (select count(*) from storage.buckets where id = 'emp-checks') as bucket;
