-- Sidebar modules are registered once; administrators choose grants per user.
create table public.worklog_modules (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null unique,
  active boolean not null default true,
  sort_order integer not null default 0
);
create table public.worklog_user_modules (
  user_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  module_key text not null references public.worklog_modules(key),
  primary key (user_id, module_key)
);
create index worklog_user_modules_key_idx on public.worklog_user_modules(module_key, user_id);
insert into public.worklog_modules(key,name,sort_order) values
  ('ms_tracker','MS Tracker',10),('reporting_tracker','Reporting Tracker',20);
-- Preserve access for current tracker users. New accounts receive explicit grants.
insert into public.worklog_user_modules(user_id,module_key)
select p.id,'ms_tracker' from public.adhoc_profiles p
where p.role = 'admin' or exists (
  select 1 from unnest(p.job_roles) as r(name) where r.name <> 'User Admin'
);
alter table public.worklog_modules enable row level security;
alter table public.worklog_user_modules enable row level security;
revoke all on public.worklog_modules, public.worklog_user_modules from anon, authenticated;

create function adhoc_private.worklog_has_module(p_key text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.worklog_user_modules grant_row
    join public.adhoc_profiles p on p.id = grant_row.user_id
    join public.worklog_modules m on m.key = grant_row.module_key
    where grant_row.user_id = (select auth.uid()) and grant_row.module_key = p_key
      and p.active and m.active
      and (p.role = 'admin' or exists (
        select 1 from unnest(p.job_roles) as r(name) where r.name <> 'User Admin'
      ))
  );
$$;
revoke all on function adhoc_private.worklog_has_module(text) from public, anon;
grant execute on function adhoc_private.worklog_has_module(text) to authenticated;

create or replace function adhoc_private.adhoc_has_tracker_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select adhoc_private.worklog_has_module('ms_tracker');
$$;

-- Direct Data API reads and writes must honor the same module grant as Edge.
drop policy if exists adhoc_logs_select_reporting on public.adhoc_logs;
create policy adhoc_logs_select_reporting on public.adhoc_logs for select to authenticated
  using ((select adhoc_private.adhoc_has_tracker_access()) and adhoc_private.adhoc_can_view_user(owner_id));
drop policy if exists adhoc_logs_owner_update on public.adhoc_logs;
create policy adhoc_logs_owner_update on public.adhoc_logs for update to authenticated
  using (owner_id = (select auth.uid()) and (select adhoc_private.adhoc_has_tracker_access()))
  with check (owner_id = (select auth.uid()) and (select adhoc_private.adhoc_has_tracker_access()));
drop policy if exists adhoc_sessions_owner_all on public.adhoc_task_sessions;
create policy adhoc_sessions_owner_all on public.adhoc_task_sessions for all to authenticated
  using (owner_id = (select auth.uid()) and (select adhoc_private.adhoc_has_tracker_access()))
  with check (owner_id = (select auth.uid()) and (select adhoc_private.adhoc_has_tracker_access()));
drop policy if exists adhoc_lookup_select on public.adhoc_departments;
create policy adhoc_lookup_select on public.adhoc_departments for select to authenticated
  using ((select adhoc_private.adhoc_has_tracker_access()) and (active or (select adhoc_private.adhoc_settings_tier()) <= 2));
drop policy if exists adhoc_customers_select on public.adhoc_customers;
create policy adhoc_customers_select on public.adhoc_customers for select to authenticated
  using ((select adhoc_private.adhoc_has_tracker_access()) and (active or (select adhoc_private.adhoc_settings_tier()) <= 2));
drop policy if exists adhoc_tasks_select on public.adhoc_tasks;
create policy adhoc_tasks_select on public.adhoc_tasks for select to authenticated
  using ((select adhoc_private.adhoc_has_tracker_access()) and (active or (select adhoc_private.adhoc_settings_tier()) <= 2));
drop policy if exists adhoc_departments_tier_insert on public.adhoc_departments;
create policy adhoc_departments_tier_insert on public.adhoc_departments for insert to authenticated
  with check ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2);
drop policy if exists adhoc_departments_tier_update on public.adhoc_departments;
create policy adhoc_departments_tier_update on public.adhoc_departments for update to authenticated
  using ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2)
  with check ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2);
drop policy if exists adhoc_customers_tier_insert on public.adhoc_customers;
create policy adhoc_customers_tier_insert on public.adhoc_customers for insert to authenticated
  with check ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2);
