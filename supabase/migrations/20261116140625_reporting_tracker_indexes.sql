create index reporting_logs_department_idx on public.reporting_logs(department_id);
create index reporting_logs_customer_idx on public.reporting_logs(customer_id);
create index reporting_logs_task_idx on public.reporting_logs(task_id);
create index reporting_logs_raised_by_idx on public.reporting_logs(raised_by_id);

-- Module registry and grants are managed only through the authenticated Edge API.
-- Explicit deny policies document that direct Data API access is unavailable.
create policy worklog_modules_no_direct_access on public.worklog_modules
  for all to authenticated using (false) with check (false);
create policy worklog_user_modules_no_direct_access on public.worklog_user_modules
  for all to authenticated using (false) with check (false);
