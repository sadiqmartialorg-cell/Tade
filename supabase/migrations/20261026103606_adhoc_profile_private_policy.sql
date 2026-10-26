alter policy adhoc_profiles_select on public.adhoc_profiles
  using (adhoc_private.adhoc_can_view_user(id));
