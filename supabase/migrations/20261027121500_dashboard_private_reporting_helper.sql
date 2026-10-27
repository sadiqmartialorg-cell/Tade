-- Existing TADE projects keep the reporting helper in a private schema.
do $$
declare function_sql text;
begin
  select pg_get_functiondef('public.adhoc_dashboard_v2(date,date)'::regprocedure)
  into function_sql;
  execute replace(function_sql,
    'public.adhoc_can_view_user(', 'adhoc_private.adhoc_can_view_user(');
end $$;
