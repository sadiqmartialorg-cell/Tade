-- Existing access tokens must not retain direct table access after deactivation.
create or replace function adhoc_private.adhoc_is_active()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.adhoc_profiles p
    where p.id = (select auth.uid()) and p.active
  );
$$;

revoke all on function adhoc_private.adhoc_is_active() from public, anon;
grant execute on function adhoc_private.adhoc_is_active() to authenticated;

alter policy adhoc_sessions_owner_all on public.adhoc_task_sessions
  using (owner_id = (select auth.uid()) and (select adhoc_private.adhoc_is_active()))
  with check (owner_id = (select auth.uid()) and (select adhoc_private.adhoc_is_active()));

alter policy adhoc_logs_owner_update on public.adhoc_logs
  using (owner_id = (select auth.uid()) and (select adhoc_private.adhoc_is_active()))
  with check (owner_id = (select auth.uid()) and (select adhoc_private.adhoc_is_active()));
