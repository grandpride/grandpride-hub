-- v2.2b: tell phones to load build 22 (Change decision override) - run AFTER the new index.html is live
update public.gp_settings set data = jsonb_set(coalesce(data,'{}'::jsonb), '{version}', '22'::jsonb) where id = 'emp_app_config';
select data from public.gp_settings where id = 'emp_app_config';
