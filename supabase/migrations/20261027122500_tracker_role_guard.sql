-- A User Admin account without a work role has access only to Users, even
-- when calling legacy tracker RPCs directly instead of through the Edge API.
create or replace function adhoc_private.adhoc_has_tracker_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.adhoc_profiles p
    where p.id = (select auth.uid()) and p.active
      and (p.role = 'admin' or exists (
        select 1 from unnest(p.job_roles) as r(name) where r.name <> 'User Admin'
      ))
  );
$$;
revoke all on function adhoc_private.adhoc_has_tracker_access() from public, anon;
grant execute on function adhoc_private.adhoc_has_tracker_access() to authenticated;

do $$
declare signature text;
declare function_sql text;
begin
  foreach signature in array array[
    'public.adhoc_create_session(text)',
    'public.adhoc_rename_session(uuid,text)',
    'public.adhoc_timer_action(uuid,text)',
    'public.adhoc_discard_session(uuid)',
    'public.adhoc_submit_task(uuid,uuid,uuid,uuid,text)'
  ] loop
    select pg_get_functiondef(signature::regprocedure) into function_sql;
    if position('adhoc_has_tracker_access' in function_sql) = 0 then
      execute replace(function_sql, E'begin\n',
        E'begin\n  if not adhoc_private.adhoc_has_tracker_access() then raise exception ''Adhoc Tracker access required''; end if;\n');
    end if;
  end loop;
end $$;
