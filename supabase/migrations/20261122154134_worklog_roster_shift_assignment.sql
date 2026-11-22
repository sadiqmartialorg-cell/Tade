alter table public.worklog_activity_series
  add column roster_team_id uuid references public.adhoc_profiles(id) on delete set null;

alter table public.worklog_activity_items
  add column roster_team_id uuid references public.adhoc_profiles(id) on delete set null,
  add column roster_assignment jsonb,
  add column coverage_gap boolean;

alter table public.worklog_roster_shifts
  add column published_team_id uuid,
  add column published_version integer;

create index worklog_series_roster_team_idx on public.worklog_activity_series (roster_team_id)
  where roster_team_id is not null;
create index worklog_items_roster_open_idx on public.worklog_activity_items (roster_team_id, scheduled_date)
  where kind = 'check' and status = 'open' and roster_team_id is not null;
create index worklog_items_check_date_idx on public.worklog_activity_items (scheduled_date)
  where kind = 'check';
create index worklog_items_one_time_due_idx on public.worklog_activity_items (due_at)
  where kind <> 'check';

-- A named schedule can be adopted when all named owners, including overrides,
-- reach the same Tier 1 or 2 manager. Assign ambiguous schedules in WorkLog.
with recursive owners as (
  select series_id, primary_owner_id as id from public.worklog_activity_checks
  union select series_id, backup_owner_id from public.worklog_activity_checks
  union select c.series_id, oc.primary_owner_id from public.worklog_activity_owner_changes oc
    join public.worklog_activity_checks c on c.id=oc.check_id
  union select c.series_id, oc.backup_owner_id from public.worklog_activity_owner_changes oc
    join public.worklog_activity_checks c on c.id=oc.check_id
), chain as (
  select o.series_id, o.id as owner_id, p.manager_id as person_id, array[o.id] as visited, 1 as depth
  from owners o join public.adhoc_profiles p on p.id=o.id
  union all
  select c.series_id,c.owner_id,p.manager_id,c.visited || p.id,c.depth+1
  from chain c join public.adhoc_profiles p on p.id=c.person_id
  where not (p.id=any(c.visited))
), ranked as (
  select distinct on (c.series_id,c.owner_id) c.series_id,c.owner_id,p.id as team_id
  from chain c join public.adhoc_profiles p on p.id=c.person_id and p.active
  join public.tade_roles r on r.name=p.job_role and not r.is_access_role and r.rank in (1,2)
  order by c.series_id,c.owner_id,c.depth
), adopted as (
  select o.series_id,(array_agg(distinct r.team_id))[1] as team_id
  from owners o left join ranked r on r.series_id=o.series_id and r.owner_id=o.id
  where o.id is not null
  group by o.series_id
  having count(distinct r.team_id)=1 and bool_and(r.team_id is not null)
)
update public.worklog_activity_series s
set roster_team_id=a.team_id
from adopted a where s.id=a.series_id and s.active;

update public.worklog_activity_items i
set roster_team_id=s.roster_team_id
from public.worklog_activity_series s
where i.series_id=s.id and s.roster_team_id is not null and i.status='open' and i.completed_at is null;

-- Preserve provenance for shifts already published by the versioned roster.
with latest as (
  select distinct on (pub.week_start,n.user_id,n.work_date)
    pub.week_start,n.user_id,n.work_date,pub.team_id,pub.version
  from public.worklog_roster_publications pub
  join public.worklog_roster_team_weeks w on w.team_id=pub.team_id
    and w.week_start=pub.week_start and w.active_version=pub.version
  cross join lateral jsonb_to_recordset(pub.shifts) as n(user_id uuid,work_date date)
  order by pub.week_start,n.user_id,n.work_date,pub.published_at desc,pub.team_id
)
update public.worklog_roster_shifts s
set published_team_id=l.team_id,published_version=l.version
from latest l where s.week_start=l.week_start and s.user_id=l.user_id and s.work_date=l.work_date
  and s.published_kind is not null;

-- Older published caches may predate snapshot history. Keep their stored week version.
update public.worklog_roster_shifts s set published_version=w.version
from public.worklog_roster_weeks w where w.week_start=s.week_start
  and w.state='published' and s.published_kind='work' and s.published_version is null;

