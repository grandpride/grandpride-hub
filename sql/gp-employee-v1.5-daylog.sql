-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v1.5 Daily Task Log (additive, safe to re-run)
--  * gp_emp_daylog  : one row per person per day (id = username|YYYY-MM-DD)
--      data = {pending[], today[], updates[{time,duration,task,status}], resolved[], improve, remark}
--      readable by the owner and by management (Admin / HOD / Manager / sign-up approver)
--  * gp_emp_secret  : Secret Box messages — insert by the sender, read by management only
--  * 10:00 push (Mon–Sat) when a staff member with Daily Task Log access has clocked in
--    but has no morning plan yet (added to gp_emp_punch_reminders as kind 'plan').
-- =====================================================================
create table if not exists public.gp_emp_daylog (
  id           text primary key,
  username     text not null,
  date_key     text not null,
  data         jsonb not null default '{}'::jsonb,
  planned_at   timestamptz,
  submitted_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists gp_emp_daylog_date_idx on public.gp_emp_daylog(date_key);
create index if not exists gp_emp_daylog_user_idx on public.gp_emp_daylog(username, date_key);
alter table public.gp_emp_daylog enable row level security;

create or replace function public.gp_emp_is_mgmt()
returns boolean language sql stable security definer set search_path = public as $fn$
  select exists (
    select 1 from public.gp_staff s
     where s.auth_id = auth.uid()
       and (s.role in ('Admin','HOD','Manager')
            or s.username = (select data->>'username' from public.gp_settings where id = 'emp_signup_approver'))
  );
$fn$;
create or replace function public.gp_emp_my_username()
returns text language sql stable security definer set search_path = public as $fn$
  select username from public.gp_staff where auth_id = auth.uid() limit 1;
$fn$;
grant execute on function public.gp_emp_is_mgmt() to authenticated;
grant execute on function public.gp_emp_my_username() to authenticated;

drop policy if exists emp_daylog_read on public.gp_emp_daylog;
create policy emp_daylog_read on public.gp_emp_daylog for select to authenticated
  using (username = public.gp_emp_my_username() or public.gp_emp_is_mgmt());
drop policy if exists emp_daylog_write on public.gp_emp_daylog;
create policy emp_daylog_write on public.gp_emp_daylog for insert to authenticated
  with check (username = public.gp_emp_my_username());
drop policy if exists emp_daylog_update on public.gp_emp_daylog;
create policy emp_daylog_update on public.gp_emp_daylog for update to authenticated
  using (username = public.gp_emp_my_username())
  with check (username = public.gp_emp_my_username());

create table if not exists public.gp_emp_secret (
  id         text primary key,
  username   text not null,
  name       text,
  date_key   text not null,
  body       text not null,
  created_at timestamptz not null default now()
);
alter table public.gp_emp_secret enable row level security;
drop policy if exists emp_secret_insert on public.gp_emp_secret;
create policy emp_secret_insert on public.gp_emp_secret for insert to authenticated
  with check (username = public.gp_emp_my_username());
drop policy if exists emp_secret_read on public.gp_emp_secret;
create policy emp_secret_read on public.gp_emp_secret for select to authenticated
  using (public.gp_emp_is_mgmt() or username = public.gp_emp_my_username());

-- 10:00 "morning plan" push, added into the existing reminder function (runs every 5 min)
do $do$ declare d text; blk text; begin
  d := pg_get_functiondef('public.gp_emp_punch_reminders(boolean)'::regprocedure);
  if position('gp_emp_daylog' in d) = 0 then
    blk := $b$
  -- 4) Daily Task Log: clocked in but no morning plan by 10:00 (staff with Task Log access)
  if nowm >= 600 and nowm < 660 then
    for r in
      select s.username, s.name
        from public.gp_attendance a
        join public.gp_staff s on s.username = a.username
       where a.date_key = k
         and coalesce(a.rec->>'amIn', '') <> ''
         and coalesce(s.is_chauffeur, false) = false and (s.resigned_at is null or s.resigned_at >= k)
         and coalesce(s.apps, '[]'::jsonb) ? 'tasklog'
         and exists (select 1 from public.gp_push_subs p where p.username = s.username)
         and not exists (select 1 from public.gp_emp_daylog dl
                          where dl.id = s.username || '|' || k
                            and jsonb_typeof(dl.data->'today') = 'array' and jsonb_array_length(dl.data->'today') > 0)
         and not exists (select 1 from public.gp_emp_reminder_log g
                          where g.username = s.username and g.date_key = k and g.kind = 'plan')
    loop
      if p_dry then n := n + 1; continue; end if;
      insert into public.gp_emp_reminder_log(username, date_key, kind) values (r.username, k, 'plan')
      on conflict do nothing;
      get diagnostics ins = row_count;
      if ins > 0 then
        perform net.http_post(
          url := url,
          body := jsonb_build_object('title', '📝 Morning plan',
                  'body', 'Hi ' || split_part(coalesce(r.name, r.username), ' ', 1) || ', add today''s plan (min. 3 tasks) in your Daily Task Log.',
                  'target', r.username),
          headers := hdr);
        n := n + 1;
      end if;
    end loop;
  end if;

  return n;
end;$b$;
    d := regexp_replace(d, '\n\s*return n;\s*\nend;', blk);
    execute d;
  end if;
end $do$;
