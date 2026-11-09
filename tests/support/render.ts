// The query string an input stands for: what `query()` used to render and `@tsql/rest`'s parser read.
// It is not part of `@tsql/query` any more -- the library builds the parsed form directly -- but it is
// the oracle of `packages/query/tests/query-direct.test.ts`, and the spelling `docs/query.md` explains each field with.
import type {
  DeleteQuery,
  Embed,
  Filter,
  FilterValue,
  InsertQuery,
  NodeFields,
  Order,
  QueryInput,
  Select,
  SelectQuery,
  UpdateQuery,
  Where,
} from "../../packages/query/src/query";
import {
  GROUPS,
  type Leaf,
  bad,
  checkKey,
  groupMembers,
  isGroupKey,
  listOf,
  lit,
  toLeaves,
} from "../../packages/query/src/query";

/** The right-hand side of one leaf: `[not.]op[(modifier)].value`. */
const renderLeaf = (leaf: Leaf, delimited: boolean): string => {
  // `col = NULL` is never true in SQL, so comparing with null is a NULL test
  if (leaf.value === null && (leaf.op === "eq" || leaf.op === "neq")) {
    return `${leaf.not !== (leaf.op === "neq") ? "not." : ""}is.null`;
  }
  if (leaf.quantifier && leaf.config)
    throw bad("A filter cannot have both a quantifier and a text-search configuration");
  const modifier = leaf.quantifier ?? leaf.config;
  const op = `${leaf.not ? "not." : ""}${leaf.op}${modifier ? `(${modifier})` : ""}`;
  const value = Array.isArray(leaf.value)
    ? listOf(leaf.op, leaf.value as ReadonlyArray<FilterValue>)
    : lit(leaf.value as FilterValue | undefined, delimited);
  return `${op}.${value}`;
};

/** The conditions on one column, as many as it has operators. */
const renderFilters = (column: string, f: Filter, delimited: boolean): string[] =>
  toLeaves(column, f).map((leaf) => renderLeaf(leaf, delimited));

/** `name(member,member)`: a `$not` group is the AND of its conditions, inverted. */
const renderGroupTree = (key: string, value: unknown): string => {
  const members = groupMembers(key, value);
  const inner = key === "$not" ? renderConditions(members[0]!) : members.map(renderGroup);
  if (key === "$not" && inner.length === 0) throw bad("A $not group cannot be empty");
  return `(${inner.join(",")})`;
};

/** Every condition of a `Where`, rendered as a logic tree would carry them (`total.gte.100`). */
const renderConditions = (w: Where): string[] =>
  Object.entries(w).flatMap(([key, value]) => {
    if (value === undefined) return [];
    checkKey(key);
    if (isGroupKey(key)) return [`${GROUPS[key]}${renderGroupTree(key, value)}`];
    return renderFilters(key, value as Filter, true).map((f) => `${key}.${f}`);
  });

/** One member of an `$and`/`$or` list. Several conditions in the same object are ANDed. */
const renderGroup = (w: Where): string => {
  const parts = renderConditions(w);
  if (parts.length === 0) throw bad("An $and/$or group cannot be empty");
  return parts.length === 1 ? parts[0]! : `and(${parts.join(",")})`;
};

const renderOrder = (o: Order): string => {
  if (typeof o === "string") return o;
  const nulls = o.nulls === "first" ? ".nullsfirst" : o.nulls === "last" ? ".nullslast" : "";
  return `${o.column}${o.desc ? ".desc" : ".asc"}${nulls}`;
};

type Params = Array<[string, string]>;

/** `where`, `order`, `limit` and `offset` of one node, prefixed with its dotted path. */
const pushNode = (node: NodeFields, path: ReadonlyArray<string>, out: Params): void => {
  const at = path.length ? `${path.join(".")}.` : "";
  for (const [key, value] of Object.entries(node.where ?? {})) {
    if (value === undefined) continue;
    checkKey(key);
    if (isGroupKey(key)) {
      out.push([`${at}${GROUPS[key]}`, renderGroupTree(key, value)]);
    } else {
      // a dotted key filters an embedded resource, and keeps its own path
      for (const f of renderFilters(key, value as Filter, false)) out.push([`${at}${key}`, f]);
    }
  }
  if (node.order?.length) out.push([`${at}order`, node.order.map(renderOrder).join(",")]);
  if (node.limit !== undefined) out.push([`${at}limit`, String(node.limit)]);
  if (node.offset !== undefined) out.push([`${at}offset`, String(node.offset)]);
};

const isEmbed = (v: Select | Embed): v is Embed => !Array.isArray(v);

/** The `select` parameter. Embedded resources also push their own filters and paging into `out`. */
const renderSelect = (items: Select, path: ReadonlyArray<string>, out: Params): string => {
  const parts = items.map((item) => {
    if (typeof item === "string") return item;
    return Object.entries(item)
      .map(([relation, spec]) => {
        const embed: Embed = isEmbed(spec) ? spec : { columns: spec };
        // filters address an embed by its alias when it has one, like the query string
        const name = embed.as ?? relation;
        const mods = `${embed.hint ? `!${embed.hint}` : ""}${embed.inner ? "!inner" : ""}`;
        const head = `${embed.spread ? "..." : ""}${embed.as ? `${embed.as}:` : ""}${relation}${mods}`;
        const inner = renderSelect(embed.columns ?? ["*"], [...path, name], out);
        pushNode(embed, [...path, name], out);
        return `${head}(${inner})`;
      })
      .join(",");
  });
  return parts.join(",");
};

/** The `columns` of a read or a function call, and the list a write's `returning` may be. */
const columnsOf = (input: QueryInput): Select | undefined => {
  if ("name" in input) return input.columns;
  if (input.action === undefined || input.action === "select") return (input as SelectQuery).columns;
  const asked = (input as InsertQuery | UpdateQuery | DeleteQuery).returning;
  return typeof asked === "object" ? asked : undefined;
};

/** Everything the query string would carry, built from the object instead of parsed from a URL. */
export const toParams = (input: QueryInput): Params => {
  const out: Params = [];
  // embedded resources push their own parameters while the select string is built, so collect
  // them aside and keep `select` first, where a reader expects it
  const embedded: Params = [];
  const listed = columnsOf(input);
  if (listed) out.push(["select", renderSelect(listed, [], embedded)]);
  out.push(...embedded);
  pushNode(input, [], out);
  if ("action" in input && (input.action === "insert" || input.action === "upsert")) {
    if (input.onConflict?.length) out.push(["on_conflict", input.onConflict.join(",")]);
    if (input.columns?.length) out.push(["columns", input.columns.join(",")]);
  }
  return out;
};
