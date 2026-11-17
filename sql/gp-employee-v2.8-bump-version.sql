-- build 25 live: tell installed apps to refresh
update public.gp_settings set data = jsonb_set(coalesce(data,'{}'::jsonb), '{version}', '25'::jsonb) where id = 'emp_app_config';
select data from public.gp_settings where id = 'emp_app_config';
