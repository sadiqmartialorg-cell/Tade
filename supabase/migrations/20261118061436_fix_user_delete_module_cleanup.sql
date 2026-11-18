-- Auth deletes cascade through module grants as supabase_auth_admin. Run the
-- grant cleanup trigger with its postgres owner so it can update task sessions.
-- The function is private, has an empty search_path, and has no public EXECUTE grant.
alter function adhoc_private.worklog_pause_on_module_revoke() security definer;
