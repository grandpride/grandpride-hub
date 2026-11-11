-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v2.0 Grandlab Team Incentive (additive, safe to re-run)
--  * gp_emp_issues          : car QC issues (QC fail / customer complaint) with photo,
--                             reported by QC / management. Counts against a team's month.
--  * gp_emp_incentive_month : a month that management has CLOSED (tier + payout frozen)
--  * gp_settings 'emp_team_incentive' : the team set-up (members, head, areas, tiers)
--  Touches NOTHING that already exists.
-- =====================================================================

create table if not exists public.gp_emp_issues (
  id           text primary key,
  team_id      text not null,
  date_key     text not null,                 -- YYYY-MM-DD
  kind         text not null default 'qc',    -- 'qc' | 'complaint' | 'other'
  plate        text,
  reason       text not null,
  photo        text,
  reported_by  text not null,
  created_at   timestamptz not null default now(),
  voided       boolean not null default false,
  voided_by    text,
  void_note    text,
  voided_at    timestamptz
);
create index if not exists gp_emp_issues_date_idx on public.gp_emp_issues (date_key);
alter table public.gp_emp_issues enable row level security;
drop policy if exists emp_issues_read on public.gp_emp_issues;
create policy emp_issues_read on public.gp_emp_issues for select to authenticated
  using (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_issues_insert on public.gp_emp_issues;
create policy emp_issues_insert on public.gp_emp_issues for insert to authenticated
  with check (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_issues_update on public.gp_emp_issues;
create policy emp_issues_update on public.gp_emp_issues for update to authenticated
  using (public.gp_emp_is_mgmt()) with check (public.gp_emp_is_mgmt());

create table if not exists public.gp_emp_incentive_month (
  id          text primary key,               -- team_id|YYYY-MM
  team_id     text not null,
  month       text not null,                  -- YYYY-MM
  tier        int  not null,
  amount      numeric not null,
  issues      int  not null default 0,
  warnings    int  not null default 0,
  detail      jsonb not null default '{}'::jsonb,   -- issue list, payout per person
  closed_by   text,
  closed_at   timestamptz not null default now()
);
alter table public.gp_emp_incentive_month enable row level security;
drop policy if exists emp_incmonth_read on public.gp_emp_incentive_month;
create policy emp_incmonth_read on public.gp_emp_incentive_month for select to authenticated
  using (exists (select 1 from public.gp_staff s where s.auth_id = auth.uid()));
drop policy if exists emp_incmonth_write on public.gp_emp_incentive_month;
create policy emp_incmonth_write on public.gp_emp_incentive_month for all to authenticated
  using (public.gp_emp_is_mgmt()) with check (public.gp_emp_is_mgmt());

-- team set-up (only created if missing — never overwrites changes made in the app)
insert into public.gp_settings (id, data)
values ('emp_team_incentive', '{
  "teams": [{
    "id": "gl-wash-detail",
    "name": "Car Wash & Detailing",
    "members": ["zawmin","ahtun","bobo","jojo"],
    "head": null,
    "head_pct": 20,
    "areas": ["chk-washfloor","chk-toolwall"],
    "tiers": [500,600,1000,1500,2000],
    "drop": 2,
    "warnings_allowed": 2,
    "start_month": "2026-12",
    "reporters": ["shafiq","jimmy"]
  }]
}'::jsonb)
on conflict (id) do nothing;

select 'v2.0 team incentive ready' as result,
       (select count(*) from public.gp_settings where id='emp_team_incentive') as setup_row;
