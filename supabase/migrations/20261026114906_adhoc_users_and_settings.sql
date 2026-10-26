alter table public.adhoc_profiles add column if not exists email text;
alter table public.adhoc_profiles add column if not exists job_role text;

update public.adhoc_profiles p
set email = u.email
from auth.users u
where p.id = u.id and p.email is distinct from u.email;

create unique index if not exists adhoc_profiles_email_lower_idx
  on public.adhoc_profiles(lower(email)) where email is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.adhoc_profiles'::regclass and conname = 'adhoc_profiles_job_role_check'
  ) then
    alter table public.adhoc_profiles add constraint adhoc_profiles_job_role_check check (
      job_role is null or job_role in (
        'Manager', 'Senior Team Lead', 'Team Lead', 'Associate Team Lead',
        'Management Trainees', 'Reporting Analyst', 'Workforce Coordinator',
        'Learning and Development', 'Proctor', 'Super Proctor'
      )
    );
  end if;
end $$;

create or replace function public.adhoc_ensure_profile(p_display_name text default null)
returns public.adhoc_profiles language plpgsql security definer set search_path = '' as $$
declare result public.adhoc_profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  insert into public.adhoc_profiles(id, display_name, email)
    values (
      (select auth.uid()),
      coalesce(nullif(trim(p_display_name), ''), 'New user'),
      nullif((select auth.jwt() ->> 'email'), '')
    )
    on conflict (id) do nothing;
  select * into result from public.adhoc_profiles where id = (select auth.uid()) and active;
  if not found then raise exception 'Account is inactive or not provisioned'; end if;
  return result;
end;
$$;
