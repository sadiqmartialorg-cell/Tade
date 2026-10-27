-- Each runner owns its own server timestamps. Concurrent runners no longer
-- contend on a per-owner unique index, and a new runner starts immediately.
drop index if exists public.adhoc_one_running_session_per_owner;

create or replace function public.adhoc_create_session(p_runner_name text default 'Task Runner')
returns public.adhoc_task_sessions
language plpgsql security definer set search_path = '' as $$
declare
  result public.adhoc_task_sessions;
  now_at timestamptz := clock_timestamp();
begin
  if not adhoc_private.adhoc_has_tracker_access() then
    raise exception 'Adhoc Tracker access required';
  end if;
  if auth.uid() is null then raise exception 'Authentication required'; end if;

  insert into public.adhoc_task_sessions
    (owner_id, runner_name, state, started_at, active_since, work_date)
  values
    ((select auth.uid()), coalesce(nullif(trim(p_runner_name), ''), 'Task Runner'),
     'running', now_at, now_at, now_at::date)
  returning * into result;
  return result;
end;
$$;

revoke all on function public.adhoc_create_session(text) from public, anon;
grant execute on function public.adhoc_create_session(text) to authenticated;
