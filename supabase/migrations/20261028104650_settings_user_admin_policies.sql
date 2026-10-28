-- Direct Data API writes to shared dropdown lists must follow User Admin access.
-- Regular tracker users add entries through the Edge Function after role checks.
alter policy adhoc_lookup_admin_all on public.adhoc_departments
  using ((select public.adhoc_is_user_admin()))
  with check ((select public.adhoc_is_user_admin()));

alter policy adhoc_customers_admin_all on public.adhoc_customers
  using ((select public.adhoc_is_user_admin()))
  with check ((select public.adhoc_is_user_admin()));

alter policy adhoc_tasks_admin_all on public.adhoc_tasks
  using ((select public.adhoc_is_user_admin()))
  with check ((select public.adhoc_is_user_admin()));
