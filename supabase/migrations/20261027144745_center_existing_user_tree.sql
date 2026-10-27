-- Keep the placed group near the left edge when the board opens.
with bounds as (
  select min(tree_col) as left_edge from public.adhoc_profiles where tree_placed
)
update public.adhoc_profiles profile
set tree_col = profile.tree_col - bounds.left_edge + 80
from bounds
where profile.tree_placed and bounds.left_edge is not null;
