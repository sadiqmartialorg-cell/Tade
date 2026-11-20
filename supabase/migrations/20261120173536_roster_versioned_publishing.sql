-- Each Tier 1/2 team maintains an independent draft and active roster version.
-- The original worklog_roster_shifts table remains the compact cache of
-- currently published shifts used by activity coverage and reminders.
create table public.worklog_roster_team_weeks (
  team_id uuid not null,
  week_start date not null,
  active_version integer not null default 0 check(active_version >= 0),
  draft_base_version integer not null default 0 check(draft_base_version >= 0),
  draft_revision integer not null default 0 check(draft_revision >= 0),
  draft_mode text not null default 'overlay' check(draft_mode in ('overlay','replace')),
  published_by uuid references public.adhoc_profiles(id) on delete set null,
  published_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key(team_id,week_start),
  check(extract(isodow from week_start)=1)
);
create table public.worklog_roster_draft_shifts (
  team_id uuid not null,
  week_start date not null,
  user_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  work_date date not null,
  kind text not null check(kind in ('work','off','leave')),
  start_time time,
  end_time time,
  primary key(team_id,week_start,user_id,work_date),
  foreign key(team_id,week_start) references public.worklog_roster_team_weeks(team_id,week_start) on delete cascade,
  check(work_date between week_start and week_start+6),
  check(kind <> 'work' or (start_time is not null and end_time is not null and start_time <> end_time)),
  check(kind = 'work' or (start_time is null and end_time is null))
);
create index worklog_roster_draft_user_date_idx on public.worklog_roster_draft_shifts(user_id,work_date);
create table public.worklog_roster_publications (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null,
  week_start date not null,
  version integer not null check(version > 0),
  base_version integer not null check(base_version >= 0),
  published_by uuid references public.adhoc_profiles(id) on delete set null,
  published_at timestamptz not null default now(),
  shifts jsonb not null default '[]'::jsonb check(jsonb_typeof(shifts)='array'),
  changes jsonb not null default '[]'::jsonb check(jsonb_typeof(changes)='array'),
  unique(team_id,week_start,version)
);
create index worklog_roster_publications_team_idx on public.worklog_roster_publications(team_id,week_start,version desc);
alter table public.worklog_roster_team_weeks enable row level security;
alter table public.worklog_roster_draft_shifts enable row level security;
alter table public.worklog_roster_publications enable row level security;
revoke all on public.worklog_roster_team_weeks,public.worklog_roster_draft_shifts,
  public.worklog_roster_publications from anon,authenticated;

-- Import any legacy draft/published rows without altering the active cache.
with recursive ancestry as (
  select s.week_start,s.user_id,p.id ancestor_id,p.manager_id,p.job_role,0 depth
  from public.worklog_roster_shifts s join public.adhoc_profiles p on p.id=s.user_id
  union all
  select a.week_start,a.user_id,p.id,p.manager_id,p.job_role,a.depth+1
  from ancestry a join public.adhoc_profiles p on p.id=a.manager_id
  where a.depth<20
), team_choice as (
  select distinct on(a.week_start,a.user_id) a.week_start,a.user_id,a.ancestor_id team_id
  from ancestry a join public.tade_roles r on r.name=a.job_role and r.rank<=2
  order by a.week_start,a.user_id,a.depth
), legacy as (
  select s.*,coalesce(t.team_id,s.user_id) team_id,w.version,w.state,w.published_by,w.published_at
  from public.worklog_roster_shifts s
  join public.worklog_roster_weeks w on w.week_start=s.week_start
  left join team_choice t on t.week_start=s.week_start and t.user_id=s.user_id
)
insert into public.worklog_roster_team_weeks
  (team_id,week_start,active_version,draft_base_version,draft_revision,published_by,published_at)
select team_id,week_start,max(version),max(version),
       case when bool_or(state='draft') then 1 else 0 end,
       (array_agg(published_by))[1],max(published_at)
from legacy group by team_id,week_start on conflict do nothing;

with recursive ancestry as (
  select s.week_start,s.user_id,p.id ancestor_id,p.manager_id,p.job_role,0 depth
  from public.worklog_roster_shifts s join public.adhoc_profiles p on p.id=s.user_id
  union all
  select a.week_start,a.user_id,p.id,p.manager_id,p.job_role,a.depth+1
  from ancestry a join public.adhoc_profiles p on p.id=a.manager_id where a.depth<20
), team_choice as (
  select distinct on(a.week_start,a.user_id) a.week_start,a.user_id,a.ancestor_id team_id
  from ancestry a join public.tade_roles r on r.name=a.job_role and r.rank<=2
  order by a.week_start,a.user_id,a.depth
)
insert into public.worklog_roster_draft_shifts
  (team_id,week_start,user_id,work_date,kind,start_time,end_time)
