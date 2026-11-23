-- Production already has this name. A fresh install still creates tade_roles.
do $migration$
declare
  routine regprocedure;
  definition text;
begin
  if to_regclass('public."Work_log_roles"') is null then
    alter table public.tade_roles rename to "Work_log_roles";
  elsif to_regclass('public.tade_roles') is not null then
    raise exception 'Both role tables exist. Resolve the duplicate before migrating.';
  end if;

  -- Preserve each routine's body, security mode, and grants apart from the table reference.
  foreach routine in array array[
    'adhoc_private.adhoc_settings_tier()'::regprocedure,
    'public.worklog_roster_publish_team(uuid,date,uuid,integer,integer,uuid[])'::regprocedure
  ]
  loop
    definition := pg_get_functiondef(routine);
    if strpos(definition, 'public.tade_roles') > 0 then
      execute replace(definition, 'public.tade_roles', 'public."Work_log_roles"');
    end if;
  end loop;
end
$migration$;

notify pgrst, 'reload schema';
