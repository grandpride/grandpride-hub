-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v1.2 punch reminders (server side, safe to re-run)
--  Run in Supabase Studio -> SQL Editor on gpdb.grandlab.com.my
--  Needs pg_cron + pg_net (both installed). Adds only:
--    1. gp_emp_reminder_log  (one row per person/day/kind -> never double-sends)
--    2. gp_settings 'emp_reminders'  (on/off, times — editable in app Settings)
--    3. function gp_emp_punch_reminders(dry)  + a 5-minute cron job
--  Rules (Mon–Sat, never Sunday):
--    morning: staff (not chauffeurs) with no Punch In by <morning> (default 09:10),
--             not on leave / half-day / pending leave today, who clocked in at least
--             once in the last 14 days (skips resigned/unused accounts), and only if
--             2+ people have already clocked in today (public-holiday guard).
--    lunch:   Lunch Out but no Lunch In after <lunchMins> (default 65) minutes.
-- =====================================================================

create table if not exists public.gp_emp_reminder_log (
  username  text not null,
  date_key  text not null,
  kind      text not null,             -- 'morning' | 'lunch'
  sent_at   timestamptz not null default now(),
  primary key (username, date_key, kind)
);
alter table public.gp_emp_reminder_log enable row level security;   -- no policies: server only

insert into public.gp_settings (id, data, updated_at)
values ('emp_reminders', '{"enabled":true,"morning":"09:10","lunchMins":65}'::jsonb, now())
on conflict (id) do nothing;

create or replace function public.gp_emp_punch_reminders(p_dry boolean default false)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $fn$
declare
  kl      timestamp := now() at time zone 'Asia/Kuala_Lumpur';
  k       text := to_char(kl, 'YYYY-MM-DD');
  nowm    int  := extract(hour from kl)::int * 60 + extract(minute from kl)::int;
  cfg     jsonb := coalesce((select data from public.gp_settings where id = 'emp_reminders'), '{}'::jsonb);
  amtxt   text := coalesce(nullif(cfg->>'morning', ''), '09:10');
  am      int;
  lunch   int  := greatest(45, coalesce(nullif(cfg->>'lunchMins', '')::int, 65));
  url     text := coalesce(nullif(cfg->>'pushUrl', ''), 'http://kong:8000/functions/v1/push-send');
  anon    text := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzkzMDY5NDExLCJleHAiOjE5NTA3NDk0MTF9.ql0qv5ycO4qPDfzLZDdZvjMBqWJMxDRwS8m8HZxUuss';
  hdr     jsonb;
  started int;
  n       int := 0;
  ins     int;
  lo      int;
  r       record;
