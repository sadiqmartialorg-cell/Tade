-- Keep the existing publication transaction and its grants. Update its team scope
-- to match the roster editor without changing shift data or coverage checks.
do $migration$
declare
  definition text := pg_get_functiondef(
    'public.worklog_roster_publish_team(uuid,date,uuid,integer,integer,uuid[])'::regprocedure
  );
  old_guard constant text := $old$  if p_team<>p_actor or not exists (
    select 1 from public.adhoc_profiles p join public."Work_log_roles" r on r.name=p.job_role
    join public.worklog_user_modules m on m.user_id=p.id and m.module_key='roster'
    where p.id=p_actor and p.active and not r.is_access_role and r.rank in (1,2)
  ) or exists (
    select 1 from unnest(p_user_ids) u(id) where not exists (
      select 1 from public.adhoc_profiles p where p.id=u.id and p.active and p.manager_id=p_actor
    )
  ) then raise exception 'Only direct reports can be published by their roster lead'; end if;$old$;
  new_guard constant text := $new$  select r.rank into actor_tier
  from public.adhoc_profiles p
  join public."Work_log_roles" r on r.name=p.job_role and not r.is_access_role
  join public.worklog_user_modules m on m.user_id=p.id and m.module_key='roster'
  where p.id=p_actor and p.active and r.rank in (1,2);
  if p_team<>p_actor or actor_tier is null then
    raise exception 'You cannot publish this roster team';
  end if;

  -- Tier 1 schedules direct reports. Tier 2 also schedules descendants through
  -- intermediate leads who cannot manage a roster of their own.
  if exists (
    with recursive team_members as (
      select p.id,p.active,array[p_actor,p.id] as seen
      from public.adhoc_profiles p where p.manager_id=p_actor and p.id<>p_actor
      union all
      select p.id,p.active,m.seen || p.id
      from team_members m join public.adhoc_profiles p on p.manager_id=m.id
      where actor_tier=2 and not (p.id=any(m.seen)) and not exists (
        select 1 from public.adhoc_profiles lead
        join public."Work_log_roles" r on r.name=lead.job_role and not r.is_access_role
        where lead.id=m.id and lead.active and r.rank in (1,2)
      )
    )
    select 1 from unnest(p_user_ids) requested(id)
    where not exists (
      select 1 from team_members m where m.id=requested.id and m.active
    )
  ) then raise exception 'Only active members of your editable roster team can be published'; end if;$new$;
begin
  if strpos(definition,new_guard)>0 then return; end if;
  if strpos(definition,old_guard)=0 or strpos(definition,'declare next_version integer;')=0 then
    raise exception 'The roster publication guard differs from the expected version';
  end if;
  definition := replace(definition,'declare next_version integer;',
    E'declare next_version integer;\ndeclare actor_tier integer;');
  execute replace(definition,old_guard,new_guard);
end
$migration$;
