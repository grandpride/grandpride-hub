-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v1.3 Project board (additive, safe to re-run)
--  One row per project. Progress updates live in the row's "updates" array
--  (photos go to ImgBB, only the URL is stored).
-- =====================================================================
create table if not exists public.gp_emp_projects (
  id          text primary key,                       -- 'pj' + timestamp
  title       text not null,
  client      text,                                   -- customer / car / plate
  description text,
  status      text not null default 'todo'
              check (status in ('todo','doing','review','done')),
  priority    text not null default 'normal'
              check (priority in ('low','normal','high')),
  due_date    text,                                   -- YYYY-MM-DD (local)
  assignees   jsonb not null default '[]'::jsonb,     -- ["alex","koko"]
  owner       text,                                   -- username who manages it
  company     text,
  created_by  text,
  updates     jsonb not null default '[]'::jsonb,     -- [{by,name,at,text,photo,status}]
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.gp_emp_projects enable row level security;

-- any signed-in staff member (has a gp_staff row) can read & work on projects
drop policy if exists emp_projects_staff on public.gp_emp_projects;
create policy emp_projects_staff on public.gp_emp_projects
  for all to authenticated
  using (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()))
  with check (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));

create index if not exists gp_emp_projects_status_idx  on public.gp_emp_projects(status, updated_at desc);
create index if not exists gp_emp_projects_assign_idx  on public.gp_emp_projects using gin (assignees);
