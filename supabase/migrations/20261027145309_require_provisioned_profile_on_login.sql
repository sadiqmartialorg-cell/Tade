-- Accounts are provisioned by a User Admin with a work role before login.
-- Checking the existing profile first also avoids an invalid empty-role
-- INSERT attempt when the account already exists.
create or replace function public.adhoc_ensure_profile(p_display_name text default null)
returns public.adhoc_profiles language plpgsql security definer set search_path = '' as $$
declare result public.adhoc_profiles;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into result from public.adhoc_profiles
  where id = (select auth.uid()) and active;
  if not found then raise exception 'Account is inactive or not provisioned'; end if;
  return result;
end;
$$;
