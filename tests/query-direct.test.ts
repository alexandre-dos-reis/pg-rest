import { describe, expect, test } from "bun:test";
import type { QueryInput } from "../packages/query/src/query";
import { toParsed } from "../packages/query/src/query";
import { parseQuery } from "../packages/rest/src/parse/query-string";
import { toParams } from "./support/render";

/** What `@tsql/rest` reads from the query string the input stands for. */
const viaString = (input: QueryInput) => parseQuery(toParams(input));

// `toParsed` builds the parsed form from the object. For everything a query string can say, it must be
// what the string parses to: that is what keeps `query` and `rest` one engine.
const same: Array<[string, unknown]> = [
  ["bare table", { table: "orders" }],
  ["empty select", { table: "orders", select: [] }],
  ["columns", { table: "orders", select: ["id", "total", "*"] }],
  ["aliased column", { table: "orders", select: ["t:total"] }],
  ["cast", { table: "orders", select: ["total::text"] }],
  ["json path", { table: "orders", select: ["data->a", "meta->>tier"] }],
  ["aggregate", { table: "orders", select: ["count()", "total.sum()", "s:total.avg()"] }],
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
  ["embed", { table: "orders", select: ["id", { clients: { select: ["name"], inner: true } }] }],
  [
    "embed shorthand, alias, hint, spread",
    {
      table: "orders",
      select: [{ clients: ["name"] }, { c2: { select: ["*"], hint: "fk", spread: true } }, { c3: { as: "buyer" } }],
    },
  ],
  [
    "embed with its own filters",
    {
      table: "orders",
      select: [
        {
          items: {
            select: ["id", { product: { select: ["name"], where: { name: { $like: "a%" } } } }],
            where: { qty: { $gt: 1 } },
            order: ["id.desc"],
            limit: 5,
            offset: 1,
          },
        },
      ],
    },
  ],
  ["empty embed", { table: "orders", select: [{ clients: { select: [] } }] }],
  [
    "a filter through the path of an embed",
    { table: "orders", select: [{ clients: ["id"] }], where: { "clients.name": "a" } },
  ],
  [
    "a filter through the alias, and through the table name of an aliased one",
    { table: "orders", select: [{ clients: { as: "buyer" } }], where: { "buyer.id": 1, "clients.name": "a" } },
  ],
  [
    "presence of an embed",
    {
      table: "orders",
      select: [{ clients: ["id"] }, { items: ["id"] }],
      where: { clients: null, items: { $not: null } },
    },
  ],
  [
    "insert",
    { table: "orders", action: "insert", rows: { a: 1 }, select: ["id"], onConflict: ["id"], columns: ["a", "b"] },
  ],
  ["upsert odd columns", { table: "orders", action: "upsert", rows: { a: 1 }, columns: ["a b"] }],
  ["update", { table: "orders", action: "update", set: { a: 1 }, where: { id: 1 } }],
  ["delete", { table: "orders", action: "delete", where: { id: { $in: [1, 2] } } }],
  ["rpc", { rpc: "f", args: { a: 1 }, where: { x: 1 }, select: ["a"] }],
];

// What the string route refuses, `toParsed` refuses too -- in `query`'s own words.
const refused: Array<[string, unknown]> = [
  ["an unknown $is value", { table: "orders", where: { a: { $is: "maybe" } } }],
  ["$in without a list", { table: "orders", where: { a: { $in: 1 } } }],
  ["an empty group", { table: "orders", where: { $or: [] } }],
  ["an empty $not", { table: "orders", where: { $not: {} } }],
  ["a quantifier on an operator that has none", { table: "orders", where: { a: { $any: { $in: [1] } } } }],
  ["a bad text search configuration", { table: "orders", where: { a: { $fts: { query: "x", config: "no good" } } } }],
  ["a spread that is renamed", { table: "orders", select: [{ c: { as: "x", spread: true } }] }],
  ["a filter through something that is not embedded", { table: "orders", where: { "nope.x": 1 } }],
  [
    "a filter on an embed that is not a null test",
    { table: "orders", select: [{ clients: ["id"] }], where: { clients: 1 } },
  ],
];

// Where `query` is more exact than a query string can be: a name that only a query string reserves.
describe("query -> ParsedQuery, directly", () => {
  for (const [name, input] of same) {
    test(name, () => {
      expect(toParsed(input as QueryInput)).toEqual(viaString(input as QueryInput));
    });
  }

  for (const [name, input] of refused) {
    test(`refuses ${name}`, () => {
      expect(() => toParsed(input as QueryInput)).toThrow();
    });
  }

  test("a column may be called like a word of the query string", () => {
    const p = toParsed({ table: "t", where: { order: 1, limit: { $gt: 2 }, select: "x", and: true } });
    expect(p.root.filters.map((f) => (f.kind === "filter" ? f.field.name : "?"))).toEqual([
      "order",
      "limit",
      "select",
      "and",
    ]);
    expect(p.root.limit).toBeUndefined();
  });

  test("a hint is a name, whatever it is called", () => {
    const p = toParsed({ table: "t", select: [{ clients: { hint: "inner" } }] });
    expect(p.select[0]).toMatchObject({ kind: "embed", hint: "inner", join: "left" });
  });

  test("an order keyword in capitals is read", () => {
    expect(toParsed({ table: "t", order: ["b.DESC"] }).root.order).toEqual([
      { field: { name: "b", json: [] }, dir: "desc" },
    ]);
  });
});
