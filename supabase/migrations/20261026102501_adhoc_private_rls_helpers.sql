create schema if not exists adhoc_private;
revoke all on schema adhoc_private from public, anon;
grant usage on schema adhoc_private to authenticated;

create function adhoc_private.adhoc_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.adhoc_profiles p where p.id = (select auth.uid()) and p.active and p.role = 'admin');
$$;
create function adhoc_private.adhoc_can_view_user(target_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive reports(id) as (
    select p.id from public.adhoc_profiles p where p.manager_id = (select auth.uid()) and p.active
    union all
    select p.id from public.adhoc_profiles p join reports r on p.manager_id = r.id where p.active
  )
  select exists(select 1 from public.adhoc_profiles me where me.id = (select auth.uid()) and me.active)
    and (target_id = (select auth.uid()) or exists(select 1 from reports where id = target_id) or adhoc_private.adhoc_is_admin());
$$;
revoke all on function adhoc_private.adhoc_is_admin() from public, anon;
revoke all on function adhoc_private.adhoc_can_view_user(uuid) from public, anon;
grant execute on function adhoc_private.adhoc_is_admin() to authenticated;
grant execute on function adhoc_private.adhoc_can_view_user(uuid) to authenticated;
