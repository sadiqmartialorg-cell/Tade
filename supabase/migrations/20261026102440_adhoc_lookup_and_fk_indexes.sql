create index if not exists adhoc_profiles_manager_id_idx on public.adhoc_profiles(manager_id);
create index if not exists adhoc_logs_department_id_idx on public.adhoc_logs(department_id);
create index if not exists adhoc_logs_customer_id_idx on public.adhoc_logs(customer_id);
create index if not exists adhoc_logs_task_id_idx on public.adhoc_logs(task_id);