begin
  if coalesce((cfg->>'enabled')::boolean, true) = false then return 0; end if;
  if extract(isodow from kl) = 7 then return 0; end if;               -- Sunday: closed
  am  := split_part(amtxt, ':', 1)::int * 60 + coalesce(nullif(split_part(amtxt, ':', 2), '')::int, 0);
  hdr := jsonb_build_object('Content-Type', 'application/json', 'apikey', anon, 'Authorization', 'Bearer ' || anon);

  if not p_dry then
    delete from public.gp_emp_reminder_log where sent_at < now() - interval '60 days';
  end if;

  -- 1) Morning: not clocked in -----------------------------------------
  if nowm >= am and nowm < am + 60 then
    select count(*) into started from public.gp_attendance a
     where a.date_key = k and coalesce(a.rec->>'amIn', '') <> '';
    if started >= 2 then
      for r in
        select s.username, s.name
          from public.gp_staff s
         where coalesce(s.is_chauffeur, false) = false
           and s.username <> 'admin'
           and exists (select 1 from public.gp_push_subs p where p.username = s.username)
           and exists (select 1 from public.gp_attendance a
                        where a.username = s.username
                          and a.date_key >= to_char(kl - interval '14 days', 'YYYY-MM-DD') and a.date_key < k
                          and coalesce(a.rec->>'amIn', '') <> '')
           and not exists (select 1 from public.gp_attendance a
                            where a.id = s.username || '|' || k
                              and (coalesce(a.rec->>'amIn', '') <> '' or a.rec ? 'leave' and a.rec->>'leave' is not null
                                   or a.rec->'halfLeave' is not null and jsonb_typeof(a.rec->'halfLeave') = 'object'))
           and not exists (select 1 from public.gp_leave l,
                                  jsonb_array_elements(case when jsonb_typeof(l.rec) = 'array' then l.rec else '[]'::jsonb end) e
                            where l.username = s.username
                              and coalesce(e->>'status', 'Pending') in ('Approved', 'Pending')
                              and coalesce(e->>'from', e->>'date') <= k
                              and coalesce(e->>'to', e->>'from', e->>'date') >= k)
           and not exists (select 1 from public.gp_emp_reminder_log g
                            where g.username = s.username and g.date_key = k and g.kind = 'morning')
      loop
        if p_dry then n := n + 1; continue; end if;
        insert into public.gp_emp_reminder_log(username, date_key, kind) values (r.username, k, 'morning')
        on conflict do nothing;
        get diagnostics ins = row_count;
        if ins > 0 then
          perform net.http_post(
            url := url,
            body := jsonb_build_object('title', '⏰ Not clocked in yet',
                    'body', 'Hi ' || split_part(coalesce(r.name, r.username), ' ', 1) || ', you haven''t punched in today. Tap to clock in.',
                    'target', r.username),
            headers := hdr);
          n := n + 1;
        end if;
      end loop;
    end if;
  end if;

  -- 2) Lunch: out too long, no Lunch In -------------------------------
  if nowm < 17 * 60 then
    for r in
      select s.username, s.name, a.rec->>'lunchOut' as lout
        from public.gp_attendance a
        join public.gp_staff s on s.username = a.username
       where a.date_key = k
         and coalesce(s.is_chauffeur, false) = false
         and coalesce(a.rec->>'lunchOut', '') <> ''
         and coalesce(a.rec->>'lunchIn', '') = ''
         and coalesce(a.rec->>'pmOut', '') = ''
         and exists (select 1 from public.gp_push_subs p where p.username = s.username)
         and not exists (select 1 from public.gp_emp_reminder_log g
                          where g.username = s.username and g.date_key = k and g.kind = 'lunch')
    loop
      begin
        lo := split_part(r.lout, ':', 1)::int * 60 + split_part(r.lout, ':', 2)::int;
      exception when others then continue;
      end;
      if nowm - lo < lunch or nowm - lo > 180 then continue; end if;
      if p_dry then n := n + 1; continue; end if;
      insert into public.gp_emp_reminder_log(username, date_key, kind) values (r.username, k, 'lunch')
      on conflict do nothing;
      get diagnostics ins = row_count;
      if ins > 0 then
        perform net.http_post(
          url := url,
          body := jsonb_build_object('title', '🍽 Lunch break ' || (nowm - lo) || ' min',
                  'body', 'Back from lunch? Remember to punch Lunch In (over 70 min counts as late).',
                  'target', r.username),
          headers := hdr);
        n := n + 1;
      end if;
    end loop;
  end if;

  return n;
end;
$fn$;

-- only the server (cron / postgres) may run it — not the public API
revoke all on function public.gp_emp_punch_reminders(boolean) from public, anon, authenticated;

-- every 5 minutes, 08:00–17:55 Malaysia time (= 00:00–09:55 UTC), Mon–Sat
select cron.unschedule(jobid) from cron.job where jobname = 'gp-emp-punch-reminders';
select cron.schedule('gp-emp-punch-reminders', '*/5 0-9 * * 1-6', 'select public.gp_emp_punch_reminders()');

-- check:   select public.gp_emp_punch_reminders(true);   -- dry run: how many WOULD be reminded right now
--          select * from public.gp_emp_reminder_log order by sent_at desc limit 20;
--          select * from cron.job_run_details where jobid=(select jobid from cron.job where jobname='gp-emp-punch-reminders') order by start_time desc limit 5;
-- off:     select cron.unschedule('gp-emp-punch-reminders');   (or switch off in app Settings)
