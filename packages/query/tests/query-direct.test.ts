import { describe, expect, test } from "bun:test";
import type { QueryInput } from "../src/query";
import { toParsed } from "../src/query";
import { normalizeParsed } from "../../core/tests/support/parsed";
import { inputs } from "./support/cases";
import fixtures from "../../core/tests/parsed.fixtures.json";

/**
 * `toParsed` builds `@tsql/core`'s `ParsedQuery` from the object. For everything a query string can
 * also say, it must build what the string means -- that is what keeps the two packages one engine.
 *
 * The expectation is `@tsql/core`'s, committed in `parsed.fixtures.json`, so this suite never runs
 * `@tsql/rest`: that package is pinned against the same file from its own side.
 */

// What the string route refuses, `toParsed` refuses too -- in `query`'s own words.
const refused: Array<[string, unknown]> = [
  ["an unknown $is value", { table: "orders", where: { a: { $is: "maybe" } } }],
  ["$in without a list", { table: "orders", where: { a: { $in: 1 } } }],
  ["an empty group", { table: "orders", where: { $or: [] } }],
  ["an empty $not", { table: "orders", where: { $not: {} } }],
  ["a quantifier on an operator that has none", { table: "orders", where: { a: { $any: { $in: [1] } } } }],
  ["a bad text search configuration", { table: "orders", where: { a: { $fts: { query: "x", config: "no good" } } } }],
  ["a spread that is renamed", { table: "orders", columns: [{ c: { as: "x", spread: true } }] }],
  ["a filter through something that is not embedded", { table: "orders", where: { "nope.x": 1 } }],
  [
    "a filter on an embed that is not a null test",
    { table: "orders", columns: [{ clients: ["id"] }], where: { clients: 1 } },
  ],
];

// Where `query` is more exact than a query string can be: a name that only a query string reserves.
describe("query -> ParsedQuery, directly", () => {
  for (const [name, input] of inputs) {
    test(name, () => {
      const expected = (fixtures as Record<string, { parsed: unknown }>)[name];
      if (!expected) throw new Error(`${name} has no fixture -- run \`bun run gen:parsed\``);
      expect(normalizeParsed(toParsed(input))).toEqual(expected.parsed);
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
    const p = toParsed({ table: "t", columns: [{ clients: { hint: "inner" } }] });
    expect(p.select[0]).toMatchObject({ kind: "embed", hint: "inner", join: "left" });
  });

  test("an order keyword in capitals is read", () => {
    expect(toParsed({ table: "t", order: ["b.DESC"] }).root.order).toEqual([
      { field: { name: "b", json: [] }, dir: "desc" },
    ]);
  });
});
