/** `input/manual/a.md` is the file `a.md` in the folder `manual`. */
export function splitPath(path) {
  const rest = path.replace(/^(input|output)\//, "");
  const cut = rest.lastIndexOf("/");
  return { folder: cut < 0 ? "" : rest.slice(0, cut), name: rest.slice(cut + 1) };
}

/** Records matching the filter, grouped by folder, both in a stable order. */
export function groupFiles(records, query = "") {
  const needle = query.trim().toLowerCase();
  const groups = new Map();
  for (const record of records) {
    const { folder, name } = splitPath(record.path);
    if (needle && !`${folder}/${name}`.toLowerCase().includes(needle)) continue;
    if (!groups.has(folder)) groups.set(folder, []);
    groups.get(folder).push({ ...record, folder, name });
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, items]) => ({ folder, records: items.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** The order the list shows files in: what previous and next walk. */
export const orderedPaths = records => groupFiles(records).flatMap(group => group.records.map(record => record.path));

/** One step along the list; past either end there is nothing. */
export function neighbour(paths, path, step) {
  const at = paths.indexOf(path);
  return at < 0 ? undefined : paths[at + step];
}

/** Below this many files a filter box is clutter. */
export const FILTER_FROM = 6;

/** One page of grouped files: the pageSize-long slice of the flat list, regrouped by folder. */
export function pageGroups(groups, page, size) {
  const total = groups.reduce((sum, group) => sum + group.records.length, 0);
  const pages = Math.max(1, Math.ceil(total / size));
  const at = Math.min(Math.max(page, 1), pages);
  let skip = (at - 1) * size, take = size;
  const shown = [];
  for (const group of groups) {
    const records = group.records.slice(skip, skip + take);
    skip = Math.max(0, skip - group.records.length); take -= records.length;
    if (records.length) shown.push({ ...group, records });
  }
  return { groups: shown, page: at, pages };
}
