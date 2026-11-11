-- v1.9 step 3: tell phones to load the new app build (run AFTER the new index.html is live)
update public.gp_settings set data = jsonb_set(coalesce(data,'{}'::jsonb), '{version}', '19'::jsonb) where id = 'emp_app_config';
select data from public.gp_settings where id = 'emp_app_config';