-- Resolve already generated checks immediately when adopting a legacy schedule.
-- Open checks retain an eligible current assignee during their window.
with recursive staff_path as (
  select p.id as user_id,p.manager_id as person_id,array[p.id] as seen,1 as depth
  from public.adhoc_profiles p
  join public.worklog_user_modules g on g.user_id=p.id and g.module_key='daily_activity'
  where p.active
  union all
  select a.user_id,p.manager_id,a.seen || p.id,a.depth+1
  from staff_path a join public.adhoc_profiles p on p.id=a.person_id
  where not (p.id=any(a.seen))
), eligible as (
  select distinct on (a.user_id) a.user_id,p.id as team_id
  from staff_path a join public.adhoc_profiles p on p.id=a.person_id and p.active
  join public.tade_roles r on r.name=p.job_role and not r.is_access_role and r.rank in (1,2)
  order by a.user_id,a.depth
), working as (
  select s.user_id,s.work_date,s.published_team_id,s.published_version,e.team_id,
    (s.work_date+s.published_start) at time zone 'Asia/Kolkata' as first,
    ((s.work_date+(s.published_end<=s.published_start)::integer)+s.published_end) at time zone 'Asia/Kolkata' as last
  from public.worklog_roster_shifts s join eligible e on e.user_id=s.user_id
  where s.published_kind='work'
), upcoming as (
  select i.id,w.user_id,case when w.user_id is not null then jsonb_build_object(
    'shiftDate',w.work_date,'startsAt',w.first,'endsAt',w.last,
    'publicationTeamId',w.published_team_id,'rosterVersion',w.published_version
  ) end as assignment
  from public.worklog_activity_items i
  left join lateral (
    select w.* from working w where w.team_id=i.roster_team_id
      and w.first<=i.window_start_at and i.window_start_at<w.last
    order by w.first desc,w.user_id limit 1
  ) w on true
  where i.kind='check' and i.roster_team_id is not null and i.status='open'
    and i.completed_at is null and i.window_start_at>now()
)
update public.worklog_activity_items i
set owner_id=u.user_id,backup_owner_id=null,roster_assignment=u.assignment,
    coverage_gap=u.user_id is null,due_at=i.window_end_at
from upcoming u where i.id=u.id;

create or replace function public.worklog_roster_effective_shifts(
  p_team uuid,p_week date,p_user_ids uuid[]
) returns table(user_id uuid,work_date date,kind text,start_time time,end_time time)
language sql stable security invoker set search_path='' as $$
  select u.id,p_week+idx.n,
    coalesce(draft.kind,case when coalesce(w.draft_mode,'overlay')='overlay' then s.published_kind end,'off'),
    case when draft.user_id is not null then draft.start_time
         when coalesce(w.draft_mode,'overlay')='overlay' then s.published_start end,
    case when draft.user_id is not null then draft.end_time
         when coalesce(w.draft_mode,'overlay')='overlay' then s.published_end end
  from (select distinct unnest(p_user_ids) id) u
  cross join generate_series(0,6) idx(n)
  left join public.worklog_roster_team_weeks w
    on w.team_id=p_team and w.week_start=p_week
  left join public.worklog_roster_draft_shifts draft
    on draft.team_id=p_team and draft.week_start=p_week
   and draft.user_id=u.id and draft.work_date=p_week+idx.n
  left join public.worklog_roster_shifts s
    on s.week_start=p_week and s.user_id=u.id and s.work_date=p_week+idx.n;
$$;
revoke all on function public.worklog_roster_effective_shifts(uuid,date,uuid[]) from public,anon,authenticated;
grant execute on function public.worklog_roster_effective_shifts(uuid,date,uuid[]) to service_role;

