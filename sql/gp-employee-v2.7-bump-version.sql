-- build 24 live: tell installed apps to refresh
update public.gp_settings set data = jsonb_set(coalesce(data,'{}'::jsonb), '{version}', '24'::jsonb) where id = 'emp_app_config';
select data from public.gp_settings where id = 'emp_app_config';
