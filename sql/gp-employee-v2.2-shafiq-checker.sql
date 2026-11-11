-- =====================================================================
--  GRANDPRIDE EMPLOYEE — v2.2 Shafiq checks both teams + Jimmy override trail (11 Nov 2026)
--  Additive, safe to re-run.
--  * gp_emp_check_log.overrides : list of "Change decision" by management (who, when, why)
--  * Checker -> Shafiq for wash floor + all 5 PPF-team areas
--    (Keybox + Boss room stay Jimmy: Shafiq is the doer there)
-- =====================================================================

alter table public.gp_emp_check_log
  add column if not exists overrides jsonb not null default '[]'::jsonb;

update public.gp_emp_checks set checker = 'shafiq', updated_by = 'jimmy', updated_at = now()
 where id in ('chk-washfloor','chk-ppfroom','chk-ppfdeep','chk-lounge-clean','chk-office-clean','chk-reception-clean')
   and checker is distinct from 'shafiq';

select id, title, doers, rotation, checker from public.gp_emp_checks order by sort;
