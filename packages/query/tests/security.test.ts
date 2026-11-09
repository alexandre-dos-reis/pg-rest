import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb } from "../../../tests/support/db";
import { authed, makeApi, type TestQuery } from "./support/api";

const PAYLOADS = [
  "1; DROP TABLE api.clients; --",
  "' OR '1'='1",
  "x') OR 1=1 --",
  "\\'; DELETE FROM api.clients; --",
  "1) UNION SELECT rolname FROM pg_roles --",
  "$$; DROP TABLE api.clients; $$",
];

/**
 * Hostile input through the object API. `query()` builds the query parameters itself, so a value
 * must never be able to end up read as syntax, and a name that is not a name has to be refused.
 */
describe.skipIf(!hasDb)("hostile input through query()", () => {
  let t: TestQuery;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  const intact = async () => {
    const rows = await t.db.adapter.query("SELECT count(*)::int AS n FROM api.clients");
    expect(rows[0]!["n"]).toBeGreaterThan(0);
  };

  test("select(): a NUL byte in a name is refused, not cut", async () => {
    const r = await t.api.select({ table: "clients", where: { name: "a\u0000b" } });
    expect(r.error?.kind).toBe("invalid_query");
  });

  test("select(): hostile values stay values, hostile column names are refused", async () => {
    for (const p of PAYLOADS) {
      expect((await t.api.select({ table: "clients", columns: ["id"], where: { name: p } })).data).toEqual([]);
      expect(
        (await t.api.select({ table: "clients", columns: ["id"], where: { name: { $in: [p, "x"] } } })).data,
      ).toEqual([]);
      expect(
        (await t.api.select({ table: "clients", columns: ["id"], where: { $or: [{ name: p }, { email: p }] } })).data,
      ).toEqual([]);
      // a column name is an identifier: it is checked against the schema, never interpolated
      const key = await t.api.select({ table: "clients", where: { [p]: 1 } });
      expect(key.error).not.toBeNull();
      expect(key.error?.kind).not.toBe("internal");
    }
    await intact();
  });

  test("select(): hostile values and names in the expressions of set stay values or are refused", async () => {
    const run = (set: object) => t.api.update({ table: "clients", set, where: { id: 3 } } as never, authed());
    for (const p of PAYLOADS) {
      // a string is a literal, whatever it says
      const r = await run({ name: { $concat: [{ $col: "name" }, p] } });
      expect(r.error).toBeNull();
      // a column, a type and a key are checked, never interpolated
      expect((await run({ name: { $col: p } })).error?.kind).not.toBe("internal");
      expect((await run({ name: { $add: [{ $col: p }, 1] } })).error?.kind).not.toBe("internal");
      expect((await run({ name: { $cast: [1, p] } })).error?.kind).not.toBe("internal");
      expect((await run({ [p]: { $add: [1, 2] } })).error?.kind).not.toBe("internal");
      expect((await run({ name: { [p]: 1 } })).error?.kind).not.toBe("internal");
    }
    await intact();
  });

  // `nulls` is a keyword in the statement: a value that did not come through the type (JSON) must not reach it
  test("select(): order's nulls only takes first or last, and names are strings", async () => {
    for (const p of PAYLOADS) {
      const r = await t.api.select({ table: "clients", order: [{ column: "id", nulls: p as never }] });
      expect(r.error?.kind).toBe("invalid_query");
    }
    const timed = performance.now();
    const r = await t.api.select({
      table: "clients",
      order: [{ column: "id", nulls: "first, (select pg_sleep(1)::text)" as never }],
    });
    expect(r.error?.kind).toBe("invalid_query");
    expect(performance.now() - timed).toBeLessThan(900);
    for (const nulls of ["first", "last"] as const) {
      expect((await t.api.select({ table: "clients", order: [{ column: "id", nulls }] })).error).toBeNull();
    }
    // an object with its own toString is not a name
    const name = { toString: () => "clients" };
    expect((await t.api.select({ table: name as never })).error?.kind).toBe("invalid_query");
    expect((await t.api.rpc({ name: name as never })).error?.kind).toBe("invalid_query");
    expect((await t.api.select({ table: "clients", schema: name as never })).error?.kind).toBe("invalid_query");
    await intact();
  });

  test("select(): a string with quotes round-trips unchanged", async () => {
    const name = `O'Brien "the" \\ ; -- $$ x, (y)`;
    const created = await t.api.insert<{ name: string }>(
      { table: "clients", rows: { name }, returning: ["name"] },
      { role: "authenticated" },
    );
    expect(created.data).toEqual({ name });
    const found = await t.api.select({ table: "clients", columns: ["name"], where: { name } });
    expect(found.data).toEqual([{ name }]);
    await t.db.adapter.query("DELETE FROM api.clients WHERE name = $1::text", [name]);
  });
});
