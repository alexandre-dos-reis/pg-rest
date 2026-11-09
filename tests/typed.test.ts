import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgRest, type TypedPgRestInstance } from "./support/pgrest";
import { createTestDb, hasDb, type TestDb } from "./support/db";
import type { DatabasePgRest } from "./support/fixture.types";

/**
 * Types are checked by `bun run typecheck`, which compiles this file; `bun test` runs the calls, so
 * one suite covers both. `@ts-expect-error` is the negative half: it fails the typecheck if the line
 * it guards ever stops being an error.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>(): void => {};

/**
 * `query` hands a failure back as `error`, so reading `data` means narrowing first. The tests below
 * are about the *shape* of a result that worked: this raises whatever went wrong and narrows, which
 * is the one place in the suite where a failure is not the thing under test.
 */
const ok = <R extends { readonly error: unknown }>(r: R): Extract<R, { readonly error: null }> => {
  if (r.error) throw r.error;
  return r as Extract<R, { readonly error: null }>;
};

describe.skipIf(!hasDb)("a typed instance", () => {
  let db: TestDb;
  let pgRest: TypedPgRestInstance<DatabasePgRest>;
  beforeAll(async () => {
    db = await createTestDb();
    pgRest = await createPgRest<DatabasePgRest>({ db: db.adapter, schemas: ["api", "v2"] });
  });
  afterAll(async () => {
    await pgRest.close();
    await db.drop();
  });

  const authed = { role: "authenticated", claims: { sub: "u1" } };

  test("the select decides the shape of data", async () => {
    const { data } = ok(
      await pgRest.select({
        table: "orders",
        columns: ["id", "total", { clients: ["name"] }],
        where: { status: "paid" },
        order: [{ column: "total", desc: true }],
        limit: 1,
      }),
    );
    assertType<Equal<typeof data, Array<{ id: number; total: number; clients: { name: string } | null }>>>();
    expect(data).toEqual([{ id: 1, total: 250, clients: { name: "Ada" } }]);
  });

  test("aliases rename the key, and a to-many embed is an array", async () => {
    const { data } = ok(
      await pgRest.select({
        table: "clients",
        columns: ["name", "who:email", { orders: { columns: ["total"], order: ["total.desc"], limit: 1 } }],
        where: { id: 1 },
      }),
    );
    assertType<Equal<typeof data, Array<{ name: string; who: string | null; orders: Array<{ total: number }> }>>>();
    expect(data).toEqual([{ name: "Ada", who: "ada@example.com", orders: [{ total: 250 }] }]);
  });

  test("nested embeds, many-to-many, and an inner join that cannot be null", async () => {
    const { data } = ok(
      await pgRest.select({
        table: "clients",
        columns: ["name", { orders: { columns: ["id", { order_items: ["qty"] }, { products: ["name"] }] } }],
        where: { id: 1 },
      }),
    );
    assertType<
      Equal<
        typeof data,
        Array<{
          name: string;
          orders: Array<{ id: number; order_items: Array<{ qty: number }>; products: Array<{ name: string }> }>;
        }>
      >
    >();
    expect(data[0]!.orders[0]!.products).toEqual([{ name: "Keyboard" }, { name: "Mouse" }]);

    // `!inner` drops the parent rows without a match, so the embed is no longer nullable
    const inner = ok(
      await pgRest.select({
        table: "orders",
        columns: ["id", { clients: { columns: ["name"], inner: true } }],
        where: { id: 1 },
      }),
    );
    assertType<Equal<typeof inner.data, Array<{ id: number; clients: { name: string } }>>>();
    expect(inner.data).toEqual([{ id: 1, clients: { name: "Ada" } }]);
  });

  test("an embedded resource can also be filtered by its dotted path", async () => {
    const { data } = ok(
      await pgRest.select({
        table: "clients",
        columns: ["name", { orders: ["total"] }],
        where: { "orders.status": "paid" },
        order: ["id"],
      }),
    );
    assertType<Equal<typeof data, Array<{ name: string; orders: Array<{ total: number }> }>>>();
    expect(data).toEqual([
      { name: "Ada", orders: [{ total: 250 }] },
      { name: "Linus", orders: [{ total: 99.99 }] },
      { name: "Grace", orders: [] },
    ]);
    // the operator forms work there too
    const tuple = ok(
      await pgRest.select({
        table: "clients",
        columns: ["name", { orders: ["total"] }],
        where: { "orders.total": { $gte: 200 } },
        order: ["id"],
      }),
    );
    expect(tuple.data[0]!.orders).toEqual([{ total: 250 }]);
  });

  test("an embed can be renamed, and the type follows the alias", async () => {
    const { data } = ok(
      await pgRest.select({
        table: "orders",
        columns: ["id", { clients: { as: "who", columns: ["name"] } }],
        where: { id: 1 },
      }),
    );
    assertType<Equal<typeof data, Array<{ id: number; who: { name: string } | null }>>>();
    expect(data).toEqual([{ id: 1, who: { name: "Ada" } }]);
  });

  test("a spread embed joins the parent row, and a to-many spread arrives in arrays", async () => {
    const one = ok(
      await pgRest.select({
        table: "orders",
        columns: ["id", { clients: { columns: ["name"], spread: true } }],
        where: { id: 1 },
      }),
    );
    assertType<Equal<typeof one.data, Array<{ id: number; name: string }>>>();
    expect(one.data).toEqual([{ id: 1, name: "Ada" }]);

    const many = ok(
      await pgRest.select({
        table: "clients",
        columns: ["name", { orders: { columns: ["t:total", "status"], spread: true } }],
        where: { id: 1 },
      }),
    );
    assertType<Equal<typeof many.data, Array<{ name: string; t: number[]; status: string[] }>>>();
    expect(many.data).toEqual([{ name: "Ada", t: [250, 40.5], status: ["paid", "new"] }]);
  });

  test("single gives one row, and no select gives the whole row", async () => {
    const one = ok(await pgRest.select({ table: "clients", columns: ["id"], where: { id: 1 }, single: true }));
    assertType<Equal<typeof one.data, { id: number }>>();
    expect(one.data).toEqual({ id: 1 });

    const whole = ok(await pgRest.select({ table: "profiles", where: { client_id: 1 } }));
    assertType<Equal<typeof whole.data, Array<{ client_id: number; bio: string | null }>>>();
    expect(whole.data).toEqual([{ client_id: 1, bio: "First programmer" }]);
  });

  test("enums are unions, both in the row and in a filter", async () => {
    const { data } = ok(
      await pgRest.select({
        table: "moods",
        columns: ["mood", "seen"],
        where: { mood: "happy" },
      }),
    );
    assertType<
      Equal<typeof data, Array<{ mood: "sad" | "ok" | "happy"; seen: Array<"sad" | "ok" | "happy"> | null }>>
    >();
    expect(data).toEqual([{ mood: "happy", seen: ["ok", "happy"] }]);
  });

  test("a composite column is its fields, and a value written or compared may leave them out", async () => {
    const { data } = ok(
      await pgRest.select({
        table: "venues",
        columns: ["label", "owner", "branches"],
        where: { owner: { name: "Ada", home: { city: "Paris", zip: "75001" }, tags: ["music", "large"] } },
        single: true,
      }),
    );
    type Address = { city: string | null; zip: string | null };
    assertType<
      Equal<
        typeof data,
        {
          label: string;
          owner: { name: string | null; home: Address | null; tags: string[] | null } | null;
          branches: Address[] | null;
        }
      >
    >();
    expect(data.owner?.home?.city).toBe("Paris");

    // a partial value is legal: the fields left out are compared against, or written as, NULL
    const partial = ok(await pgRest.select({ table: "venues", columns: ["id"], where: { owner: { name: "Ada" } } }));
    expect(partial.data).toEqual([]);

    const written = ok(
      await pgRest.insert(
        {
          table: "venues",
          rows: { label: "Typed hall", owner: { name: "Barbara", home: { city: "Brussels" } } },
          returning: ["owner"],
          single: true,
        },
        authed,
      ),
    );
    expect(written.data.owner).toEqual({ name: "Barbara", home: { city: "Brussels", zip: null }, tags: null });
    await pgRest.delete({ table: "venues", where: { label: "Typed hall" } }, authed);

    // a function taking one, and one returning one
    const city = ok(await pgRest.rpc({ rpc: "city_of", args: { who: { home: { city: "Delft" } } } }));
    assertType<Equal<typeof city.data, string>>();
    expect(city.data).toBe("Delft");
    const made = ok(await pgRest.rpc({ rpc: "make_address", args: { city: "Lyon", zip: "69001" } }));
    assertType<Equal<typeof made.data, Address>>();
    expect(made.data).toEqual({ city: "Lyon", zip: "69001" });
  });

  test("writes take the insert and update shapes", async () => {
    const inserted = ok(
      await pgRest.insert({ table: "clients", rows: { name: "Typed" }, returning: ["id", "name"] }, authed),
    );
    assertType<Equal<typeof inserted.data, Array<{ id: number; name: string }>>>();
    expect(inserted.data[0]!.name).toBe("Typed");

    const quiet = ok(
      await pgRest.update(
        {
          table: "clients",
          set: { name: "Quiet" },
          where: { id: inserted.data[0]!.id },
          returning: "minimal",
        },
        authed,
      ),
    );
    assertType<Equal<typeof quiet.data, null>>();
    expect(quiet.data).toBeNull();

    const deleted = ok(
      await pgRest.delete({ table: "clients", where: { id: inserted.data[0]!.id }, returning: ["id"] }, authed),
    );
    assertType<Equal<typeof deleted.data, Array<{ id: number }>>>();
    expect(deleted.data).toHaveLength(1);
  });

  test("an insert's columns are what it inserts, and its returning is what it answers with", async () => {
    // `columns` keeps the extra key out of the statement; it says nothing about the shape of `data`
    const inserted = ok(
      await pgRest.insert(
        {
          table: "clients",
          rows: { name: "Narrow" },
          columns: ["name"],
          returning: ["id"],
        },
        authed,
      ),
    );
    assertType<Equal<typeof inserted.data, Array<{ id: number }>>>();

    const everything = ok(await pgRest.insert({ table: "clients", rows: { name: "Wide" }, columns: ["name"] }, authed));
    assertType<Equal<(typeof everything.data)[number]["id"], number>>();
    assertType<Equal<(typeof everything.data)[number]["name"], string>>();

    const same = ok(
      await pgRest.update(
        { table: "clients", set: { name: "Same" }, where: { id: inserted.data[0]!.id }, returning: "representation" },
        authed,
      ),
    );
    assertType<Equal<(typeof same.data)[number]["name"], string>>();
    await pgRest.delete({ table: "clients", where: { name: { $like: "Same" } }, returning: "minimal" }, authed);

    // @ts-expect-error only a read has columns; a write's list is its returning
    void (() => pgRest.delete({ table: "clients", columns: ["id"] }));
    // @ts-expect-error only an insert has columns
    void (() => pgRest.update({ table: "clients", set: { name: "x" }, columns: ["name"] }));
    // @ts-expect-error `select` is not a key any more
    void (() => pgRest.select({ table: "clients", select: ["id"] }));
    // @ts-expect-error a returning list names real columns
    void (() => pgRest.insert({ table: "clients", rows: { name: "x" }, returning: ["nope"] }));
  });

  test("rpc: the arguments and the result come from the function", async () => {
    const sum = ok(await pgRest.rpc({ rpc: "add", args: { a: 2, b: 3 } }));
    assertType<Equal<typeof sum.data, number>>();
    expect(sum.data).toBe(5);

    const greeting = ok(await pgRest.rpc({ rpc: "greet" }));
    assertType<Equal<typeof greeting.data, string>>();
    expect(greeting.data).toBe("hello world");

    const mood = ok(await pgRest.rpc({ rpc: "cheer_up", args: { m: "sad" } }));
    assertType<Equal<typeof mood.data, "sad" | "ok" | "happy">>();
    expect(mood.data).toBe("ok");
  });

  test("a set-returning function answers with rows, narrowed by its select", async () => {
    const { data, count } = ok(
      await pgRest.rpc({
        rpc: "orders_by_status",
        args: { s: "paid" },
        columns: ["total"],
        order: ["total.desc"],
        count: "exact",
      }),
    );
    assertType<Equal<typeof data, Array<{ total: number }>>>();
    assertType<Equal<typeof count, number>>();
    expect(data).toEqual([{ total: 250 }, { total: 99.99 }]);

    // void is null, and a function returning a table row gives that row
    const nothing = ok(await pgRest.rpc({ rpc: "nothing" }, authed));
    assertType<Equal<typeof nothing.data, null>>();
    const first = ok(await pgRest.rpc({ rpc: "first_client", columns: ["name"] }));
    assertType<Equal<typeof first.data, { name: string }>>();
    expect(first.data).toEqual({ name: "Ada" });
  });

  test("the count asked for decides the type of count", async () => {
    // no count asked for: nothing to read, and the type says so
    const none = ok(await pgRest.select({ table: "orders", columns: ["id"], order: ["id"] }));
    assertType<Equal<typeof none.count, undefined>>();
    expect(none.count).toBeUndefined();

    // "exact" always answers with a number, paged or not
    const exact = ok(
      await pgRest.select({ table: "orders", columns: ["id"], order: ["id"], limit: 1, count: "exact" }),
    );
    assertType<Equal<typeof exact.count, number>>();
    expect(exact.count).toBe(4);
    const unpaged = ok(await pgRest.select({ table: "orders", columns: ["id"], order: ["id"], count: "exact" }));
    assertType<Equal<typeof unpaged.count, number>>();
    expect(unpaged.count).toBe(4);

    // "estimated" falls back to the page's own length, so it is a number too
    const estimated = ok(await pgRest.select({ table: "orders", columns: ["id"], order: ["id"], count: "estimated" }));
    assertType<Equal<typeof estimated.count, number>>();
    expect(typeof estimated.count).toBe("number");

    // "planned" reads an EXPLAIN, which may give nothing usable
    const planned = ok(await pgRest.select({ table: "orders", columns: ["id"], order: ["id"], count: "planned" }));
    assertType<Equal<typeof planned.count, number | undefined>>();

    // all four of those are the narrowed half: before `if (error)`, the failed half has no count
    const either = await pgRest.select({ table: "orders", columns: ["id"], order: ["id"], count: "exact" });
    assertType<Equal<typeof either.count, number | undefined>>();
    if (either.error) {
      assertType<Equal<typeof either.count, undefined>>();
    } else {
      assertType<Equal<typeof either.count, number>>();
      expect(either.count).toBe(4);
    }
  });

  test("another schema has to name itself", async () => {
    const { data } = ok(await pgRest.select({ schema: "v2", table: "things", columns: ["label"], order: ["id"] }));
    assertType<Equal<typeof data, Array<{ label: string }>>>();
    expect(data).toEqual([{ label: "one" }, { label: "two" }]);
  });

  test("the error is part of the result, and narrowing it keeps the inference", async () => {
    const { data, error } = await pgRest.select({ table: "clients", columns: ["name"], where: { id: 1 } });
    // before the check, `data` carries the failed half's null
    assertType<Equal<typeof data, Array<{ name: string }> | null>>();
    if (error) throw error;
    assertType<Equal<typeof data, Array<{ name: string }>>>();
    expect(data).toEqual([{ name: "Ada" }]);

    // 0 rows with `single` is `not_single_row`, and the failed half is what comes back
    const failed = await pgRest.select({ table: "clients", columns: ["name"], where: { id: 999 }, single: true });
    if (!failed.error) throw new Error("expected a failure");
    assertType<Equal<typeof failed.data, null>>();
    assertType<Equal<typeof failed.count, undefined>>();
  });

  test("handle() is untouched: a request is a string from outside", async () => {
    const res = await pgRest.handle(new Request("http://localhost/clients?select=name&id=eq.1"));
    expect(await res.json()).toEqual([{ name: "Ada" }]);
  });

  /**
   * The generated types describe the *schema*, not the caller: `insertable` and friends come from
   * `pg_relation_is_updatable`, which is structural (an aggregate view can never be written), and
   * say nothing about GRANTs. A role is chosen per call, usually from a cookie, so the compiler
   * cannot see it -- and row level security is a predicate, which no type can express. Privileges
   * are enforced where they have to be.
   */
  test("the types do not know the role: that stays the database's job", async () => {
    // this compiles: `clients` is a writable table, and nothing in the type mentions `anon`
    const denied = await pgRest.insert({ table: "clients", rows: { name: "x" } });
    expect(denied.error?.kind).toBe("unauthenticated");
    expect(denied.error?.sqlState).toBe("42501"); // insufficient_privilege, straight from Postgres
    // the same call as a role that was granted the write succeeds
    const allowed = await pgRest.insert({ table: "clients", rows: { name: "x" } }, authed);
    expect(allowed.error).toBeNull();
    // and RLS keeps filtering rows the types know nothing about
    const as = (sub: string) => ({ role: "authenticated", claims: { sub } });
    ok(await pgRest.insert({ table: "notes", rows: { body: "alice only" } }, as("alice")));
    expect(ok(await pgRest.select({ table: "notes", columns: ["body"] }, as("alice"))).data).toEqual([
      { body: "alice only" },
    ]);
    expect(ok(await pgRest.select({ table: "notes", columns: ["body"] }, as("bob"))).data).toEqual([]);
  });

  test("what the types refuse", () => {
    // @ts-expect-error the table does not exist
    void (() => pgRest.select({ table: "cients", columns: ["id"] }));
    // @ts-expect-error the column does not exist
    void (() => pgRest.select({ table: "clients", columns: ["nope"] }));
    // @ts-expect-error there is no such relationship (the error lists the ones there are)
    void (() => pgRest.select({ table: "clients", columns: [{ nope: ["id"] }] }));
    // @ts-expect-error clients and products have no junction table between them
    void (() => pgRest.select({ table: "clients", columns: [{ products: ["name"] }] }));
    // @ts-expect-error the embedded column does not exist
    void (() => pgRest.select({ table: "clients", columns: [{ orders: ["nope"] }] }));
    // a JSON path in a filter is accepted on a real column ...
    void (() => pgRest.select({ table: "clients", columns: ["id"], where: { "meta->>tier": { $ilike: "go*" } } }));
    // @ts-expect-error ... and only on a real column
    void (() => pgRest.select({ table: "clients", columns: ["id"], where: { "nope->>tier": "gold" } }));
    // @ts-expect-error a filter value has to match the column
    void (() => pgRest.select({ table: "clients", where: { id: "one" } }));
    // @ts-expect-error an enum only takes its labels
    void (() => pgRest.select({ table: "moods", where: { mood: "elated" } }));
    // @ts-expect-error an unknown key inside `where` would reach the database as a 42703
    void (() => pgRest.select({ table: "clients", columns: ["id"], where: { titel: "Ada" } }));
    // @ts-expect-error `as` and `spread` cannot both be written: `...alias:table(*)` does not parse
    void (() => pgRest.select({ table: "orders", columns: [{ clients: { spread: true, as: "who" } }] }));
    // @ts-expect-error a JSON path is still refused in a select
    void (() => pgRest.select({ table: "clients", columns: ["tier:meta->>tier"] }));
    // an update may set a column to an expression or to DEFAULT ...
    void (() =>
      pgRest.update({
        table: "orders",
        set: { total: { $add: [{ $col: "total" }, 1] }, status: { $default: true } },
      }));
    // ... and the expression has to give the column's type
    void (() =>
      pgRest.update({
        table: "orders",
        set: {
          total: { $round: [{ $mul: [{ $col: "total" }, 1.1] }, 2] },
          status: { $lower: { $concat: [{ $col: "status" }, "!"] } },
          placed_at: { $now: true },
        },
      }));
    void (() =>
      pgRest.update({
        table: "clients",
        set: { tags: { $arrayAppend: [{ $coalesce: [{ $col: "tags" }, { $val: [] }] }, "vip"] } },
      }));
    void (() =>
      pgRest.update({
        table: "orders",
        // @ts-expect-error a text operator does not give a number
        set: { total: { $lower: { $col: "status" } } },
      }));
    void (() =>
      pgRest.update({
        table: "orders",
        // @ts-expect-error `$col` of a number column cannot be a text one
        set: { total: { $add: [{ $col: "status" }, 1] } },
      }));
    void (() =>
      pgRest.update({
        table: "orders",
        // @ts-expect-error a number is not text
        set: { status: { $add: [1, 2] } },
      }));
    void (() =>
      pgRest.update({
        table: "clients",
        // @ts-expect-error an array takes `$arrayAppend`, not `$upper`
        set: { tags: { $upper: { $col: "name" } } },
      }));
    void (() =>
      pgRest.update({
        table: "orders",
        // @ts-expect-error ... but only on the columns of the relation
        set: { nope: { $add: [1, 2] } },
      }));
    void (() =>
      pgRest.update({
        table: "orders",
        // @ts-expect-error an unknown key in set is still refused
        set: { titel: "x" },
      }));
    // @ts-expect-error order only takes real columns
    void (() => pgRest.select({ table: "clients", order: ["nope.desc"] }));
    // @ts-expect-error an aggregate view cannot be written to (insert: never)
    void (() => pgRest.insert({ table: "client_totals", rows: { client_id: 1 } }));
    // @ts-expect-error `name` has no default and is NOT NULL
    void (() => pgRest.insert({ table: "clients", rows: {} }));
    // @ts-expect-error a table of another schema needs `schema`
    void (() => pgRest.select({ table: "things", columns: ["label"] }));
    // @ts-expect-error the function does not exist
    void (() => pgRest.rpc({ rpc: "nope" }));
    // @ts-expect-error the argument is an integer
    void (() => pgRest.rpc({ rpc: "add", args: { a: "two", b: 3 } }));
    // @ts-expect-error a scalar function has no columns to select
    void (() => pgRest.rpc({ rpc: "hello", columns: ["anything"] }));
    // @ts-expect-error a field that is in no query is dropped in silence at runtime, so it is refused here
    void (() => pgRest.select({ table: "clients", columns: ["id"], limitt: 10 }));
    // @ts-expect-error the payload is checked the same way: no such column
    void (() => pgRest.insert({ table: "clients", rows: { name: "x", nope: 1 } }));
    // @ts-expect-error ... in a bulk insert too
    void (() => pgRest.insert({ table: "clients", rows: [{ name: "x" }, { name: "y", nope: 1 }] }));
    // @ts-expect-error ... and in an update
    void (() => pgRest.update({ table: "clients", set: { nope: 1 } }));
    // reads and writes share one member per table, so what the shape no longer says is checked
    // by WriteRules: each action's payload is required, and refused on the others
    // @ts-expect-error an insert needs its rows
    void (() => pgRest.insert({ table: "clients" }));
    // @ts-expect-error an update needs its set
    void (() => pgRest.update({ table: "clients" }));
    // @ts-expect-error a read has no rows
    void (() => pgRest.select({ table: "clients", rows: { name: "x" } }));
    // @ts-expect-error an insert has no set
    void (() => pgRest.insert({ table: "clients", rows: { name: "x" }, set: { name: "y" } }));
    // @ts-expect-error on_conflict belongs to an upsert
    void (() => pgRest.select({ table: "clients", onConflict: ["id"] }));
    // @ts-expect-error there is nothing to return from a read
    void (() => pgRest.select({ table: "clients", columns: ["id"], returning: "minimal" }));
    // @ts-expect-error a query names a table or a function, not both
    void (() => pgRest.rpc({ table: "clients", rpc: "add" }));
    // @ts-expect-error a field of a composite type is checked like any other value
    void (() => pgRest.select({ table: "venues", where: { owner: { name: 42 } } }));
    // @ts-expect-error ... and a field the composite type does not have is refused
    void (() => pgRest.insert({ table: "venues", rows: { label: "x", owner: { nope: "y" } } }));
    // @ts-expect-error an identity column cannot be written (the fixture's moods.id is one)
    void (() => pgRest.insert({ table: "moods", rows: { id: 42, mood: "ok" } }));
    // the string forms that change or invent a column are not described by the types: a cast, a
    // JSON path and an aggregate all need an untyped instance
    // @ts-expect-error
    void (() => pgRest.select({ table: "orders", columns: ["total::text"] }));
    // @ts-expect-error
    void (() => pgRest.select({ table: "clients", columns: ["meta->>tier"] }));
    // @ts-expect-error
    void (() => pgRest.select({ table: "orders", columns: ["total.sum()"] }));
    expect(true).toBe(true);
  });

  test("a transaction scope is typed like the instance, minus the context", async () => {
    const { data } = ok(
      await pgRest.transaction(async (tx) => {
        // no `ok()` and no narrowing: `tx.query` rejects on failure, so its result is the success
        const client = await tx.insert({ table: "clients", rows: { name: "Tx" }, single: true });
        assertType<
          Equal<
            typeof client.data,
            { id: number; name: string; email: string | null; meta: unknown; tags: string[] | null; created_at: string }
          >
        >();
        assertType<Equal<typeof client.error, null>>();

        const order = await tx.insert({
          table: "orders",
          rows: { client_id: client.data.id, total: 5 },
          returning: ["id", { clients: ["name"] }],
        });
        assertType<Equal<typeof order.data, Array<{ id: number; clients: { name: string } | null }>>>();

        // the count a query asked for is a number, not a maybe
        const counted = await tx.select({ table: "clients", columns: ["id"], count: "exact" });
        assertType<Equal<typeof counted.count, number>>();

        return order.data[0]!.clients?.name;
      }, authed),
    );
    assertType<Equal<typeof data, string | undefined>>();
    expect(data).toBe("Tx");

    // the scope's value is the data, and there is never a count
    const scope = ok(await pgRest.transaction(async () => 1, authed));
    assertType<Equal<typeof scope.count, undefined>>();

    // a nested scope answers a result, because a savepoint is where a failure is recoverable
    const nested = ok(await pgRest.transaction(async (tx) => tx.transaction(async () => "inner"), authed));
    assertType<Equal<typeof nested.data.data, string | null>>();
    expect(nested.data.data).toBe("inner");

    // @ts-expect-error a query inside a scope takes no context: the transaction already has one
    void (() => pgRest.transaction(async (tx) => tx.select({ table: "clients", columns: ["id"] }, authed)));
    // @ts-expect-error and the typing of the input is the same one
    void (() => pgRest.transaction(async (tx) => tx.select({ table: "clients", columns: ["nope"] })));
    // @ts-expect-error a nested scope takes no options either
    void (() => pgRest.transaction(async (tx) => tx.transaction(async () => 1, { readOnly: true })));
  });
  test("a prepared query is checked against the database and types its result", async () => {
    const paidOver = pgRest.prepare((a: { status: string; min: number }) => ({
      table: "orders",
      columns: ["id", "total"],
      where: { status: a.status, total: { $gte: a.min } },
      order: ["id"],
      count: "exact" as const,
    }));
    const r = ok(await pgRest.run(paidOver({ status: "paid", min: 100 }), authed));
    assertType<Equal<typeof r.data, Array<{ id: number; total: number }>>>();
    assertType<Equal<typeof r.count, number>>();
    expect(r.data).toEqual([{ id: 1, total: 250 }]);
    expect(r.count).toBe(1);

    // an argument has to be the type the call is declared with
    // @ts-expect-error min is a number
    void (() => paidOver({ status: "paid", min: "100" }));
    // @ts-expect-error a prepared query is checked like any other: this column does not exist
    void (() => pgRest.prepare((a: { s: string }) => ({ table: "orders", columns: ["nope"], where: { status: a.s } })));

    const inTx = ok(
      await pgRest.transaction(async (tx) => (await tx.run(paidOver({ status: "paid", min: 0 }))).data, authed),
    );
    assertType<Equal<typeof inTx.data, Array<{ id: number; total: number }>>>();
    const viaContext = ok(await pgRest.setContextQuery(() => authed).run(paidOver({ status: "new", min: 0 })));
    // other tests of this file add orders: the fixture's own is the first
    expect(viaContext.data[0]).toEqual({ id: 2, total: 40.5 });
  });
});
