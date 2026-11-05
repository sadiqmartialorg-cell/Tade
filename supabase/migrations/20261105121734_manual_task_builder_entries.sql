-- Task Builder can record completed work directly, without a timer session.
create function public.adhoc_submit_manual_task(
  p_department_id uuid,
  p_customer_id uuid,
  p_task_id uuid,
  p_work_date date,
  p_started_at timestamptz,
  p_stopped_at timestamptz,
  p_remarks text default ''
)
returns public.adhoc_logs
language plpgsql security definer set search_path = '' as $$
declare
  d public.adhoc_departments;
  c public.adhoc_customers;
  t public.adhoc_tasks;
  result public.adhoc_logs;
  seconds numeric;
begin
  if (select auth.uid()) is null then raise exception 'Authentication required'; end if;
  if not adhoc_private.adhoc_has_tracker_access() then
    raise exception 'Adhoc Tracker access required';
  end if;
  seconds := floor(extract(epoch from (p_stopped_at - p_started_at)));
  if p_work_date is null or seconds is null or seconds < 1 or seconds > 2147483647
     or p_stopped_at > clock_timestamp() + interval '1 minute' then
    raise exception 'Choose valid completed start and stop times';
  end if;
  select * into d from public.adhoc_departments where id = p_department_id and active;
  select * into c from public.adhoc_customers where id = p_customer_id and active;
  select * into t from public.adhoc_tasks where id = p_task_id and active;
  if d.id is null or c.id is null or t.id is null then
    raise exception 'Choose active department, customer, and task values';
  end if;
  insert into public.adhoc_logs(
    owner_id, department_id, customer_id, task_id,
    department_name, customer_name, task_name, work_date,
    started_at, ended_at, duration_seconds, remarks
  ) values (
    (select auth.uid()), d.id, c.id, t.id,
    d.name, c.name, t.name, p_work_date,
    p_started_at, p_stopped_at, seconds::integer, coalesce(p_remarks, '')
  ) returning * into result;
  return result;
end;
$$;

revoke all on function public.adhoc_submit_manual_task(uuid,uuid,uuid,date,timestamptz,timestamptz,text) from public, anon;
grant execute on function public.adhoc_submit_manual_task(uuid,uuid,uuid,date,timestamptz,timestamptz,text) to authenticated;
