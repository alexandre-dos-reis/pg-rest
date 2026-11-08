import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { authed, makeApi, type TestApi } from "./support/api";

describe.skipIf(!hasDb)("update: expressions and DEFAULT", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  /** The rows an update returns. */
  const update = async (table: string, set: object, id: number, select: string[]) => {
    const r = await t.api.update({ table, set, where: { id }, select } as never, authed());
    if (r.error) throw new Error(r.error.summary);
    return r.data;
  };
  const failure = async (set: object) => {
    const r = await t.api.update({ table: "orders", set, where: { id: 4 } } as never, authed());
    return r.error;
  };

  test("a plain value is PostgREST's PATCH, unchanged", async () => {
    expect(await update("orders", { status: "paid" }, 4, ["id", "status"])).toEqual([{ id: 4, status: "paid" }]);
  });

  test("operators work on the column's own type", async () => {
    // orders: 2 is `new`, 40.50
    expect(await update("orders", { total: { $add: [{ $col: "total" }, 10] } }, 2, ["total"])).toEqual([
      { total: 50.5 },
    ]);
    expect(await update("orders", { total: { $sub: [{ $col: "total" }, 0.5, 0] } }, 2, ["total"])).toEqual([
      { total: 50 },
    ]);
    expect(await update("orders", { total: { $div: [{ $mul: [{ $col: "total" }, 3] }, 2] } }, 2, ["total"])).toEqual([
      { total: 75 },
    ]);
    expect(await update("clients", { name: { $concat: [{ $col: "name" }, "!"] } }, 1, ["name"])).toEqual([
      { name: "Ada!" },
    ]);
    // a boolean expression, and the null-safe way to add
    expect(await update("orders", { total: { $coalesce: [{ $val: null }, { $col: "total" }] } }, 2, ["total"])).toEqual(
      [{ total: 75 }],
    );
  });

  test("arrays and jsonb", async () => {
    // an unknown-typed 'x' next to a text[] reads as an array literal, as in PostgreSQL: $val makes it an array
    expect(await update("clients", { tags: { $concat: [{ $col: "tags" }, { $val: ["new"] }] } }, 2, ["tags"])).toEqual([
      { tags: expect.arrayContaining(["new"]) },
    ]);
    expect(
      await update(
        "clients",
        { meta: { $concat: [{ $coalesce: [{ $col: "meta" }, { $val: {} }] }, { $val: { vip: true } }] } },
        1,
        ["meta"],
      ),
    ).toEqual([{ meta: expect.objectContaining({ vip: true }) }]);
    // $sub on jsonb deletes a key
    expect(await update("clients", { meta: { $sub: [{ $col: "meta" }, "vip"] } }, 1, ["meta"])).toEqual([
      { meta: expect.not.objectContaining({ vip: true }) },
    ]);
  });

  test("the functions of the fixed list", async () => {
    expect(await update("clients", { name: { $upper: { $col: "name" } } }, 1, ["name"])).toEqual([{ name: "ADA!" }]);
    expect(
      await update("clients", { name: { $lower: { $trim: { $concat: ["  ", { $col: "name" }, " "] } } } }, 1, ["name"]),
    ).toEqual([{ name: "ada!" }]);
    expect(await update("orders", { total: { $abs: { $neg: { $col: "total" } } } }, 2, ["total"])).toEqual([
      { total: 75 },
    ]);
    expect(await update("orders", { total: { $round: [{ $div: [{ $col: "total" }, 7] }, 1] } }, 2, ["total"])).toEqual([
      { total: 10.7 },
    ]);
    expect(await update("orders", { total: { $round: [{ $col: "total" }] } }, 2, ["total"])).toEqual([{ total: 11 }]);
    expect(await update("orders", { client_id: { $length: { $col: "status" } } }, 2, ["client_id"])).toEqual([
      { client_id: 3 },
    ]);
    const before = Date.now();
    const [row] = (await update("clients", { created_at: { $now: true } }, 1, ["created_at"])) as {
      created_at: string;
    }[];
    expect(Math.abs(new Date(row!.created_at).getTime() - before)).toBeLessThan(60_000);
  });

  test("array functions", async () => {
    const tags = async (set: object) => ((await update("clients", set, 2, ["tags"])) as { tags: string[] }[])[0]!.tags;
    expect(await tags({ tags: { $arrayAppend: [{ $coalesce: [{ $col: "tags" }, { $val: [] }] }, "solo"] } })).toContain(
      "solo",
    );
    expect(await tags({ tags: { $arrayRemove: [{ $col: "tags" }, "solo"] } })).not.toContain("solo");
  });

  test("DEFAULT", async () => {
    expect(await update("orders", { status: { $default: true } }, 2, ["status"])).toEqual([{ status: "new" }]);
    // several columns are several keys: (a, b) = ROW(x, DEFAULT) is a = x, b = DEFAULT
    expect(await update("orders", { status: "paid", total: { $default: true } }, 1, ["status", "total"])).toEqual([
      { status: "paid", total: 0 },
    ]);
  });

  test("a plain value and an expression in one update", async () => {
    expect(
      await update("orders", { status: "new", total: { $add: [{ $col: "total" }, 1] } }, 3, ["status", "total"]),
    ).toEqual([{ status: "new", total: 100.99 }]);
  });

  test("a function outside the list, or misused, is refused", async () => {
    for (const set of [
      { total: { $pg_sleep: [1] } },
      { total: { $now: 1 } },
      { total: { $round: [1, 2, 3] } },
      { total: { $arrayAppend: [1] } },
    ]) {
      expect((await failure(set))?.kind).toBe("invalid_query");
    }
  });

  test("mistakes are reported, not sent to the database", async () => {
    expect(await failure({ total: { $evil: 1 } })).toMatchObject({ kind: "invalid_query" });
    expect(await failure({ total: { $add: [{ $col: "nope" }, 1] } })).toMatchObject({ kind: "invalid_payload" });
    expect(await failure({ total: { $add: [{ $default: true }, 1] } })).toMatchObject({ kind: "invalid_query" });
    expect(await failure({ total: { $add: [1] } })).toMatchObject({ kind: "invalid_query" });
    expect(await failure({ total: { $cast: [1, "int; drop table api.orders"] } })).toMatchObject({
      kind: "invalid_query",
    });
    expect(await failure({ $nope: 1 })).toMatchObject({ kind: "invalid_query" });
    // a `$` object under a name that is not a column
    expect(await failure({ nope: { $add: [1, 2] } })).toMatchObject({ kind: "invalid_payload" });
  });

  test("a jsonb value whose keys start with $ is written with $val", async () => {
    const r = await update("clients", { meta: { $val: { $schema: "x" } } }, 1, ["meta"]);
    expect(r).toEqual([{ meta: { $schema: "x" } }]);
  });
});