create or replace function public.worklog_roster_publish_team(
  p_team uuid,p_week date,p_actor uuid,p_expected_version integer,
  p_expected_revision integer,p_user_ids uuid[]
) returns jsonb language plpgsql security invoker set search_path='' as $$
declare current_week public.worklog_roster_team_weeks%rowtype;
declare snapshot jsonb;
declare changed jsonb;
declare next_version integer;
declare gap record;
declare activated_at timestamptz := now();
begin
  if p_team is null or p_actor is null or extract(isodow from p_week)<>1
     or coalesce(cardinality(p_user_ids),0)=0
  then raise exception 'Choose a team and roster week'; end if;
  if p_team<>p_actor or not exists (
    select 1 from public.adhoc_profiles p join public.tade_roles r on r.name=p.job_role
    join public.worklog_user_modules m on m.user_id=p.id and m.module_key='roster'
    where p.id=p_actor and p.active and not r.is_access_role and r.rank in (1,2)
  ) or exists (
    select 1 from unnest(p_user_ids) u(id) where not exists (
      select 1 from public.adhoc_profiles p where p.id=u.id and p.active and p.manager_id=p_actor
    )
  ) then raise exception 'Only direct reports can be published by their roster lead'; end if;
  select * into current_week from public.worklog_roster_team_weeks
  where team_id=p_team and week_start=p_week for update;
  if not found or current_week.draft_revision=0
  then raise exception 'There is no draft to publish'; end if;
  if current_week.active_version<>p_expected_version
     or current_week.draft_revision<>p_expected_revision
     or current_week.draft_base_version<>current_week.active_version
  then raise exception 'A newer roster version exists. Reload and review it before publishing.'; end if;
  if exists(
    select 1 from public.worklog_roster_effective_shifts(p_team,p_week,p_user_ids) s
    where s.kind='work' and (s.start_time is null or s.end_time is null or s.start_time=s.end_time)
  ) then raise exception 'A work shift has invalid hours'; end if;
  select coalesce(jsonb_agg(to_jsonb(s) order by s.user_id,s.work_date),'[]'::jsonb)
  into snapshot
  from public.worklog_roster_effective_shifts(p_team,p_week,p_user_ids) s;
  select coalesce(jsonb_agg(jsonb_build_object(
    'user_id',n.user_id,'work_date',n.work_date,
    'previous_kind',coalesce(c.published_kind,'off'),
    'previous_start',c.published_start,'previous_end',c.published_end,
    'kind',n.kind,'start_time',n.start_time,'end_time',n.end_time
  ) order by n.user_id,n.work_date)
  filter(where coalesce(c.published_kind,'off') is distinct from n.kind
    or c.published_start is distinct from n.start_time
    or c.published_end is distinct from n.end_time),'[]'::jsonb)
  into changed
  from jsonb_to_recordset(snapshot) as n(
    user_id uuid,work_date date,kind text,start_time time,end_time time)
  left join public.worklog_roster_shifts c
    on c.week_start=p_week and c.user_id=n.user_id and c.work_date=n.work_date;
  select i.id,i.title,i.scheduled_date into gap
  from public.worklog_activity_items i
  where i.kind='check' and i.status='open' and i.roster_team_id is null and i.handover_history is null
    and i.scheduled_date between p_week and p_week+6
    and (i.owner_id=any(p_user_ids) or i.backup_owner_id=any(p_user_ids))
    and not exists(
      select 1 from (
        select n.user_id,n.work_date,n.kind,n.start_time,n.end_time
        from jsonb_to_recordset(snapshot) as n(
          user_id uuid,work_date date,kind text,start_time time,end_time time)
        union all
        select s.user_id,s.work_date,s.published_kind,s.published_start,s.published_end
        from public.worklog_roster_shifts s
        where s.published_kind is not null
          and not (s.week_start=p_week and s.user_id=any(p_user_ids))
      ) eligible
      where eligible.user_id in (i.owner_id,i.backup_owner_id)
        and eligible.kind='work'
        and ((eligible.work_date+eligible.start_time) at time zone 'Asia/Kolkata') < i.window_end_at
        and (((eligible.work_date+(eligible.end_time<=eligible.start_time)::integer)
          +eligible.end_time) at time zone 'Asia/Kolkata') > i.window_start_at
    )
  limit 1;
  if gap.id is not null then
    raise exception 'Coverage gap for % on %. Review the affected shift before publishing.',
      gap.title,gap.scheduled_date;
  end if;
  -- Recheck exact times against the locked draft and the preceding published Sunday.
  with recursive team_members as (
    select p.id,array[p_team,p.id] as seen
    from public.adhoc_profiles p where p.manager_id=p_team and p.id<>p_team
    union all
    select p.id,m.seen || p.id
    from team_members m join public.adhoc_profiles p on p.manager_id=m.id
    where not (p.id=any(m.seen)) and not exists (
      select 1 from public.adhoc_profiles lead join public.tade_roles r on r.name=lead.job_role
      where lead.id=m.id and lead.active and not r.is_access_role and r.rank in (1,2)
    )
  ), eligible as (
    select p.id from team_members m join public.adhoc_profiles p on p.id=m.id and p.active
    join public.worklog_user_modules g on g.user_id=p.id and g.module_key='daily_activity'
  ), working as (
    select n.user_id,n.work_date,n.start_time,n.end_time
    from jsonb_to_recordset(snapshot) as n(
      user_id uuid,work_date date,kind text,start_time time,end_time time)
    where n.kind='work'
    union all
    select r.user_id,r.work_date,r.published_start,r.published_end
    from public.worklog_roster_shifts r
    where r.published_kind='work' and r.work_date between p_week-1 and p_week+6
      and not (r.week_start=p_week and r.user_id=any(p_user_ids))
  )
  select i.id,i.title,i.scheduled_date into gap
  from public.worklog_activity_items i
  where i.kind='check' and i.status='open' and i.roster_team_id=p_team
    and i.scheduled_date between p_week and p_week+6 and i.window_end_at>activated_at
    and not exists (
      select 1 from working w join eligible e on e.id=w.user_id
      where ((w.work_date+w.start_time) at time zone 'Asia/Kolkata') <= i.window_start_at
        and (((w.work_date+(w.end_time<=w.start_time)::integer)+w.end_time) at time zone 'Asia/Kolkata') > i.window_start_at
    )
  limit 1;
  if gap.id is not null then
    raise exception 'Coverage gap for % on %. Review the affected shift before publishing.',gap.title,gap.scheduled_date;
  end if;
  next_version:=current_week.active_version+1;
  insert into public.worklog_roster_publications
    (team_id,week_start,version,base_version,published_by,published_at,shifts,changes)
  values(p_team,p_week,next_version,current_week.active_version,p_actor,activated_at,snapshot,changed);
  -- Keep the legacy published-shift cache available to reminders and check coverage.
  insert into public.worklog_roster_weeks
    (week_start,state,version,published_by,published_at)
  values(p_week,'published',next_version,p_actor,activated_at)
  on conflict(week_start) do update
    set state='published',version=greatest(public.worklog_roster_weeks.version,excluded.version),
        published_by=excluded.published_by,published_at=excluded.published_at,updated_at=activated_at;
  insert into public.worklog_roster_shifts
    (week_start,user_id,work_date,draft_kind,draft_start,draft_end,
     published_kind,published_start,published_end,published_team_id,published_version)
  select p_week,n.user_id,n.work_date,n.kind,n.start_time,n.end_time,
    n.kind,n.start_time,n.end_time,p_team,next_version
  from jsonb_to_recordset(snapshot) as n(
    user_id uuid,work_date date,kind text,start_time time,end_time time)
  on conflict(week_start,user_id,work_date) do update
  set draft_kind=excluded.draft_kind,draft_start=excluded.draft_start,
      draft_end=excluded.draft_end,published_kind=excluded.published_kind,
      published_start=excluded.published_start,published_end=excluded.published_end,
      published_team_id=excluded.published_team_id,published_version=excluded.published_version,
      updated_at=now();
  update public.worklog_activity_items i
  set due_at=(
    select max(least(i.window_end_at,
      (((s.work_date+(s.published_end<=s.published_start)::integer)
        +s.published_end) at time zone 'Asia/Kolkata')))
    from public.worklog_roster_shifts s
    where s.user_id in (i.owner_id,i.backup_owner_id)
      and s.published_kind='work'
      and ((s.work_date+s.published_start) at time zone 'Asia/Kolkata') < i.window_end_at
      and (((s.work_date+(s.published_end<=s.published_start)::integer)
        +s.published_end) at time zone 'Asia/Kolkata') > i.window_start_at
  )
  where i.kind='check' and i.status='open' and i.roster_team_id is null and i.handover_history is null
    and i.scheduled_date between p_week and p_week+6
    and (i.owner_id=any(p_user_ids) or i.backup_owner_id=any(p_user_ids));
  update public.worklog_roster_team_weeks
  set active_version=next_version,draft_base_version=next_version,
      draft_revision=0,draft_mode='overlay',published_by=p_actor,
      published_at=activated_at,updated_at=activated_at
  where team_id=p_team and week_start=p_week;
  delete from public.worklog_roster_draft_shifts
  where team_id=p_team and week_start=p_week and user_id=any(p_user_ids);
  insert into public.worklog_inbox(recipient_id,delivery_key,kind,title,body,target)
  select distinct p.id,
    'roster:'||p_team||':'||p_week||':'||next_version||':'||p.id,
    'roster',case when current_week.active_version=0 then 'Roster published'
                  else 'Roster updated' end,
    'Week of '||p_week,'roster'
  from jsonb_array_elements(changed) c
  join public.adhoc_profiles p on p.id=(c->>'user_id')::uuid and p.active
  on conflict(delivery_key) do nothing;
  insert into public.worklog_activity_audit(event,actor_id,details)
  values('roster_published',p_actor,jsonb_build_object('teamId',p_team,'week',p_week,
    'version',next_version,'baseVersion',current_week.active_version,'changes',changed));
  return jsonb_build_object('version',next_version,'changes',changed,'publishedAt',activated_at);
end;
$$;
revoke all on function public.worklog_roster_publish_team(uuid,date,uuid,integer,integer,uuid[]) from public,anon,authenticated;
grant execute on function public.worklog_roster_publish_team(uuid,date,uuid,integer,integer,uuid[]) to service_role;
