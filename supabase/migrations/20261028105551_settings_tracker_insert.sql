-- Active Adhoc Tracker users can add shared dropdown entries. The existing
-- User Admin policies still govern updates and deletes.
create policy adhoc_lookup_tracker_insert on public.adhoc_departments
  for insert to authenticated
  with check ((select adhoc_private.adhoc_has_tracker_access()));

create policy adhoc_customers_tracker_insert on public.adhoc_customers
  for insert to authenticated
  with check ((select adhoc_private.adhoc_has_tracker_access()));

create policy adhoc_tasks_tracker_insert on public.adhoc_tasks
  for insert to authenticated
  with check ((select adhoc_private.adhoc_has_tracker_access()));