select coalesce(t.team_id,s.user_id),s.week_start,s.user_id,s.work_date,
       s.draft_kind,s.draft_start,s.draft_end
from public.worklog_roster_shifts s
join public.worklog_roster_weeks w on w.week_start=s.week_start and w.state='draft'
left join team_choice t on t.week_start=s.week_start and t.user_id=s.user_id
on conflict do nothing;

create function public.worklog_roster_save_cells(
  p_team uuid,p_week date,p_actor uuid,p_expected_version integer,
  p_expected_revision integer,p_user uuid,p_days date[],
  p_kind text,p_start time,p_end time
) returns integer language plpgsql security invoker set search_path='' as $$
declare current_week public.worklog_roster_team_weeks%rowtype;
begin
  if p_team is null or p_user is null or p_actor is null or extract(isodow from p_week)<>1
     or cardinality(p_days) not between 1 and 7
     or exists(select 1 from unnest(p_days) d where d<p_week or d>p_week+6)
     or p_kind not in ('work','off','leave')
     or (p_kind='work' and (p_start is null or p_end is null or p_start=p_end))
     or (p_kind<>'work' and (p_start is not null or p_end is not null))
  then raise exception 'Choose valid roster dates and shift hours'; end if;
  insert into public.worklog_roster_team_weeks(team_id,week_start)
  values(p_team,p_week) on conflict do nothing;
  select * into current_week from public.worklog_roster_team_weeks
  where team_id=p_team and week_start=p_week for update;
  if current_week.active_version<>p_expected_version
     or current_week.draft_revision<>p_expected_revision
     or current_week.draft_base_version<>current_week.active_version
  then raise exception 'Roster changed. Reload and review the latest draft.'; end if;
  insert into public.worklog_roster_draft_shifts
    (team_id,week_start,user_id,work_date,kind,start_time,end_time)
  select p_team,p_week,p_user,dates.work_date,p_kind,p_start,p_end
  from (select distinct unnest(p_days) as work_date) dates
  on conflict(team_id,week_start,user_id,work_date) do update
  set kind=excluded.kind,start_time=excluded.start_time,end_time=excluded.end_time;
  update public.worklog_roster_team_weeks
  set draft_revision=draft_revision+1,draft_base_version=active_version,updated_at=now()
  where team_id=p_team and week_start=p_week;
  insert into public.worklog_activity_audit(event,actor_id,details)
  values('roster_edited',p_actor,jsonb_build_object('teamId',p_team,'week',p_week,
    'userId',p_user,'dates',p_days,'kind',p_kind,'start',p_start,'end',p_end,
    'revision',current_week.draft_revision+1));
  return current_week.draft_revision+1;
end;
$$;
revoke all on function public.worklog_roster_save_cells(uuid,date,uuid,integer,integer,uuid,date[],text,time,time) from public,anon,authenticated;
grant execute on function public.worklog_roster_save_cells(uuid,date,uuid,integer,integer,uuid,date[],text,time,time) to service_role;

create function public.worklog_roster_copy_previous(
  p_team uuid,p_week date,p_actor uuid,p_expected_version integer,
  p_expected_revision integer,p_user_ids uuid[],p_replace boolean
) returns integer language plpgsql security invoker set search_path='' as $$
declare current_week public.worklog_roster_team_weeks%rowtype;
begin
  if p_team is null or p_actor is null or extract(isodow from p_week)<>1
     or coalesce(cardinality(p_user_ids),0)=0
  then raise exception 'Choose a team and roster week'; end if;
  if not exists(
    select 1 from public.worklog_roster_shifts
    where week_start=p_week-7 and user_id=any(p_user_ids) and published_kind is not null
  ) then raise exception 'Previous week has no published shifts to copy'; end if;
  insert into public.worklog_roster_team_weeks(team_id,week_start)
  values(p_team,p_week) on conflict do nothing;
  select * into current_week from public.worklog_roster_team_weeks
  where team_id=p_team and week_start=p_week for update;
  if current_week.active_version<>p_expected_version
     or current_week.draft_revision<>p_expected_revision
     or current_week.draft_base_version<>current_week.active_version
  then raise exception 'Roster changed. Reload and review the latest draft.'; end if;
  if current_week.draft_revision>0 and not p_replace
  then raise exception 'Existing draft shifts need replacement confirmation'; end if;
  delete from public.worklog_roster_draft_shifts
  where team_id=p_team and week_start=p_week;
  insert into public.worklog_roster_draft_shifts
    (team_id,week_start,user_id,work_date,kind,start_time,end_time)
  select p_team,p_week,u.id,p_week+d.n,
    coalesce(s.published_kind,'off'),s.published_start,s.published_end
  from (select distinct unnest(p_user_ids) id) u
  cross join generate_series(0,6) d(n)
  left join public.worklog_roster_shifts s
    on s.user_id=u.id and s.work_date=p_week+d.n-7 and s.published_kind is not null;
  update public.worklog_roster_team_weeks
  set draft_revision=draft_revision+1,draft_base_version=active_version,
      draft_mode='replace',updated_at=now()
  where team_id=p_team and week_start=p_week;
  insert into public.worklog_activity_audit(event,actor_id,details)
  values('roster_copied',p_actor,jsonb_build_object('teamId',p_team,'week',p_week,
    'revision',current_week.draft_revision+1,'replacedExisting',current_week.draft_revision>0));
  return current_week.draft_revision+1;
