import { describe, expect, test } from "bun:test";
import type { QueryInput } from "../packages/query/src/query";
import { toParams, toParsed } from "../packages/query/src/query";
import { parseQuery } from "../packages/core/src/parse/filter";

/** What the engine used to get: the object rendered as a query string, then parsed. */
const viaString = (input: QueryInput) => parseQuery(toParams(input));

// [name, input, goesDirect]: the second says whether `toParsed` is expected to take the shape
const corpus: Array<[string, unknown, boolean]> = [
  ["bare table", { table: "orders" }, true],
  ["empty select", { table: "orders", select: [] }, true],
  ["columns", { table: "orders", select: ["id", "total", "*"] }, true],
  ["aliased column", { table: "orders", select: ["t:total"] }, true],
  ["cast", { table: "orders", select: ["total::text"] }, false],
  ["json path", { table: "orders", select: ["data->a"] }, false],
  ["aggregate", { table: "orders", select: ["count()"] }, false],
  ["equality", { table: "orders", where: { status: "paid", id: 1, ok: true, gone: null } }, true],
  ["operators", { table: "orders", where: { total: { $gte: 100, $lt: 500 }, name: { $ilike: "a%" } } }, true],
  ["not", { table: "orders", where: { total: { $not: { $gt: 5 } } } }, true],
  ["neq null", { table: "orders", where: { a: { $neq: null }, b: { $not: { $neq: null } }, c: { $not: null } } }, true],
  ["in", { table: "orders", where: { id: { $in: [1, "a b", "x,y", "", null, 'q"'] } } }, true],
  ["contains", { table: "orders", where: { tags: { $cs: ["a", "b,c"] }, r: { $ov: [1, 2] } } }, true],
  ["quantifier", { table: "orders", where: { id: { $any: { $eq: [1, 2] } }, n: { $all: { $gt: [1] } } } }, true],
  ["fts", { table: "orders", where: { t: { $fts: { query: "a b", config: "english" } }, u: { $wfts: "x" } } }, true],
  ["is", { table: "orders", where: { a: { $is: true }, b: { $is: "NULL" }, c: { $is: "unknown" } } }, true],
  ["bad is", { table: "orders", where: { a: { $is: "maybe" } } }, false],
  ["value text", { table: "orders", where: { a: "a,b", b: "null", c: " x ", d: "" } }, true],
  ["composite", { table: "orders", where: { a: { x: 1, y: [1, 2] } } }, true],
  ["or", { table: "orders", where: { $or: [{ id: 1 }, { id: { $in: [2, 3] } }] } }, true],
  ["and in or", { table: "orders", where: { $or: [{ a: 1, b: { $gt: 2, $lt: 5 } }, { c: "x,y" }] } }, true],
  ["not group", { table: "orders", where: { $not: { a: 1, b: 2 }, $and: [{ c: 3 }] } }, true],
  ["nested groups", { table: "orders", where: { $or: [{ $not: { a: 1 } }, { $and: [{ b: 2 }, { c: 3 }] }] } }, true],
  ["empty group", { table: "orders", where: { $or: [] } }, false],
  ["order", { table: "orders", order: ["total.desc", "id", "a.asc.nullslast", "b.desc.nullsfirst"] }, true],
  ["order objects", { table: "orders", order: [{ column: "a", desc: true, nulls: "first" }, { column: "b" }] }, true],
  ["uppercase order", { table: "orders", order: ["b.DESC"] }, false],
  ["spread with alias", { table: "orders", select: [{ c: { as: "x", spread: true } }] }, false],
  ["order related", { table: "orders", order: ["client(name).desc"] }, false],
  ["paging", { table: "orders", limit: 10, offset: 20 }, true],
  ["bad paging", { table: "orders", limit: 1.5 }, false],
  ["negative offset", { table: "orders", offset: -1 }, false],
  ["embed", { table: "orders", select: ["id", { clients: { select: ["name"], inner: true } }] }, true],
  [
    "embed shorthand, alias, hint, spread",
    {
      table: "orders",
      select: [{ clients: ["name"] }, { c2: { select: ["*"], hint: "fk", spread: true } }, { c3: { as: "buyer" } }],
    },
    true,
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
    true,
  ],
  ["empty embed", { table: "orders", select: [{ clients: { select: [] } }] }, true],
  [
    "embed named like a column filter",
    { table: "orders", select: [{ clients: ["id"] }], where: { clients: { $is: null } } },
    false,
  ],
  ["reserved column", { table: "orders", where: { order: 1 } }, false],
  ["dotted key", { table: "orders", where: { "clients.name": "a" } }, false],
  ["json key", { table: "orders", where: { "data->a": 1 } }, false],
  ["hint named inner", { table: "orders", select: [{ clients: { hint: "inner" } }] }, false],
  [
    "insert",
    { table: "orders", action: "insert", rows: { a: 1 }, select: ["id"], onConflict: ["id"], columns: ["a", "b"] },
    true,
  ],
  ["upsert odd columns", { table: "orders", action: "upsert", rows: { a: 1 }, columns: ["a b"] }, false],
  ["update", { table: "orders", action: "update", set: { a: 1 }, where: { id: 1 } }, true],
  ["delete", { table: "orders", action: "delete", where: { id: { $in: [1, 2] } } }, true],
  ["rpc", { rpc: "f", args: { a: 1 }, where: { x: 1 }, select: ["a"] }, true],
];

describe("query -> ParsedQuery, directly", () => {
  for (const [name, input, direct] of corpus) {
    test(name, () => {
      const parsed = toParsed(input as QueryInput);
      expect(parsed !== undefined).toBe(direct);
      if (parsed) expect(parsed).toEqual(viaString(input as QueryInput));
    });
  }
});
