alter table public.reporting_people
  add column email text,
  add constraint reporting_people_talview_email_check check (
    email is null or (email ~ '^[a-z0-9]([a-z0-9._+-]{0,62}[a-z0-9])?@talview[.]com$' and email not like '%..%')
  ),
  add constraint reporting_people_email_key unique (email),
  drop constraint reporting_people_name_department_id_key;

create unique index reporting_people_legacy_name_department_idx
  on public.reporting_people (name, department_id) where email is null;

-- The existing signed-in tracker queries keep access to their current columns.
-- Requester emails are returned by the Edge Function after it checks module access.
revoke select on public.reporting_people from anon, authenticated;
grant select (id, name, department_id, active, sort_order, created_at)
  on public.reporting_people to authenticated;
