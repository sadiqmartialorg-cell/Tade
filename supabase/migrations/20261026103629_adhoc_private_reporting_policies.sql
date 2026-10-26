alter policy adhoc_profiles_admin_update on public.adhoc_profiles
  using (adhoc_private.adhoc_is_admin()) with check (adhoc_private.adhoc_is_admin());
alter policy adhoc_logs_select_reporting on public.adhoc_logs
  using (adhoc_private.adhoc_can_view_user(owner_id));

alter policy adhoc_lookup_select on public.adhoc_departments using (active);
alter policy adhoc_lookup_admin_all on public.adhoc_departments
  using (adhoc_private.adhoc_is_admin()) with check (adhoc_private.adhoc_is_admin());
alter policy adhoc_customers_select on public.adhoc_customers using (active);
alter policy adhoc_customers_admin_all on public.adhoc_customers
  using (adhoc_private.adhoc_is_admin()) with check (adhoc_private.adhoc_is_admin());
alter policy adhoc_tasks_select on public.adhoc_tasks using (active);
alter policy adhoc_tasks_admin_all on public.adhoc_tasks
  using (adhoc_private.adhoc_is_admin()) with check (adhoc_private.adhoc_is_admin());

revoke execute on function public.adhoc_is_admin() from authenticated;
revoke execute on function public.adhoc_can_view_user(uuid) from authenticated;

create or replace function public.adhoc_dashboard()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'totalTasks', count(*), 'totalSeconds', coalesce(sum(l.duration_seconds),0),
    'byDate', coalesce((select jsonb_agg(jsonb_build_object('date', x.work_date, 'seconds', x.seconds) order by x.work_date desc)
      from (select work_date, sum(duration_seconds)::int seconds from public.adhoc_logs where adhoc_private.adhoc_can_view_user(owner_id) group by work_date order by work_date desc limit 30) x), '[]'::jsonb)
  ) from public.adhoc_logs l where adhoc_private.adhoc_can_view_user(l.owner_id);
$$;