drop policy if exists adhoc_customers_tier_update on public.adhoc_customers;
create policy adhoc_customers_tier_update on public.adhoc_customers for update to authenticated
  using ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2)
  with check ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2);
drop policy if exists adhoc_tasks_tracker_insert on public.adhoc_tasks;
create policy adhoc_tasks_tracker_insert on public.adhoc_tasks for insert to authenticated
  with check ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) is not null);
drop policy if exists adhoc_tasks_tier_update on public.adhoc_tasks;
create policy adhoc_tasks_tier_update on public.adhoc_tasks for update to authenticated
  using ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2)
  with check ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2);
drop policy if exists adhoc_tasks_tier_delete on public.adhoc_tasks;
create policy adhoc_tasks_tier_delete on public.adhoc_tasks for delete to authenticated
  using ((select adhoc_private.adhoc_has_tracker_access()) and (select adhoc_private.adhoc_settings_tier()) <= 2);

create table public.reporting_departments (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  active boolean not null default true, sort_order integer not null default 0,
  created_at timestamptz not null default now(), check (length(trim(name)) > 0)
);
create table public.reporting_customers (like public.reporting_departments including defaults including constraints including indexes);
create table public.reporting_tasks (like public.reporting_departments including defaults including constraints including indexes);
create table public.reporting_people (
  id uuid primary key default gen_random_uuid(), name text not null,
  department_id uuid not null references public.reporting_departments(id),
  active boolean not null default true, sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  check (length(trim(name)) > 0), unique (name,department_id)
);
create index reporting_people_department_idx on public.reporting_people(department_id);
create table public.reporting_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  runner_name text not null default 'Task Runner',
  state text not null default 'ready' check (state in ('ready','running','paused','stopped','submitted')),
  work_date date not null default current_date,
  started_at timestamptz, active_since timestamptz, stopped_at timestamptz,
  accumulated_seconds integer not null default 0 check (accumulated_seconds >= 0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check ((state = 'running') = (active_since is not null)),
  check (length(trim(runner_name)) > 0)
);
create index reporting_sessions_owner_state_idx on public.reporting_sessions(owner_id,state,created_at desc);
create table public.reporting_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  session_id uuid unique references public.reporting_sessions(id) on delete set null,
  department_id uuid references public.reporting_departments(id) on delete set null,
  customer_id uuid references public.reporting_customers(id) on delete set null,
  task_id uuid references public.reporting_tasks(id) on delete set null,
  raised_by_id uuid references public.reporting_people(id) on delete set null,
  department_name text not null, customer_name text not null, task_name text not null,
  raised_by_name text not null, work_date date not null default current_date,
  started_at timestamptz, ended_at timestamptz,
  duration_seconds integer not null check (duration_seconds >= 0),
  remarks text not null default '', created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index reporting_logs_owner_date_idx on public.reporting_logs(owner_id,work_date desc);
create trigger reporting_sessions_updated_at before update on public.reporting_sessions
  for each row execute function public.adhoc_touch_updated_at();
create trigger reporting_logs_updated_at before update on public.reporting_logs
  for each row execute function public.adhoc_touch_updated_at();

create or replace function adhoc_private.adhoc_pause_runners_on_deactivate()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.active and not new.active then
    update public.adhoc_task_sessions
    set accumulated_seconds=accumulated_seconds
      + greatest(0,floor(extract(epoch from (clock_timestamp()-active_since)))::integer),
      state='paused',active_since=null
    where owner_id=new.id and state='running';
    update public.reporting_sessions
    set accumulated_seconds=accumulated_seconds
      + greatest(0,floor(extract(epoch from (clock_timestamp()-active_since)))::integer),
      state='paused',active_since=null
    where owner_id=new.id and state='running';
  end if;
  return new;
end;
$$;
create function adhoc_private.worklog_pause_on_module_revoke()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.module_key='ms_tracker' then
    update public.adhoc_task_sessions
    set accumulated_seconds=accumulated_seconds
      + greatest(0,floor(extract(epoch from (clock_timestamp()-active_since)))::integer),
      state='paused',active_since=null
    where owner_id=old.user_id and state='running';
  elsif old.module_key='reporting_tracker' then
    update public.reporting_sessions
    set accumulated_seconds=accumulated_seconds
      + greatest(0,floor(extract(epoch from (clock_timestamp()-active_since)))::integer),
      state='paused',active_since=null
    where owner_id=old.user_id and state='running';
  end if;
  return old;
end;
$$;
revoke all on function adhoc_private.worklog_pause_on_module_revoke() from public,anon,authenticated;
create trigger worklog_pause_on_module_revoke after delete on public.worklog_user_modules
  for each row execute function adhoc_private.worklog_pause_on_module_revoke();

