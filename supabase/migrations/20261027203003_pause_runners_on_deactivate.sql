-- A deactivated account must not accumulate unattended timer time.
create or replace function adhoc_private.adhoc_pause_runners_on_deactivate()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.active and not new.active then
    update public.adhoc_task_sessions
    set accumulated_seconds = accumulated_seconds
      + greatest(0, floor(extract(epoch from (clock_timestamp() - active_since)))::integer),
        state = 'paused', active_since = null
    where owner_id = new.id and state = 'running';
  end if;
  return new;
end;
$$;

revoke all on function adhoc_private.adhoc_pause_runners_on_deactivate() from public, anon, authenticated;

create trigger adhoc_pause_runners_on_deactivate
after update of active on public.adhoc_profiles
for each row execute function adhoc_private.adhoc_pause_runners_on_deactivate();
