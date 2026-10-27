-- A reporting line is created by placing a person on the User Tree board.
-- Root positions are stored as grid cells; children are laid out beneath
-- their reporting manager by the browser.
alter table public.adhoc_profiles
  add column if not exists tree_placed boolean not null default false,
  add column if not exists tree_col integer,
  add column if not exists tree_row integer;

alter table public.adhoc_profiles
  add constraint adhoc_profiles_tree_position_check
  check (
    not tree_placed or
    (tree_col between 0 and 100 and tree_row between 0 and 100)
  );
