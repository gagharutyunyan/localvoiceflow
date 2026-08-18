/**
 * Returns a copy of `set` with every id in `ids` added or removed. Used by the
 * header "select all" checkboxes: they must only touch the rows currently listed,
 * never discard a selection accumulated on other pages or under other filters.
 */
export function withIdsSelected(
  set: ReadonlySet<string>,
  ids: readonly string[],
  selected: boolean,
): Set<string> {
  const next = new Set(set);
  for (const id of ids) {
    if (selected) next.add(id);
    else next.delete(id);
  }
  return next;
}
