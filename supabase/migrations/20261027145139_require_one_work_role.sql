-- Every TADE account has one work role. User Admin is optional access.
alter table public.adhoc_profiles
  drop constraint if exists adhoc_profiles_single_work_role_check;
alter table public.adhoc_profiles
  add constraint adhoc_profiles_single_work_role_check
  check (cardinality(array_remove(job_roles, 'User Admin')) = 1);
