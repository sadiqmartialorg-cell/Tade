-- Daily Activity and Roster use the same MS Tracker customer records and
-- WorkLog user/module grants. User Admins assign the new module grants.
insert into public.worklog_modules(key,name,sort_order) values
  ('daily_activity','Daily Activity',30),('roster','Roster',40)
on conflict (key) do nothing;

create table public.worklog_activity_series (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.adhoc_customers(id),
  title text not null check(length(trim(title)) between 1 and 160),
  instructions text not null default '',
  steps jsonb not null default '[]'::jsonb check(jsonb_typeof(steps)='array'),
  evidence_required boolean not null default false,
  schedule_kind text not null check(schedule_kind in ('daily','weekdays','weekly','monthly')),
  weekdays smallint[] not null default '{}',
  monthly_day smallint,
  starts_on date not null,
  ends_on date,
  active boolean not null default true,
  reminder_minutes integer not null default 15 check(reminder_minutes between 5 and 240),
  created_by uuid references public.adhoc_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check(ends_on is null or ends_on >= starts_on),
  check(monthly_day is null or monthly_day between 1 and 31)
);
create table public.worklog_activity_checks (
  id uuid primary key default gen_random_uuid(),
  series_id uuid not null references public.worklog_activity_series(id) on delete cascade,
  check_number integer not null check(check_number between 1 and 24),
  label text not null check(length(trim(label)) between 1 and 120),
  window_start time not null,
  window_end time not null,
  primary_owner_id uuid references public.adhoc_profiles(id) on delete set null,
  backup_owner_id uuid references public.adhoc_profiles(id) on delete set null,
  unique(series_id,check_number),
  check(backup_owner_id is null or backup_owner_id <> primary_owner_id)
);
create index worklog_checks_series_idx on public.worklog_activity_checks(series_id);
create table public.worklog_activity_items (
  id uuid primary key default gen_random_uuid(),
  kind text not null check(kind in ('check','assignment','support','dependency')),
  series_id uuid references public.worklog_activity_series(id) on delete set null,
  check_id uuid references public.worklog_activity_checks(id) on delete set null,
  scheduled_date date,
  customer_id uuid not null references public.adhoc_customers(id),
  title text not null check(length(trim(title)) between 1 and 160),
  instructions text not null default '',
  steps jsonb not null default '[]'::jsonb check(jsonb_typeof(steps)='array'),
  completed_steps jsonb not null default '[]'::jsonb check(jsonb_typeof(completed_steps)='array'),
  evidence_required boolean not null default false,
  evidence text,
  creator_id uuid references public.adhoc_profiles(id) on delete set null,
  owner_id uuid references public.adhoc_profiles(id) on delete set null,
  backup_owner_id uuid references public.adhoc_profiles(id) on delete set null,
  approver_id uuid references public.adhoc_profiles(id) on delete set null,
  prerequisite_id uuid references public.worklog_activity_items(id) on delete set null,
  window_start_at timestamptz,
  window_end_at timestamptz,
  due_at timestamptz not null,
  original_due_at timestamptz not null,
  status text not null default 'open' check(status in ('open','completed','cancelled','missed')),
  completed_by uuid references public.adhoc_profiles(id) on delete set null,
  completed_at timestamptz,
  recovery_reason text,
  missed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(check_id,scheduled_date),
  check((kind='check') = (check_id is not null)),
  check(kind<>'check' or (scheduled_date is not null and window_start_at is not null and window_end_at is not null))
);
create index worklog_items_owner_due_idx on public.worklog_activity_items(owner_id,due_at) where status='open';
create index worklog_items_backup_due_idx on public.worklog_activity_items(backup_owner_id,due_at) where status='open' and backup_owner_id is not null;
create index worklog_items_customer_date_idx on public.worklog_activity_items(customer_id,scheduled_date);
create index worklog_items_series_date_idx on public.worklog_activity_items(series_id,scheduled_date);
create table public.worklog_activity_owner_changes (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.worklog_activity_checks(id) on delete cascade,
  effective_on date not null,
  scope text not null check(scope in ('date','future')),
  primary_owner_id uuid references public.adhoc_profiles(id) on delete set null,
  backup_owner_id uuid references public.adhoc_profiles(id) on delete set null,
  changed_by uuid references public.adhoc_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check(backup_owner_id is null or backup_owner_id <> primary_owner_id)
);
create index worklog_owner_changes_check_date_idx on public.worklog_activity_owner_changes(check_id,effective_on desc,created_at desc);
create table public.worklog_activity_extensions (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.worklog_activity_items(id) on delete cascade,
  previous_due_at timestamptz not null,
  proposed_due_at timestamptz not null,
  reason text not null check(length(trim(reason)) between 1 and 1000),
  status text not null default 'pending' check(status in ('pending','approved','declined')),
  requested_by uuid references public.adhoc_profiles(id) on delete set null,
  approver_id uuid references public.adhoc_profiles(id) on delete set null,
  decided_by uuid references public.adhoc_profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  decided_at timestamptz,
  check(proposed_due_at > previous_due_at)
);
create unique index worklog_extension_one_pending_idx on public.worklog_activity_extensions(item_id) where status='pending';
create table public.worklog_roster_weeks (
  week_start date primary key,
  state text not null default 'draft' check(state in ('draft','published')),
  version integer not null default 0,
  published_by uuid references public.adhoc_profiles(id) on delete set null,
  published_at timestamptz,
  updated_at timestamptz not null default now()
);
create table public.worklog_roster_shifts (
  week_start date not null references public.worklog_roster_weeks(week_start) on delete cascade,
  user_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  work_date date not null,
  draft_kind text not null default 'off' check(draft_kind in ('work','off','leave')),
  draft_start time,
  draft_end time,
  published_kind text,
  published_start time,
  published_end time,
  updated_at timestamptz not null default now(),
  primary key(week_start,user_id,work_date),
  check(work_date between week_start and week_start+6),
  check(draft_kind<>'work' or (draft_start is not null and draft_end is not null and draft_start<>draft_end)),
  check(published_kind is null or published_kind<>'work' or (published_start is not null and published_end is not null))
);
create index worklog_roster_user_date_idx on public.worklog_roster_shifts(user_id,work_date);
create table public.worklog_inbox (
  id uuid primary key default gen_random_uuid(),
  recipient_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  item_id uuid references public.worklog_activity_items(id) on delete cascade,
  delivery_key text not null unique,
  kind text not null,
  title text not null,
  body text not null default '',
  target text not null default 'daily_activity',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  push_sent_at timestamptz,
  push_attempts smallint not null default 0
);
create index worklog_inbox_recipient_idx on public.worklog_inbox(recipient_id,created_at desc);
create index worklog_inbox_pending_push_idx on public.worklog_inbox(created_at) where push_sent_at is null and push_attempts<3;
create table public.worklog_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.adhoc_profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index worklog_push_subscriptions_user_idx on public.worklog_push_subscriptions(user_id);
create table public.worklog_activity_audit (
  id bigint generated always as identity primary key,
  item_id uuid references public.worklog_activity_items(id) on delete set null,
  actor_id uuid references public.adhoc_profiles(id) on delete set null,
  event text not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index worklog_audit_item_idx on public.worklog_activity_audit(item_id,created_at desc);
create table public.worklog_activity_generation (
  id integer primary key default 1 check(id=1),
  generated_through date not null,
  updated_at timestamptz not null default now()
);
create trigger worklog_series_updated before update on public.worklog_activity_series
for each row execute function public.adhoc_touch_updated_at();
create trigger worklog_items_updated before update on public.worklog_activity_items
for each row execute function public.adhoc_touch_updated_at();

alter table public.worklog_activity_series enable row level security;
alter table public.worklog_activity_checks enable row level security;
alter table public.worklog_activity_items enable row level security;
alter table public.worklog_activity_owner_changes enable row level security;
alter table public.worklog_activity_extensions enable row level security;
alter table public.worklog_roster_weeks enable row level security;
alter table public.worklog_roster_shifts enable row level security;
alter table public.worklog_inbox enable row level security;
alter table public.worklog_push_subscriptions enable row level security;
alter table public.worklog_activity_audit enable row level security;
alter table public.worklog_activity_generation enable row level security;
revoke all on public.worklog_activity_series,public.worklog_activity_checks,
  public.worklog_activity_items,public.worklog_activity_owner_changes,
  public.worklog_activity_extensions,public.worklog_roster_weeks,
  public.worklog_roster_shifts,public.worklog_inbox,
  public.worklog_push_subscriptions,public.worklog_activity_audit,
  public.worklog_activity_generation from anon,authenticated;

-- Publish each manager's draft changes as one transaction.
create function public.worklog_publish_roster(p_week date,p_user_ids uuid[],p_actor uuid)
returns integer language plpgsql security invoker set search_path = '' as $$
declare next_version integer;
begin
  update public.worklog_roster_shifts
  set published_kind=draft_kind,published_start=draft_start,published_end=draft_end
  where week_start=p_week and user_id=any(p_user_ids);
  update public.worklog_roster_weeks
  set state='published',version=version+1,published_by=p_actor,published_at=now()
  where week_start=p_week returning version into next_version;
  if next_version is null then raise exception 'Roster week not found'; end if;
  return next_version;
end;
$$;
revoke all on function public.worklog_publish_roster(date,uuid[],uuid) from public,anon,authenticated;
grant execute on function public.worklog_publish_roster(date,uuid[],uuid) to service_role;

-- An approval and its deadline change must commit together.
create function public.worklog_decide_extension(p_extension uuid,p_actor uuid,p_approved boolean)
returns uuid language plpgsql security invoker set search_path = '' as $$
declare ext public.worklog_activity_extensions%rowtype;
begin
  select * into ext from public.worklog_activity_extensions
  where id=p_extension and status='pending' and approver_id=p_actor for update;
  if not found then raise exception 'Extension is no longer pending or you are not its approver'; end if;
  if not exists(select 1 from public.worklog_activity_items where id=ext.item_id and status='open') then
    raise exception 'The task is closed';
  end if;
  if p_approved then
    update public.worklog_activity_items set due_at=ext.proposed_due_at where id=ext.item_id;
  end if;
  update public.worklog_activity_extensions
  set status=case when p_approved then 'approved' else 'declined' end,
      decided_by=p_actor,decided_at=now()
  where id=p_extension;
  return ext.item_id;
end;
$$;
revoke all on function public.worklog_decide_extension(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.worklog_decide_extension(uuid,uuid,boolean) to service_role;
