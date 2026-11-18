-- Initialize Reporting Tracker with the existing MS Tracker lookup names.
-- Preserve inactive entries and their status; tasks and people stay empty.
insert into public.reporting_departments (name, active, sort_order)
select name, active, sort_order from public.adhoc_departments
on conflict (name) do nothing;

insert into public.reporting_customers (name, active, sort_order)
select name, active, sort_order from public.adhoc_customers
on conflict (name) do nothing;