create function adhoc_private.worklog_can_view_reportee(p_user uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive reports(id) as (
    select (select auth.uid()) where adhoc_private.worklog_has_module('reporting_tracker')
    union
    select p.id from public.adhoc_profiles p join reports r on p.manager_id=r.id where p.active
  )
  select exists(select 1 from reports where id=p_user);
$$;
revoke all on function adhoc_private.worklog_can_view_reportee(uuid) from public, anon;
grant execute on function adhoc_private.worklog_can_view_reportee(uuid) to authenticated;

alter table public.reporting_departments enable row level security;
alter table public.reporting_customers enable row level security;
alter table public.reporting_tasks enable row level security;
alter table public.reporting_people enable row level security;
alter table public.reporting_sessions enable row level security;
alter table public.reporting_logs enable row level security;
create policy reporting_departments_read on public.reporting_departments for select to authenticated
  using ((select adhoc_private.worklog_has_module('reporting_tracker')) and active);
create policy reporting_customers_read on public.reporting_customers for select to authenticated
  using ((select adhoc_private.worklog_has_module('reporting_tracker')) and active);
create policy reporting_tasks_read on public.reporting_tasks for select to authenticated
  using ((select adhoc_private.worklog_has_module('reporting_tracker')) and active);
create policy reporting_people_read on public.reporting_people for select to authenticated
  using ((select adhoc_private.worklog_has_module('reporting_tracker')) and active);
create policy reporting_sessions_read on public.reporting_sessions for select to authenticated
  using (owner_id=(select auth.uid()) and (select adhoc_private.worklog_has_module('reporting_tracker')));
create policy reporting_logs_read on public.reporting_logs for select to authenticated
  using (adhoc_private.worklog_can_view_reportee(owner_id));
grant select on public.reporting_departments,public.reporting_customers,public.reporting_tasks,
  public.reporting_people,public.reporting_sessions,public.reporting_logs to authenticated;

create function public.reporting_create_session(p_runner_name text default 'Task Runner')
returns public.reporting_sessions language plpgsql security definer set search_path = '' as $$
declare result public.reporting_sessions; now_at timestamptz := clock_timestamp();
begin
  if not adhoc_private.worklog_has_module('reporting_tracker') then raise exception 'Reporting Tracker access required'; end if;
  insert into public.reporting_sessions(owner_id,runner_name,state,started_at,active_since,work_date)
  values ((select auth.uid()),coalesce(nullif(trim(p_runner_name),''),'Task Runner'),'running',now_at,now_at,now_at::date)
  returning * into result;
  return result;
end;
$$;
create function public.reporting_rename_session(p_session_id uuid,p_runner_name text)
returns public.reporting_sessions language plpgsql security definer set search_path = '' as $$
declare result public.reporting_sessions;
begin
  if not adhoc_private.worklog_has_module('reporting_tracker') then raise exception 'Reporting Tracker access required'; end if;
  update public.reporting_sessions set runner_name=nullif(trim(p_runner_name),'')
  where id=p_session_id and owner_id=(select auth.uid()) and state in ('ready','running','paused','stopped')
  returning * into result;
  if not found then raise exception 'Runner not found or cannot be renamed'; end if;
  return result;
end;
$$;
create function public.reporting_timer_action(p_session_id uuid,p_action text)
returns public.reporting_sessions language plpgsql security definer set search_path = '' as $$
declare result public.reporting_sessions; now_at timestamptz := clock_timestamp();
begin
  if not adhoc_private.worklog_has_module('reporting_tracker') then raise exception 'Reporting Tracker access required'; end if;
  select * into result from public.reporting_sessions
  where id=p_session_id and owner_id=(select auth.uid()) for update;
  if not found then raise exception 'Runner not found'; end if;
  if p_action='start' and result.state='ready' then
    update public.reporting_sessions set state='running',started_at=now_at,active_since=now_at,work_date=now_at::date
    where id=p_session_id returning * into result;
  elsif p_action='pause' and result.state='running' then
    update public.reporting_sessions set state='paused',active_since=null,
      accumulated_seconds=accumulated_seconds+greatest(0,floor(extract(epoch from (now_at-active_since)))::int)
    where id=p_session_id returning * into result;
  elsif p_action='resume' and result.state='paused' then
    update public.reporting_sessions set state='running',active_since=now_at
    where id=p_session_id returning * into result;
  elsif p_action='stop' and result.state in ('running','paused') then
    update public.reporting_sessions set state='stopped',active_since=null,stopped_at=now_at,
      accumulated_seconds=accumulated_seconds+case when state='running' then greatest(0,floor(extract(epoch from (now_at-active_since)))::int) else 0 end
    where id=p_session_id returning * into result;
  else raise exception 'Invalid runner transition'; end if;
  return result;
end;
$$;
create function public.reporting_discard_session(p_session_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  if not adhoc_private.worklog_has_module('reporting_tracker') then raise exception 'Reporting Tracker access required'; end if;
  delete from public.reporting_sessions
  where id=p_session_id and owner_id=(select auth.uid()) and state<>'submitted';
  if not found then raise exception 'Runner not found or already submitted'; end if;
  return true;
end;
$$;
create function public.reporting_submit_task(
  p_session_id uuid,p_raised_by_id uuid,p_customer_id uuid,p_task_id uuid,p_remarks text default ''
)
returns public.reporting_logs language plpgsql security definer set search_path = '' as $$
declare s public.reporting_sessions; person public.reporting_people;
  department public.reporting_departments; customer public.reporting_customers;
  task public.reporting_tasks; result public.reporting_logs;
begin
  if not adhoc_private.worklog_has_module('reporting_tracker') then raise exception 'Reporting Tracker access required'; end if;
  select * into s from public.reporting_sessions where id=p_session_id and owner_id=(select auth.uid()) for update;
  if not found or s.state<>'stopped' then raise exception 'Only a stopped runner can be submitted'; end if;
  select * into person from public.reporting_people where id=p_raised_by_id and active;
  select * into department from public.reporting_departments where id=person.department_id and active;
  select * into customer from public.reporting_customers where id=p_customer_id and active;
  select * into task from public.reporting_tasks where id=p_task_id and active;
  if person.id is null or department.id is null or customer.id is null or task.id is null then
    raise exception 'Choose an active requirement raiser, customer, and task';
  end if;
  insert into public.reporting_logs(owner_id,session_id,department_id,customer_id,task_id,raised_by_id,
    department_name,customer_name,task_name,raised_by_name,work_date,started_at,ended_at,duration_seconds,remarks)
  values ((select auth.uid()),s.id,department.id,customer.id,task.id,person.id,
    department.name,customer.name,task.name,person.name,s.work_date,s.started_at,s.stopped_at,s.accumulated_seconds,coalesce(p_remarks,''))
  returning * into result;
  update public.reporting_sessions set state='submitted' where id=s.id;
  return result;
end;
$$;
create function public.reporting_submit_manual_task(
  p_raised_by_id uuid,p_customer_id uuid,p_task_id uuid,p_work_date date,
  p_started_at timestamptz,p_stopped_at timestamptz,p_remarks text default ''
)
returns public.reporting_logs language plpgsql security definer set search_path = '' as $$
declare person public.reporting_people; department public.reporting_departments;
  customer public.reporting_customers; task public.reporting_tasks;
  result public.reporting_logs; seconds numeric;
begin
  if not adhoc_private.worklog_has_module('reporting_tracker') then raise exception 'Reporting Tracker access required'; end if;
  seconds:=floor(extract(epoch from (p_stopped_at-p_started_at)));
  if p_work_date is null or seconds is null or seconds<1 or seconds>2147483647
     or p_stopped_at>clock_timestamp()+interval '1 minute' then
    raise exception 'Choose valid completed start and stop times';
  end if;
  select * into person from public.reporting_people where id=p_raised_by_id and active;
  select * into department from public.reporting_departments where id=person.department_id and active;
  select * into customer from public.reporting_customers where id=p_customer_id and active;
  select * into task from public.reporting_tasks where id=p_task_id and active;
  if person.id is null or department.id is null or customer.id is null or task.id is null then
    raise exception 'Choose an active requirement raiser, customer, and task';
  end if;
  insert into public.reporting_logs(owner_id,department_id,customer_id,task_id,raised_by_id,
    department_name,customer_name,task_name,raised_by_name,work_date,started_at,ended_at,duration_seconds,remarks)
  values ((select auth.uid()),department.id,customer.id,task.id,person.id,
    department.name,customer.name,task.name,person.name,p_work_date,p_started_at,p_stopped_at,seconds::integer,coalesce(p_remarks,''))
  returning * into result;
  return result;
end;
$$;
revoke all on function public.reporting_create_session(text),public.reporting_rename_session(uuid,text),
  public.reporting_timer_action(uuid,text),public.reporting_discard_session(uuid),
  public.reporting_submit_task(uuid,uuid,uuid,uuid,text),
  public.reporting_submit_manual_task(uuid,uuid,uuid,date,timestamptz,timestamptz,text)
  from public,anon;
grant execute on function public.reporting_create_session(text),public.reporting_rename_session(uuid,text),
  public.reporting_timer_action(uuid,text),public.reporting_discard_session(uuid),
  public.reporting_submit_task(uuid,uuid,uuid,uuid,text),
  public.reporting_submit_manual_task(uuid,uuid,uuid,date,timestamptz,timestamptz,text)
  to authenticated;

create function public.reporting_dashboard(p_from date,p_to date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with scoped as materialized (
    select l.* from public.reporting_logs l
    where l.work_date between p_from and p_to
      and adhoc_private.worklog_can_view_reportee(l.owner_id)
  )
  select jsonb_build_object(
    'totalTasks',(select count(*) from scoped),
    'totalSeconds',(select coalesce(sum(duration_seconds),0) from scoped),
    'activeDays',(select count(distinct work_date) from scoped),
    'contributors',(select count(distinct owner_id) from scoped),
    'byDate',coalesce((select jsonb_agg(jsonb_build_object('date',d.work_date,'tasks',d.tasks,'seconds',d.seconds) order by d.work_date)
      from (select work_date,count(*) tasks,sum(duration_seconds) seconds from scoped group by work_date) d),'[]'::jsonb),
    'byTask',coalesce((select jsonb_agg(jsonb_build_object('name',t.task_name,'tasks',t.tasks,'seconds',t.seconds) order by t.seconds desc)
      from (select task_name,count(*) tasks,sum(duration_seconds) seconds from scoped group by task_name order by seconds desc limit 6) t),'[]'::jsonb),
    'byCustomer',coalesce((select jsonb_agg(jsonb_build_object('name',c.customer_name,'tasks',c.tasks,'seconds',c.seconds) order by c.seconds desc)
      from (select customer_name,count(*) tasks,sum(duration_seconds) seconds from scoped group by customer_name order by seconds desc limit 6) c),'[]'::jsonb),
    'byDepartment',coalesce((select jsonb_agg(jsonb_build_object('name',d.department_name,'tasks',d.tasks,'seconds',d.seconds) order by d.seconds desc)
      from (select department_name,count(*) tasks,sum(duration_seconds) seconds from scoped group by department_name order by seconds desc limit 6) d),'[]'::jsonb),
    'recent',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'date',r.work_date,'owner',coalesce(p.display_name,'Team member'),
      'task',r.task_name,'customer',r.customer_name,'department',r.department_name,
      'raisedBy',r.raised_by_name,'seconds',r.duration_seconds) order by r.work_date desc,r.created_at desc)
      from (select * from scoped order by work_date desc,created_at desc limit 10) r
      left join public.adhoc_profiles p on p.id=r.owner_id),'[]'::jsonb)
  );
