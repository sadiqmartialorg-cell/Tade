-- Adhoc Tracker schema, isolated with adhoc_ names for use in an existing Supabase project.
create table if not exists public.adhoc_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'New user',
  role text not null default 'employee' check (role in ('employee','manager','admin')),
  manager_id uuid references public.adhoc_profiles(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  check (manager_id is null or manager_id <> id)
);

create table if not exists public.adhoc_departments (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  active boolean not null default true, sort_order integer not null default 0,
  created_at timestamptz not null default now(), check (length(trim(name)) > 0)
);
create table if not exists public.adhoc_customers (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  active boolean not null default true, sort_order integer not null default 0,
  created_at timestamptz not null default now(), check (length(trim(name)) > 0)
);
create table if not exists public.adhoc_tasks (
  id uuid primary key default gen_random_uuid(), name text not null unique,
  active boolean not null default true, sort_order integer not null default 0,
  created_at timestamptz not null default now(), check (length(trim(name)) > 0)
);

create table if not exists public.adhoc_task_sessions (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  runner_name text not null default 'Task Runner',
  state text not null default 'ready' check (state in ('ready','running','paused','stopped','submitted')),
  work_date date not null default current_date,
  started_at timestamptz,
  active_since timestamptz,
  stopped_at timestamptz,
  accumulated_seconds integer not null default 0 check (accumulated_seconds >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((state = 'running') = (active_since is not null)),
  check (length(trim(runner_name)) > 0)
);
create unique index if not exists adhoc_one_running_session_per_owner
  on public.adhoc_task_sessions(owner_id) where state = 'running';
create index if not exists adhoc_sessions_owner_state_idx
  on public.adhoc_task_sessions(owner_id, state, created_at desc);

create table if not exists public.adhoc_logs (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  session_id uuid unique references public.adhoc_task_sessions(id) on delete set null,
  department_id uuid references public.adhoc_departments(id) on delete set null,
  customer_id uuid references public.adhoc_customers(id) on delete set null,
  task_id uuid references public.adhoc_tasks(id) on delete set null,
  department_name text not null, customer_name text not null, task_name text not null,
  work_date date not null default current_date,
  started_at timestamptz, ended_at timestamptz,
  duration_seconds integer not null check (duration_seconds >= 0),
  remarks text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists adhoc_logs_owner_date_idx on public.adhoc_logs(owner_id, work_date desc);

create or replace function public.adhoc_is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.adhoc_profiles p where p.id = (select auth.uid()) and p.active and p.role = 'admin');
$$;
create or replace function public.adhoc_can_view_user(target_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  with recursive reports(id) as (
    select p.id from public.adhoc_profiles p where p.manager_id = (select auth.uid()) and p.active
    union all
    select p.id from public.adhoc_profiles p join reports r on p.manager_id = r.id where p.active
  )
  select target_id = (select auth.uid()) or exists(select 1 from reports where id = target_id) or public.adhoc_is_admin();
$$;
revoke all on function public.adhoc_is_admin() from public, anon;
revoke all on function public.adhoc_can_view_user(uuid) from public, anon;
grant execute on function public.adhoc_is_admin() to authenticated;
grant execute on function public.adhoc_can_view_user(uuid) to authenticated;

create or replace function public.adhoc_ensure_profile(p_display_name text default null)
returns public.adhoc_profiles language plpgsql security definer set search_path = '' as $$
declare result public.adhoc_profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.adhoc_profiles(id, display_name)
    values ((select auth.uid()), coalesce(nullif(trim(p_display_name), ''), 'New user'))
    on conflict (id) do nothing;
  select * into result from public.adhoc_profiles where id = (select auth.uid()) and active;
  if not found then raise exception 'Account is inactive or not provisioned'; end if;
  return result;
end;
$$;
revoke all on function public.adhoc_ensure_profile(text) from public, anon;
grant execute on function public.adhoc_ensure_profile(text) to authenticated;

create or replace function public.adhoc_touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin new.updated_at = now(); return new; end;
$$;
create trigger adhoc_sessions_updated_at before update on public.adhoc_task_sessions
for each row execute function public.adhoc_touch_updated_at();
create trigger adhoc_logs_updated_at before update on public.adhoc_logs
for each row execute function public.adhoc_touch_updated_at();

create or replace function public.adhoc_create_session(p_runner_name text default 'Task Runner')
returns public.adhoc_task_sessions language plpgsql security definer set search_path = '' as $$
declare result public.adhoc_task_sessions;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.adhoc_task_sessions(owner_id, runner_name)
    values ((select auth.uid()), coalesce(nullif(trim(p_runner_name), ''), 'Task Runner')) returning * into result;
  return result;
end;
$$;

create or replace function public.adhoc_rename_session(p_session_id uuid, p_runner_name text)
returns public.adhoc_task_sessions language plpgsql security definer set search_path = '' as $$
declare result public.adhoc_task_sessions;
begin
  update public.adhoc_task_sessions set runner_name = nullif(trim(p_runner_name), '')
  where id = p_session_id and owner_id = (select auth.uid()) and state in ('ready','running','paused','stopped') returning * into result;
  if not found then raise exception 'Runner not found or cannot be renamed'; end if;
  return result;
end;
$$;

create or replace function public.adhoc_timer_action(p_session_id uuid, p_action text)
returns public.adhoc_task_sessions language plpgsql security definer set search_path = '' as $$
declare result public.adhoc_task_sessions; now_at timestamptz := clock_timestamp();
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into result from public.adhoc_task_sessions where id = p_session_id and owner_id = (select auth.uid()) for update;
  if not found then raise exception 'Runner not found'; end if;
  if p_action = 'start' and result.state = 'ready' then
    update public.adhoc_task_sessions set state='running', started_at=now_at, active_since=now_at, work_date=now_at::date where id=p_session_id returning * into result;
  elsif p_action = 'pause' and result.state = 'running' then
    update public.adhoc_task_sessions set state='paused', active_since=null,
      accumulated_seconds=accumulated_seconds + greatest(0, floor(extract(epoch from (now_at-active_since)))::int)
      where id=p_session_id returning * into result;
  elsif p_action = 'resume' and result.state = 'paused' then
    update public.adhoc_task_sessions set state='running', active_since=now_at where id=p_session_id returning * into result;
  elsif p_action = 'stop' and result.state in ('running','paused') then
    update public.adhoc_task_sessions set state='stopped', active_since=null, stopped_at=now_at,
      accumulated_seconds=accumulated_seconds + case when state='running' then greatest(0, floor(extract(epoch from (now_at-active_since)))::int) else 0 end
      where id=p_session_id returning * into result;
  else raise exception 'Invalid runner transition';
  end if;
  return result;
end;
$$;

create or replace function public.adhoc_discard_session(p_session_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  delete from public.adhoc_task_sessions where id=p_session_id and owner_id=(select auth.uid()) and state <> 'submitted';
  if not found then raise exception 'Runner not found or already submitted'; end if;
  return true;
end;
$$;

create or replace function public.adhoc_submit_task(
  p_session_id uuid, p_department_id uuid, p_customer_id uuid, p_task_id uuid, p_remarks text default ''
)
returns public.adhoc_logs language plpgsql security definer set search_path = '' as $$
declare s public.adhoc_task_sessions; d public.adhoc_departments; c public.adhoc_customers; t public.adhoc_tasks; result public.adhoc_logs;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into s from public.adhoc_task_sessions where id=p_session_id and owner_id=(select auth.uid()) for update;
  if not found or s.state <> 'stopped' then raise exception 'Only a stopped runner can be submitted'; end if;
  select * into d from public.adhoc_departments where id=p_department_id and active;
  select * into c from public.adhoc_customers where id=p_customer_id and active;
  select * into t from public.adhoc_tasks where id=p_task_id and active;
  if d.id is null or c.id is null or t.id is null then raise exception 'Choose active department, customer, and task values'; end if;
  insert into public.adhoc_logs(owner_id, session_id, department_id, customer_id, task_id,
    department_name, customer_name, task_name, work_date, started_at, ended_at, duration_seconds, remarks)
  values ((select auth.uid()), s.id, d.id, c.id, t.id, d.name, c.name, t.name,
    s.work_date, s.started_at, s.stopped_at, s.accumulated_seconds, coalesce(p_remarks,'')) returning * into result;
  update public.adhoc_task_sessions set state='submitted' where id=s.id;
  return result;
end;
$$;
revoke all on function public.adhoc_create_session(text), public.adhoc_rename_session(uuid,text), public.adhoc_timer_action(uuid,text), public.adhoc_discard_session(uuid), public.adhoc_submit_task(uuid,uuid,uuid,uuid,text) from public, anon;
grant execute on function public.adhoc_create_session(text), public.adhoc_rename_session(uuid,text), public.adhoc_timer_action(uuid,text), public.adhoc_discard_session(uuid), public.adhoc_submit_task(uuid,uuid,uuid,uuid,text) to authenticated;

create or replace function public.adhoc_dashboard()
returns jsonb language sql stable security invoker set search_path = '' as $$
  select jsonb_build_object(
    'totalTasks', count(*), 'totalSeconds', coalesce(sum(l.duration_seconds),0),
    'byDate', coalesce((select jsonb_agg(jsonb_build_object('date', x.work_date, 'seconds', x.seconds) order by x.work_date desc)
      from (select work_date, sum(duration_seconds)::int seconds from public.adhoc_logs where public.adhoc_can_view_user(owner_id) group by work_date order by work_date desc limit 30) x), '[]'::jsonb)
  ) from public.adhoc_logs l where public.adhoc_can_view_user(l.owner_id);
$$;

alter table public.adhoc_profiles enable row level security;
alter table public.adhoc_departments enable row level security;
alter table public.adhoc_customers enable row level security;
alter table public.adhoc_tasks enable row level security;
alter table public.adhoc_task_sessions enable row level security;
alter table public.adhoc_logs enable row level security;

create policy adhoc_profiles_select on public.adhoc_profiles for select to authenticated using (public.adhoc_can_view_user(id));
create policy adhoc_profiles_admin_update on public.adhoc_profiles for update to authenticated using (public.adhoc_is_admin()) with check (public.adhoc_is_admin());
create policy adhoc_lookup_select on public.adhoc_departments for select to authenticated using (active or public.adhoc_is_admin());
create policy adhoc_lookup_admin_all on public.adhoc_departments for all to authenticated using (public.adhoc_is_admin()) with check (public.adhoc_is_admin());
create policy adhoc_customers_select on public.adhoc_customers for select to authenticated using (active or public.adhoc_is_admin());
create policy adhoc_customers_admin_all on public.adhoc_customers for all to authenticated using (public.adhoc_is_admin()) with check (public.adhoc_is_admin());
create policy adhoc_tasks_select on public.adhoc_tasks for select to authenticated using (active or public.adhoc_is_admin());
create policy adhoc_tasks_admin_all on public.adhoc_tasks for all to authenticated using (public.adhoc_is_admin()) with check (public.adhoc_is_admin());
create policy adhoc_sessions_owner_all on public.adhoc_task_sessions for all to authenticated using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));
create policy adhoc_logs_select_reporting on public.adhoc_logs for select to authenticated using (public.adhoc_can_view_user(owner_id));
create policy adhoc_logs_owner_update on public.adhoc_logs for update to authenticated using (owner_id=(select auth.uid())) with check (owner_id=(select auth.uid()));

grant select on public.adhoc_profiles, public.adhoc_departments, public.adhoc_customers, public.adhoc_tasks, public.adhoc_task_sessions, public.adhoc_logs to authenticated;
grant update on public.adhoc_profiles to authenticated;
grant insert, update, delete on public.adhoc_departments, public.adhoc_customers, public.adhoc_tasks to authenticated;
grant update on public.adhoc_logs to authenticated;
revoke all on function public.adhoc_dashboard() from public, anon;
grant execute on function public.adhoc_dashboard() to authenticated;
