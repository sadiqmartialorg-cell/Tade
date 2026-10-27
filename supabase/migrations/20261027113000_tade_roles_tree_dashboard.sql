-- TADE role board and multi-role assignments. User Admin is an access role,
-- while the remaining roles can be ordered in the reporting hierarchy.
create table if not exists public.tade_roles (
  name text primary key,
  rank integer not null default 100,
  is_access_role boolean not null default false,
  created_at timestamptz not null default now(),
  constraint tade_roles_name_valid check (length(trim(name)) between 2 and 80),
  constraint tade_roles_rank_valid check (rank between 1 and 10000)
);
alter table public.tade_roles enable row level security;
revoke all on public.tade_roles from anon, authenticated;

insert into public.tade_roles(name,rank,is_access_role) values
  ('Manager',10,false), ('Senior Team Lead',20,false),
  ('Team Lead',30,false), ('Associate Team Lead',40,false),
  ('Management Trainees',50,false), ('Reporting Analyst',60,false),
  ('Workforce Coordinator',70,false), ('Learning and Development',80,false),
  ('Proctor',90,false), ('Super Proctor',100,false),
  ('User Admin',10000,true)
on conflict (name) do nothing;

alter table public.adhoc_profiles
  add column if not exists job_roles text[] not null default '{}'::text[];
alter table public.adhoc_profiles
  drop constraint if exists adhoc_profiles_job_role_check;
update public.adhoc_profiles
set job_roles = array[job_role]
where job_role is not null and cardinality(job_roles) = 0;

create or replace function public.adhoc_is_user_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.adhoc_profiles p
    where p.id = (select auth.uid()) and p.active
      and 'User Admin' = any(p.job_roles)
  );
$$;
revoke all on function public.adhoc_is_user_admin() from public, anon;
grant execute on function public.adhoc_is_user_admin() to authenticated;

create or replace function public.adhoc_dashboard_v2(p_from date, p_to date)
returns jsonb language sql stable security invoker set search_path = '' as $$
  with scoped as materialized (
    select l.* from public.adhoc_logs l
    where l.work_date between p_from and p_to
      and public.adhoc_can_view_user(l.owner_id)
  )
  select jsonb_build_object(
    'totalTasks', (select count(*) from scoped),
    'totalSeconds', (select coalesce(sum(duration_seconds),0) from scoped),
    'activeDays', (select count(distinct work_date) from scoped),
    'contributors', (select count(distinct owner_id) from scoped),
    'byDate', coalesce((select jsonb_agg(jsonb_build_object('date',d.work_date,'tasks',d.tasks,'seconds',d.seconds) order by d.work_date)
      from (select work_date,count(*) tasks,sum(duration_seconds) seconds from scoped group by work_date) d),'[]'::jsonb),
    'byTask', coalesce((select jsonb_agg(jsonb_build_object('name',t.task_name,'tasks',t.tasks,'seconds',t.seconds) order by t.seconds desc)
      from (select task_name,count(*) tasks,sum(duration_seconds) seconds from scoped group by task_name order by seconds desc limit 6) t),'[]'::jsonb),
    'byCustomer', coalesce((select jsonb_agg(jsonb_build_object('name',c.customer_name,'tasks',c.tasks,'seconds',c.seconds) order by c.seconds desc)
      from (select customer_name,count(*) tasks,sum(duration_seconds) seconds from scoped group by customer_name order by seconds desc limit 6) c),'[]'::jsonb),
    'byDepartment', coalesce((select jsonb_agg(jsonb_build_object('name',d.department_name,'tasks',d.tasks,'seconds',d.seconds) order by d.seconds desc)
      from (select department_name,count(*) tasks,sum(duration_seconds) seconds from scoped group by department_name order by seconds desc limit 6) d),'[]'::jsonb),
    'recent', coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.id,'date',r.work_date,'owner',coalesce(p.display_name,'Team member'),
      'task',r.task_name,'customer',r.customer_name,'department',r.department_name,
      'seconds',r.duration_seconds) order by r.work_date desc,r.created_at desc)
      from (select * from scoped order by work_date desc,created_at desc limit 10) r
      left join public.adhoc_profiles p on p.id = r.owner_id),'[]'::jsonb)
  );
$$;
revoke all on function public.adhoc_dashboard_v2(date,date) from public, anon;
grant execute on function public.adhoc_dashboard_v2(date,date) to authenticated;
