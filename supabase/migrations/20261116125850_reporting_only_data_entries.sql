-- Data entries follow the reporting tree only. The existing dashboard and
-- log policies retain their legacy admin behavior.
create function public.adhoc_reported_entries(
  p_from date default null,
  p_to date default null,
  p_as_of timestamptz default null,
  p_offset integer default 0,
  p_limit integer default 51
)
returns table (
  id uuid,
  work_date date,
  created_at timestamptz,
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  department_name text,
  customer_name text,
  task_name text,
  remarks text,
  owner_name text
)
language sql stable security invoker set search_path = '' as $$
  with recursive reports(person_id) as (
    select (select auth.uid())
    where (select adhoc_private.adhoc_has_tracker_access())
    union
    select p.id
    from public.adhoc_profiles p
    join reports r on p.manager_id = r.person_id
    where p.active
  )
  select l.id, l.work_date, l.created_at, l.started_at, l.ended_at,
    l.duration_seconds, l.department_name, l.customer_name, l.task_name,
    l.remarks, p.display_name
  from public.adhoc_logs l
  join reports r on r.person_id = l.owner_id
  join public.adhoc_profiles p on p.id = l.owner_id
  where (p_from is null or l.work_date >= p_from)
    and (p_to is null or l.work_date <= p_to)
    and (p_as_of is null or l.created_at <= p_as_of)
    and (p_from is null or p_to is null or p_from <= p_to)
  order by l.work_date desc, l.created_at desc, l.id desc
  offset greatest(p_offset, 0)
  limit least(greatest(p_limit, 1), 500);
$$;

revoke all on function public.adhoc_reported_entries(date,date,timestamptz,integer,integer) from public, anon;
grant execute on function public.adhoc_reported_entries(date,date,timestamptz,integer,integer) to authenticated;
