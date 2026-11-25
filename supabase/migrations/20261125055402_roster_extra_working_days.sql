create table public.worklog_roster_extra_days (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references public.adhoc_profiles(id) on delete set null,
  reviewer_id uuid references public.adhoc_profiles(id) on delete set null,
  work_date date not null,
  reason text not null default '' check (char_length(reason) <= 300),
  status text not null default 'pending' check (status in ('pending','approved','declined')),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (requester_id <> reviewer_id),
  check ((status = 'pending') = (decided_at is null))
);
create unique index worklog_roster_extra_day_once_idx
  on public.worklog_roster_extra_days (requester_id,work_date)
  where status = 'approved' or (status = 'pending' and reviewer_id is not null);
create index worklog_roster_extra_history_idx
  on public.worklog_roster_extra_days (requester_id,created_at desc);
create index worklog_roster_extra_review_idx
  on public.worklog_roster_extra_days (reviewer_id,created_at) where status='pending';

alter table public.worklog_roster_extra_days enable row level security;
revoke all on public.worklog_roster_extra_days from public,anon,authenticated;
grant select,insert,update on public.worklog_roster_extra_days to service_role;

create function public.worklog_request_extra_day(p_requester uuid,p_date date,p_reason text)
returns public.worklog_roster_extra_days language plpgsql security invoker set search_path='' as $$
declare
  request public.worklog_roster_extra_days;
  requester_name text;
  reviewer uuid;
begin
  select p.display_name,m.id into requester_name,reviewer
  from public.adhoc_profiles p join public.adhoc_profiles m on m.id=p.manager_id and m.active
  where p.id=p_requester and p.active and p.id<>m.id;
  if reviewer is null then
    raise exception 'An active reporting manager must be assigned in the User tree before you can request an extra day.';
  end if;
  insert into public.worklog_roster_extra_days (requester_id,reviewer_id,work_date,reason)
  values (p_requester,reviewer,p_date,coalesce(p_reason,''))
  on conflict (requester_id,work_date)
    where status='approved' or (status='pending' and reviewer_id is not null)
    do nothing returning * into request;
  if request.id is null then
    raise exception 'An approved or pending extra working day already exists for this date.';
  end if;
  insert into public.worklog_inbox (recipient_id,delivery_key,kind,title,body,target)
  values (reviewer,'roster-extra-request:'||request.id,'roster_extra_request','Extra working day needs approval',
    requester_name||' requested '||to_char(p_date,'DD Mon YYYY')||'.','roster_extra');
  return request;
end;
$$;

create function public.worklog_decide_extra_day(p_request uuid,p_reviewer uuid,p_approved boolean)
returns public.worklog_roster_extra_days language plpgsql security invoker set search_path='' as $$
declare
  request public.worklog_roster_extra_days;
begin
  update public.worklog_roster_extra_days
  set status=case when p_approved then 'approved' else 'declined' end,decided_at=now()
  where id=p_request and reviewer_id=p_reviewer and status='pending' and requester_id is not null
  returning * into request;
  if request.id is null then
    raise exception 'This request has already been reviewed or is outside your approval access.';
  end if;
  insert into public.worklog_inbox (recipient_id,delivery_key,kind,title,body,target)
  values (request.requester_id,'roster-extra-decision:'||request.id,'roster_extra_decision',
    'Extra working day '||request.status,to_char(request.work_date,'DD Mon YYYY')||' · '||request.status,'roster_extra');
  return request;
end;
$$;

revoke all on function public.worklog_request_extra_day(uuid,date,text) from public,anon,authenticated;
revoke all on function public.worklog_decide_extra_day(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.worklog_request_extra_day(uuid,date,text) to service_role;
grant execute on function public.worklog_decide_extra_day(uuid,uuid,boolean) to service_role;
