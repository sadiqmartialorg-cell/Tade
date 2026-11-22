alter table public.worklog_activity_items
  add column handover_history jsonb,
  add constraint worklog_check_handover_history check (
    handover_history is null or (kind = 'check' and jsonb_typeof(handover_history) = 'array')
  );

create index worklog_checks_pending_handover_idx
  on public.worklog_activity_items (owner_id, window_start_at)
  where kind = 'check' and completed_at is null and status in ('open', 'missed');

create index worklog_checks_completed_by_shift_idx
  on public.worklog_activity_items (completed_by, completed_at)
  where kind = 'check' and completed_at is not null;
