-- Settings permissions follow the work-role tier, independently of User Admin.
-- Only active accounts with a ranked work role receive write permissions.
create or replace function adhoc_private.adhoc_settings_tier()
returns integer language sql stable security definer set search_path = '' as $$
  select r.rank
  from public.adhoc_profiles p
  join public.tade_roles r on r.name = p.job_role and not r.is_access_role
  where p.id = (select auth.uid()) and p.active
  limit 1;
$$;
revoke all on function adhoc_private.adhoc_settings_tier() from public, anon;
grant execute on function adhoc_private.adhoc_settings_tier() to authenticated;

-- All signed-in work roles can see active entries. Tier 1 and 2 can also see
-- inactive entries so they can reactivate them.
alter policy adhoc_lookup_select on public.adhoc_departments
  using (active or (select adhoc_private.adhoc_settings_tier()) <= 2);
alter policy adhoc_customers_select on public.adhoc_customers
  using (active or (select adhoc_private.adhoc_settings_tier()) <= 2);
alter policy adhoc_tasks_select on public.adhoc_tasks
  using (active or (select adhoc_private.adhoc_settings_tier()) <= 2);

drop policy if exists adhoc_lookup_admin_all on public.adhoc_departments;
drop policy if exists adhoc_customers_admin_all on public.adhoc_customers;
drop policy if exists adhoc_tasks_admin_all on public.adhoc_tasks;
drop policy if exists adhoc_lookup_tracker_insert on public.adhoc_departments;
drop policy if exists adhoc_customers_tracker_insert on public.adhoc_customers;
drop policy if exists adhoc_departments_tier_insert on public.adhoc_departments;
drop policy if exists adhoc_departments_tier_update on public.adhoc_departments;
drop policy if exists adhoc_customers_tier_insert on public.adhoc_customers;
drop policy if exists adhoc_customers_tier_update on public.adhoc_customers;
drop policy if exists adhoc_tasks_tier_update on public.adhoc_tasks;
drop policy if exists adhoc_tasks_tier_delete on public.adhoc_tasks;

create policy adhoc_departments_tier_insert on public.adhoc_departments
  for insert to authenticated
  with check ((select adhoc_private.adhoc_settings_tier()) <= 2);
create policy adhoc_departments_tier_update on public.adhoc_departments
  for update to authenticated
  using ((select adhoc_private.adhoc_settings_tier()) <= 2)
  with check ((select adhoc_private.adhoc_settings_tier()) <= 2);

create policy adhoc_customers_tier_insert on public.adhoc_customers
  for insert to authenticated
  with check ((select adhoc_private.adhoc_settings_tier()) <= 2);
create policy adhoc_customers_tier_update on public.adhoc_customers
  for update to authenticated
  using ((select adhoc_private.adhoc_settings_tier()) <= 2)
  with check ((select adhoc_private.adhoc_settings_tier()) <= 2);

alter policy adhoc_tasks_tracker_insert on public.adhoc_tasks
  with check ((select adhoc_private.adhoc_settings_tier()) is not null);
create policy adhoc_tasks_tier_update on public.adhoc_tasks
  for update to authenticated
  using ((select adhoc_private.adhoc_settings_tier()) <= 2)
  with check ((select adhoc_private.adhoc_settings_tier()) <= 2);
create policy adhoc_tasks_tier_delete on public.adhoc_tasks
  for delete to authenticated
  using ((select adhoc_private.adhoc_settings_tier()) <= 2);