$$;
revoke all on function public.reporting_dashboard(date,date) from public,anon;
grant execute on function public.reporting_dashboard(date,date) to authenticated;

create function public.reporting_entries(
  p_from date default null,p_to date default null,p_as_of timestamptz default null,
  p_offset integer default 0,p_limit integer default 51
)
returns table (
  id uuid,work_date date,created_at timestamptz,started_at timestamptz,
  ended_at timestamptz,duration_seconds integer,department_name text,
  customer_name text,task_name text,raised_by_name text,remarks text,owner_name text
)
language sql stable security invoker set search_path = '' as $$
  select l.id,l.work_date,l.created_at,l.started_at,l.ended_at,l.duration_seconds,
    l.department_name,l.customer_name,l.task_name,l.raised_by_name,l.remarks,p.display_name
  from public.reporting_logs l
  join public.adhoc_profiles p on p.id=l.owner_id
  where adhoc_private.worklog_can_view_reportee(l.owner_id)
    and (p_from is null or l.work_date>=p_from)
    and (p_to is null or l.work_date<=p_to)
    and (p_as_of is null or l.created_at<=p_as_of)
    and (p_from is null or p_to is null or p_from<=p_to)
  order by l.work_date desc,l.created_at desc,l.id desc
  offset greatest(p_offset,0) limit least(greatest(p_limit,1),500);
$$;
revoke all on function public.reporting_entries(date,date,timestamptz,integer,integer) from public,anon;
grant execute on function public.reporting_entries(date,date,timestamptz,integer,integer) to authenticated;
