-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v1.7 Grandlab SOP: categories + numbered steps (additive)
--  * gp_emp_sop       : one row per category (General, Car Wash, …, QC), ordered by sort.
--                       steps = [{text, photo}] ; audience = job titles that must read it
--  * gp_emp_sop_acks  : "I have read & understood" + signature, per person per category.
--                       Counts as signed when ack.version >= category.version
-- =====================================================================
create table if not exists public.gp_emp_sop (
  id         text primary key,
  title      text not null,
  icon       text,
  sort       int  not null default 0,
  intro      text,
  steps      jsonb not null default '[]'::jsonb,
  audience   jsonb not null default '["Detailer","PPF / Wrap Installer","Tinted Installer","QC Person","Junior Technician","Senior Technician"]'::jsonb,
  version    int  not null default 1,
  active     boolean not null default true,
  updated_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.gp_emp_sop enable row level security;
drop policy if exists emp_sop_read on public.gp_emp_sop;
create policy emp_sop_read on public.gp_emp_sop for select to authenticated
  using (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_sop_write on public.gp_emp_sop;
create policy emp_sop_write on public.gp_emp_sop for all to authenticated
  using (public.gp_emp_is_mgmt()) with check (public.gp_emp_is_mgmt());

create table if not exists public.gp_emp_sop_acks (
  id         text primary key,          -- section_id|username
  section_id text not null,
  version    int  not null default 1,
  username   text not null,
  name       text,
  sig_url    text,
  signed_at  timestamptz not null default now()
);
create index if not exists gp_emp_sop_acks_sec_idx on public.gp_emp_sop_acks(section_id);
alter table public.gp_emp_sop_acks enable row level security;
drop policy if exists emp_sop_acks_insert on public.gp_emp_sop_acks;
create policy emp_sop_acks_insert on public.gp_emp_sop_acks for insert to authenticated
  with check (username = public.gp_emp_my_username());
drop policy if exists emp_sop_acks_update on public.gp_emp_sop_acks;
create policy emp_sop_acks_update on public.gp_emp_sop_acks for update to authenticated
  using (username = public.gp_emp_my_username()) with check (username = public.gp_emp_my_username());
drop policy if exists emp_sop_acks_read on public.gp_emp_sop_acks;
create policy emp_sop_acks_read on public.gp_emp_sop_acks for select to authenticated
  using (username = public.gp_emp_my_username() or public.gp_emp_is_mgmt());

-- starter categories (steps are filled in from the app, or from the SOP PDF)
insert into public.gp_emp_sop (id, title, icon, sort, intro, steps) values
  ('sop-general',  'General',  '📋', 10, 'Workshop rules, safety and customer care that apply to every job.', '[]'),
  ('sop-carwash',  'Car Wash', '🫧', 20, null, '[{"text":"Rinse the whole car first.","photo":""},{"text":"Wash the rims with shampoo.","photo":""}]'),
  ('sop-vacuum',   'Vacuum',   '🧹', 30, null, '[]'),
  ('sop-polish',   'Polish',   '✨', 40, null, '[]'),
  ('sop-coating',  'Coating',  '🛡️', 50, null, '[]'),
  ('sop-ppf',      'PPF',      '🎞️', 60, null, '[]'),
  ('sop-wrapping', 'Wrapping', '🎨', 70, null, '[]'),
  ('sop-tinted',   'Tinted',   '🕶️', 80, null, '[]'),
  ('sop-qc',       'QC',       '✅', 90, 'Final quality check before handing the car back.', '[]')
on conflict (id) do nothing;
