-- =====================================================================
--  GRANDPRIDE EMPLOYEE SYSTEM — additive migration (safe to re-run)
--  Run once in Supabase Studio -> SQL Editor on gpdb.grandlab.com.my
--  Does NOT touch any existing data. Only adds:
--    1. gp_emp_signups table (self sign-up requests, pending approval)
--    2. three gp_settings rows (approver, app version, HR data holder)
-- =====================================================================

-- 1) Self sign-up requests -------------------------------------------
create table if not exists public.gp_emp_signups (
  id          uuid primary key,          -- = auth.users.id of the new person
  email       text not null,
  name        text not null,
  phone       text,
  company     text,                      -- 'Grandpride' | 'Grandlab'
  role_req    text not null default 'staff'
              check (role_req in ('staff','chauffeur')),
  status      text not null default 'pending'
              check (status in ('pending','approved','rejected')),
  username    text,                      -- set by approver when approved
  note        text,                      -- reject reason / approver note
  decided_by  text,
  decided_at  timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.gp_emp_signups enable row level security;

-- the new person can create ONLY their own pending request
drop policy if exists emp_signups_insert_own on public.gp_emp_signups;
create policy emp_signups_insert_own on public.gp_emp_signups
  for insert to authenticated
  with check (id = auth.uid() and status = 'pending');

-- they can read their own request; existing staff can read all
drop policy if exists emp_signups_select on public.gp_emp_signups;
create policy emp_signups_select on public.gp_emp_signups
  for select to authenticated
  using (
    id = auth.uid()
    or exists (select 1 from public.gp_staff s where s.auth_id = auth.uid())
  );

-- they can edit their own request while it is still pending (e.g. change role);
-- existing staff (the approver) can approve / reject
drop policy if exists emp_signups_update on public.gp_emp_signups;
create policy emp_signups_update on public.gp_emp_signups
  for update to authenticated
  using (
    (id = auth.uid() and status = 'pending')
    or exists (select 1 from public.gp_staff s where s.auth_id = auth.uid())
  )
  with check (
    (id = auth.uid() and status = 'pending')
    or exists (select 1 from public.gp_staff s where s.auth_id = auth.uid())
  );

create index if not exists gp_emp_signups_status_idx on public.gp_emp_signups(status);

-- 2) Settings rows (gp_settings already exists: id, data jsonb, updated_at)
-- Who approves new sign-ups. Change 'jimmy' to someone else any time
-- (or from the app: Profile -> Settings).
insert into public.gp_settings (id, data, updated_at)
values ('emp_signup_approver', '{"username":"jimmy"}'::jsonb, now())
on conflict (id) do nothing;

-- Remote version for auto-update. Bump "version" to force every phone
-- running the Employee app to reload the newest code (no deploy needed
-- for the version itself — just bump after you push a new build).
insert into public.gp_settings (id, data, updated_at)
values ('emp_app_config', '{"version":1,"flags":{}}'::jsonb, now())
on conflict (id) do nothing;

-- HR data used by Payroll view: join date, confirmed date, OT entitled.
-- Shape: { "<username>": { "join":"2025-01-15", "confirmed":"2025-04-15", "ot":true } }
insert into public.gp_settings (id, data, updated_at)
values ('emp_hr', '{}'::jsonb, now())
on conflict (id) do nothing;

-- 3) Speed-ups for the scoped reads the new app does (no bulk loads)
create index if not exists gp_attendance_user_date_idx
  on public.gp_attendance(username, date_key);
create index if not exists gp_attendance_date_idx
  on public.gp_attendance(date_key);

-- =====================================================================
--  v1.1 — profile details (additive). Staff Manager / Hub never send this
--  column, so their upserts leave it untouched.
--  Shape: { gender, marital, personalEmail, address,
--           emergencyName, emergencyRelation, emergencyPhone }
-- =====================================================================
alter table public.gp_staff add column if not exists profile jsonb not null default '{}'::jsonb;
