-- One authorization lookup per tracker request; the private helper verifies
-- the active profile, work role, module grant, and active module.
create function public.worklog_module_access(p_key text)
returns boolean language sql stable security invoker set search_path = '' as $$
  select adhoc_private.worklog_has_module(p_key);
$$;
revoke all on function public.worklog_module_access(text) from public,anon;
grant execute on function public.worklog_module_access(text) to authenticated;
