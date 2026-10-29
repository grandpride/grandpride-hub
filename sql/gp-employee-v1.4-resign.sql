-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v1.4 resigned staff (additive, safe to re-run)
--  * gp_staff.resigned_at (YYYY-MM-DD last working day) + resigned_note
--  * gp_emp_set_resigned(username, date, note): approver / Admin only.
--      date = null  -> re-activate
--      date <= today -> blocked straight away (login banned, pushes removed)
--      date in future -> blocked automatically on that day (nightly job)
--  History (attendance, leave, payroll) is KEPT. Nothing is deleted except
--  the person's push subscriptions.
-- =====================================================================
alter table public.gp_staff add column if not exists resigned_at   text;
alter table public.gp_staff add column if not exists resigned_note text;

create or replace function public.gp_emp_set_resigned(p_username text, p_date text, p_note text default null)
returns text
language plpgsql
security definer
set search_path = public
as $fn$
declare
  me     record;
  target record;
  appr   text;
  k      text := to_char(now() at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM-DD');
begin
  select * into me from public.gp_staff where auth_id = auth.uid() limit 1;
  if me.username is null then raise exception 'Not a staff account'; end if;
  select data->>'username' into appr from public.gp_settings where id = 'emp_signup_approver';
  if not (me.role = 'Admin' or me.username = appr) then raise exception 'Only the sign-up approver or Admin can do this'; end if;
  select * into target from public.gp_staff where username = p_username;
  if target.username is null then raise exception 'No such staff'; end if;
  if target.username = me.username or target.username = 'admin' then raise exception 'Not allowed for this account'; end if;

  if p_date is null or p_date = '' then
    update public.gp_staff set resigned_at = null, resigned_note = null, updated_at = now() where username = p_username;
    if target.auth_id is not null then update auth.users set banned_until = null where id = target.auth_id; end if;
    return 'active';
  end if;

  update public.gp_staff set resigned_at = p_date, resigned_note = nullif(p_note, ''), updated_at = now() where username = p_username;
  if p_date <= k then
    delete from public.gp_push_subs where username = p_username;
    if target.auth_id is not null then update auth.users set banned_until = 'infinity' where id = target.auth_id; end if;
    return 'resigned';
  end if;
  return 'scheduled';
end;
$fn$;
revoke all on function public.gp_emp_set_resigned(text, text, text) from public, anon;
grant execute on function public.gp_emp_set_resigned(text, text, text) to authenticated;

-- nightly 00:05 Malaysia time: block anyone whose last day has passed
create or replace function public.gp_emp_apply_resignations()
returns integer
language plpgsql
security definer
set search_path = public
as $fn$
declare
  k text := to_char(now() at time zone 'Asia/Kuala_Lumpur', 'YYYY-MM-DD');
  n int;
begin
  delete from public.gp_push_subs p using public.gp_staff s
   where s.username = p.username and s.resigned_at is not null and s.resigned_at < k;
  update auth.users u set banned_until = 'infinity'
    from public.gp_staff s
   where s.auth_id = u.id and s.resigned_at is not null and s.resigned_at < k
     and (u.banned_until is null or u.banned_until < now());
  get diagnostics n = row_count;
  return n;
end;
$fn$;
revoke all on function public.gp_emp_apply_resignations() from public, anon, authenticated;
select cron.unschedule(jobid) from cron.job where jobname = 'gp-emp-resignations';
select cron.schedule('gp-emp-resignations', '5 16 * * *', 'select public.gp_emp_apply_resignations()');
