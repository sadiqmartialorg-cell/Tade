-- Store exact board positions in pixels. Convert the original 80px grid
-- coordinates and spread existing siblings under their parent.
alter table public.adhoc_profiles
  drop constraint if exists adhoc_profiles_tree_position_check;

with recursive numbered as (
  select id, manager_id, tree_col, tree_row,
    row_number() over (partition by manager_id order by display_name, id) as sibling_number,
    count(*) over (partition by manager_id) as sibling_count
  from public.adhoc_profiles
  where tree_placed
), positioned as (
  select id, manager_id,
    greatest(0, coalesce(tree_col, 0) * 80 + 20)::integer as x,
    greatest(0, coalesce(tree_row, 0) * 80 + 20)::integer as y,
    array[id] as path
  from numbered
  where manager_id is null or manager_id not in (select id from numbered)
  union all
  select child.id, child.manager_id,
    greatest(0, parent.x + round((child.sibling_number - (child.sibling_count + 1) / 2.0) * 220)::integer),
    least(10000, parent.y + 140), parent.path || child.id
  from numbered child
  join positioned parent on child.manager_id = parent.id
  where not child.id = any(parent.path)
)
update public.adhoc_profiles profile
set tree_col = positioned.x, tree_row = positioned.y
from positioned
where profile.id = positioned.id;

alter table public.adhoc_profiles
  add constraint adhoc_profiles_tree_position_check
  check (not tree_placed or (tree_col between 0 and 10000 and tree_row between 0 and 10000));

alter table public.adhoc_profiles
  add constraint adhoc_profiles_single_work_role_check
  check (cardinality(array_remove(job_roles, 'User Admin')) <= 1);
