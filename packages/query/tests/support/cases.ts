import type { QueryInput } from "../../src/query";

/**
 * Every input that a PostgREST query string can also express. Each name is a case of the shared
 * boundary: `packages/core/tests/parsed.fixtures.json` holds the `ParsedQuery` it must produce, and
 * the query string that produces the same one, so each package is checked against that expectation
 * rather than against the other.
 *
 * Regenerate the fixtures with `bun run gen:parsed` after adding a case or changing the builder.
 */
export const inputs: Array<[string, QueryInput]> = [
  ["bare table", { table: "orders" }],
  ["empty select", { table: "orders", columns: [] }],
  ["columns", { table: "orders", columns: ["id", "total", "*"] }],
  ["aliased column", { table: "orders", columns: ["t:total"] }],
  ["cast", { table: "orders", columns: ["total::text"] }],
  ["json path", { table: "orders", columns: ["data->a", "meta->>tier"] }],
  ["aggregate", { table: "orders", columns: ["count()", "total.sum()", "s:total.avg()"] }],
  ["equality", { table: "orders", where: { status: "paid", id: 1, ok: true, gone: null } }],
  ["operators", { table: "orders", where: { total: { $gte: 100, $lt: 500 }, name: { $ilike: "a%" } } }],
  ["not", { table: "orders", where: { total: { $not: { $gt: 5 } } } }],
  ["neq null", { table: "orders", where: { a: { $neq: null }, b: { $not: { $neq: null } }, c: { $not: null } } }],
  ["in", { table: "orders", where: { id: { $in: [1, "a b", "x,y", "", null, 'q"'] } } }],
  ["contains", { table: "orders", where: { tags: { $cs: ["a", "b,c"] }, r: { $ov: [1, 2] } } }],
  ["quantifier", { table: "orders", where: { id: { $any: { $eq: [1, 2] } }, n: { $all: { $gt: [1] } } } }],
  ["fts", { table: "orders", where: { t: { $fts: { query: "a b", config: "english" } }, u: { $wfts: "x" } } }],
  ["is", { table: "orders", where: { a: { $is: true }, b: { $is: "NULL" }, c: { $is: "unknown" } } }],
  ["value text", { table: "orders", where: { a: "a,b", b: "null", c: " x ", d: "" } }],
  ["composite", { table: "orders", where: { a: { x: 1, y: [1, 2] } } }],
  ["json path filter", { table: "orders", where: { "data->a": 1, "meta->>tier": { $like: "g*" } } }],
  ["or", { table: "orders", where: { $or: [{ id: 1 }, { id: { $in: [2, 3] } }] } }],
  ["and in or", { table: "orders", where: { $or: [{ a: 1, b: { $gt: 2, $lt: 5 } }, { c: "x,y" }] } }],
  ["not group", { table: "orders", where: { $not: { a: 1, b: 2 }, $and: [{ c: 3 }] } }],
  ["nested groups", { table: "orders", where: { $or: [{ $not: { a: 1 } }, { $and: [{ b: 2 }, { c: 3 }] }] } }],
  ["order", { table: "orders", order: ["total.desc", "id", "a.asc.nullslast", "b.desc.nullsfirst"] }],
  ["order objects", { table: "orders", order: [{ column: "a", desc: true, nulls: "first" }, { column: "b" }] }],
  ["order by a related column", { table: "orders", order: ["client(name).desc", "data->a.asc"] }],
  ["paging", { table: "orders", limit: 10, offset: 20 }],
  ["paging that is not a count is ignored", { table: "orders", limit: 1.5, offset: -1 }],
  ["embed", { table: "orders", columns: ["id", { clients: { columns: ["name"], inner: true } }] }],
  [
    "embed shorthand, alias, hint, spread",
    {
      table: "orders",
      columns: [{ clients: ["name"] }, { c2: { columns: ["*"], hint: "fk", spread: true } }, { c3: { as: "buyer" } }],
    },
  ],
  [
    "embed with its own filters",
    {
      table: "orders",
      columns: [
        {
          items: {
            columns: ["id", { product: { columns: ["name"], where: { name: { $like: "a%" } } } }],
            where: { qty: { $gt: 1 } },
            order: ["id.desc"],
            limit: 5,
            offset: 1,
          },
        },
      ],
    },
  ],
  ["empty embed", { table: "orders", columns: [{ clients: { columns: [] } }] }],
  [
    "a filter through the path of an embed",
    { table: "orders", columns: [{ clients: ["id"] }], where: { "clients.name": "a" } },
  ],
  [
    "a filter through the alias, and through the table name of an aliased one",
    { table: "orders", columns: [{ clients: { as: "buyer" } }], where: { "buyer.id": 1, "clients.name": "a" } },
  ],
  [
    "presence of an embed",
    {
      table: "orders",
      columns: [{ clients: ["id"] }, { items: ["id"] }],
      where: { clients: null, items: { $not: null } },
    },
  ],
  [
    "insert",
    { table: "orders", action: "insert", rows: { a: 1 }, returning: ["id"], onConflict: ["id"], columns: ["a", "b"] },
  ],
  ["upsert odd columns", { table: "orders", action: "upsert", rows: { a: 1 }, columns: ["a b"] }],
  ["update", { table: "orders", action: "update", set: { a: 1 }, where: { id: 1 } }],
  ["delete", { table: "orders", action: "delete", where: { id: { $in: [1, 2] } } }],
  ["rpc", { name: "f", args: { a: 1 }, where: { x: 1 }, columns: ["a"] }],
];