end;
$$;
revoke all on function public.worklog_roster_copy_previous(uuid,date,uuid,integer,integer,uuid[],boolean) from public,anon,authenticated;
grant execute on function public.worklog_roster_copy_previous(uuid,date,uuid,integer,integer,uuid[],boolean) to service_role;

create function public.worklog_roster_effective_shifts(
  p_team uuid,p_week date,p_user_ids uuid[]
) returns table(user_id uuid,work_date date,kind text,start_time time,end_time time)
language sql stable security invoker set search_path='' as $$
  select u.id,p_week+idx.n,
    coalesce(draft.kind,case when w.draft_mode='overlay' then s.published_kind end,'off'),
    case when draft.user_id is not null then draft.start_time
         when w.draft_mode='overlay' then s.published_start end,
    case when draft.user_id is not null then draft.end_time
         when w.draft_mode='overlay' then s.published_end end
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

create function public.worklog_roster_publish_team(
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
  where i.kind='check' and i.status='open'
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
     published_kind,published_start,published_end)
  select p_week,n.user_id,n.work_date,n.kind,n.start_time,n.end_time,
    n.kind,n.start_time,n.end_time
  from jsonb_to_recordset(snapshot) as n(
    user_id uuid,work_date date,kind text,start_time time,end_time time)
  on conflict(week_start,user_id,work_date) do update
  set draft_kind=excluded.draft_kind,draft_start=excluded.draft_start,
      draft_end=excluded.draft_end,published_kind=excluded.published_kind,
      published_start=excluded.published_start,published_end=excluded.published_end,
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
  where i.kind='check' and i.status='open'
    and i.scheduled_date between p_week and p_week+6
    and (i.owner_id=any(p_user_ids) or i.backup_owner_id=any(p_user_ids));
  update public.worklog_roster_team_weeks
  set active_version=next_version,draft_base_version=next_version,
      draft_revision=0,draft_mode='overlay',published_by=p_actor,
      published_at=activated_at,updated_at=activated_at
  where team_id=p_team and week_start=p_week;
  delete from public.worklog_roster_draft_shifts
  where team_id=p_team and week_start=p_week;
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

-- Legacy data has only its latest published copy, so earlier versions cannot
-- be reconstructed. New publications retain complete snapshots.
with recursive ancestry as (
  select s.week_start,s.user_id,p.id ancestor_id,p.manager_id,p.job_role,0 depth
  from public.worklog_roster_shifts s join public.adhoc_profiles p on p.id=s.user_id
  union all
  select a.week_start,a.user_id,p.id,p.manager_id,p.job_role,a.depth+1
  from ancestry a join public.adhoc_profiles p on p.id=a.manager_id where a.depth<20
), team_choice as (
  select distinct on(a.week_start,a.user_id) a.week_start,a.user_id,a.ancestor_id team_id
  from ancestry a join public.tade_roles r on r.name=a.job_role and r.rank<=2
  order by a.week_start,a.user_id,a.depth
)
insert into public.worklog_roster_publications
  (team_id,week_start,version,base_version,published_by,published_at,shifts)
select coalesce(t.team_id,s.user_id),s.week_start,w.version,greatest(w.version-1,0),
       w.published_by,coalesce(w.published_at,now()),
       jsonb_agg(jsonb_build_object('user_id',s.user_id,'work_date',s.work_date,
         'kind',s.published_kind,'start_time',s.published_start,'end_time',s.published_end))
from public.worklog_roster_shifts s
join public.worklog_roster_weeks w on w.week_start=s.week_start and w.version>0
left join team_choice t on t.week_start=s.week_start and t.user_id=s.user_id
where s.published_kind is not null
group by coalesce(t.team_id,s.user_id),s.week_start,w.version,w.published_by,w.published_at
on conflict do nothing;
