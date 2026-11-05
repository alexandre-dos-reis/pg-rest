import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createPgRest, type TypedPgRestInstance } from "../src/index";
import { createTestDb, hasDb, type TestDb } from "./support/db";
import type { DatabasePgRest } from "./support/fixture.types";

/**
 * Types are checked by `bun run typecheck`, which compiles this file; `bun test` runs the calls, so
 * one suite covers both. `@ts-expect-error` is the negative half: it fails the typecheck if the line
 * it guards ever stops being an error.
 */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const assertType = <_T extends true>(): void => {};

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
    const { data } = await pgRest.query({
      table: "orders",
      select: ["id", "total", { clients: ["name"] }],
      where: { status: "paid" },
      order: [{ column: "total", desc: true }],
      limit: 1,
    });
    assertType<Equal<typeof data, Array<{ id: number; total: number; clients: { name: string } | null }>>>();
    expect(data).toEqual([{ id: 1, total: 250, clients: { name: "Ada" } }]);
  });

  test("aliases rename the key, and a to-many embed is an array", async () => {
    const { data } = await pgRest.query({
      table: "clients",
      select: ["name", "who:email", { orders: { select: ["total"], order: ["total.desc"], limit: 1 } }],
      where: { id: 1 },
    });
    assertType<Equal<typeof data, Array<{ name: string; who: string | null; orders: Array<{ total: number }> }>>>();
    expect(data).toEqual([{ name: "Ada", who: "ada@example.com", orders: [{ total: 250 }] }]);
  });

  test("nested embeds, many-to-many, and an inner join that cannot be null", async () => {
    const { data } = await pgRest.query({
      table: "clients",
      select: ["name", { orders: { select: ["id", { order_items: ["qty"] }, { products: ["name"] }] } }],
      where: { id: 1 },
    });
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
    const inner = await pgRest.query({
      table: "orders",
      select: ["id", { clients: { select: ["name"], inner: true } }],
      where: { id: 1 },
    });
    assertType<Equal<typeof inner.data, Array<{ id: number; clients: { name: string } }>>>();
    expect(inner.data).toEqual([{ id: 1, clients: { name: "Ada" } }]);
  });

  test("an embed can be renamed, and the type follows the alias", async () => {
    const { data } = await pgRest.query({
      table: "orders",
      select: ["id", { clients: { as: "who", select: ["name"] } }],
      where: { id: 1 },
    });
    assertType<Equal<typeof data, Array<{ id: number; who: { name: string } | null }>>>();
    expect(data).toEqual([{ id: 1, who: { name: "Ada" } }]);
  });

  test("a spread embed joins the parent row, and a to-many spread arrives in arrays", async () => {
    const one = await pgRest.query({
      table: "orders",
      select: ["id", { clients: { select: ["name"], spread: true } }],
      where: { id: 1 },
    });
    assertType<Equal<typeof one.data, Array<{ id: number; name: string }>>>();
    expect(one.data).toEqual([{ id: 1, name: "Ada" }]);

    const many = await pgRest.query({
      table: "clients",
      select: ["name", { orders: { select: ["t:total", "status"], spread: true } }],
      where: { id: 1 },
    });
    assertType<Equal<typeof many.data, Array<{ name: string; t: number[]; status: string[] }>>>();
    expect(many.data).toEqual([{ name: "Ada", t: [250, 40.5], status: ["paid", "new"] }]);
  });

  test("single gives one row, and no select gives the whole row", async () => {
    const one = await pgRest.query({ table: "clients", select: ["id"], where: { id: 1 }, single: true });
    assertType<Equal<typeof one.data, { id: number }>>();
    expect(one.data).toEqual({ id: 1 });

    const whole = await pgRest.query({ table: "profiles", where: { client_id: 1 } });
    assertType<Equal<typeof whole.data, Array<{ client_id: number; bio: string | null }>>>();
    expect(whole.data).toEqual([{ client_id: 1, bio: "First programmer" }]);
  });

  test("enums are unions, both in the row and in a filter", async () => {
    const { data } = await pgRest.query({
      table: "moods",
      select: ["mood", "seen"],
      where: { mood: "happy" },
    });
    assertType<
      Equal<typeof data, Array<{ mood: "sad" | "ok" | "happy"; seen: Array<"sad" | "ok" | "happy"> | null }>>
    >();
    expect(data).toEqual([{ mood: "happy", seen: ["ok", "happy"] }]);
  });

  test("writes take the insert and update shapes", async () => {
    const inserted = await pgRest.query(
      { table: "clients", action: "insert", rows: { name: "Typed" }, select: ["id", "name"] },
      authed,
    );
    assertType<Equal<typeof inserted.data, Array<{ id: number; name: string }>>>();
    expect(inserted.data[0]!.name).toBe("Typed");

    const quiet = await pgRest.query(
      {
        table: "clients",
        action: "update",
        set: { name: "Quiet" },
        where: { id: inserted.data[0]!.id },
        returning: "minimal",
      },
      authed,
    );
    assertType<Equal<typeof quiet.data, null>>();
    expect(quiet.data).toBeNull();

    const deleted = await pgRest.query(
      { table: "clients", action: "delete", where: { id: inserted.data[0]!.id }, select: ["id"] },
      authed,
    );
    assertType<Equal<typeof deleted.data, Array<{ id: number }>>>();
    expect(deleted.data).toHaveLength(1);
  });

  test("rpc: the arguments and the result come from the function", async () => {
    const sum = await pgRest.query({ rpc: "add", args: { a: 2, b: 3 } });
    assertType<Equal<typeof sum.data, number>>();
    expect(sum.data).toBe(5);

    const greeting = await pgRest.query({ rpc: "greet" });
    assertType<Equal<typeof greeting.data, string>>();
    expect(greeting.data).toBe("hello world");

    const mood = await pgRest.query({ rpc: "cheer_up", args: { m: "sad" } });
    assertType<Equal<typeof mood.data, "sad" | "ok" | "happy">>();
    expect(mood.data).toBe("ok");
  });

  test("a set-returning function answers with rows, narrowed by its select", async () => {
    const { data, count } = await pgRest.query({
      rpc: "orders_by_status",
      args: { s: "paid" },
      select: ["total"],
      order: ["total.desc"],
      count: "exact",
    });
    assertType<Equal<typeof data, Array<{ total: number }>>>();
    assertType<Equal<typeof count, number | undefined>>();
    expect(data).toEqual([{ total: 250 }, { total: 99.99 }]);

    // void is null, and a function returning a table row gives that row
    const nothing = await pgRest.query({ rpc: "nothing" }, authed);
    assertType<Equal<typeof nothing.data, null>>();
    const first = await pgRest.query({ rpc: "first_client", select: ["name"] });
    assertType<Equal<typeof first.data, { name: string }>>();
    expect(first.data).toEqual({ name: "Ada" });
  });

  test("another schema has to name itself", async () => {
    const { data } = await pgRest.query({ schema: "v2", table: "things", select: ["label"], order: ["id"] });
    assertType<Equal<typeof data, Array<{ label: string }>>>();
    expect(data).toEqual([{ label: "one" }, { label: "two" }]);
  });

  test("querySafe keeps the inference and adds the error", async () => {
    const { data, error } = await pgRest.querySafe({ table: "clients", select: ["name"], where: { id: 1 } });
    if (error) throw error;
    assertType<Equal<typeof data, Array<{ name: string }>>>();
    expect(data).toEqual([{ name: "Ada" }]);
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
    const denied = await pgRest.querySafe({ table: "clients", action: "insert", rows: { name: "x" } });
    expect(denied.error?.status).toBe(401);
    expect(denied.error?.body.code).toBe("42501"); // insufficient_privilege, straight from Postgres
    // the same call as a role that was granted the write succeeds
    const allowed = await pgRest.querySafe({ table: "clients", action: "insert", rows: { name: "x" } }, authed);
    expect(allowed.error).toBeNull();
    // and RLS keeps filtering rows the types know nothing about
    const as = (sub: string) => ({ role: "authenticated", claims: { sub } });
    await pgRest.query({ table: "notes", action: "insert", rows: { body: "alice only" } }, as("alice"));
    expect((await pgRest.query({ table: "notes", select: ["body"] }, as("alice"))).data).toEqual([
      { body: "alice only" },
    ]);
    expect((await pgRest.query({ table: "notes", select: ["body"] }, as("bob"))).data).toEqual([]);
  });

  test("what the types refuse", () => {
    // @ts-expect-error the table does not exist
    void (() => pgRest.query({ table: "cients", select: ["id"] }));
    // @ts-expect-error the column does not exist
    void (() => pgRest.query({ table: "clients", select: ["nope"] }));
    // @ts-expect-error there is no such relationship (the error lists the ones there are)
    void (() => pgRest.query({ table: "clients", select: [{ nope: ["id"] }] }));
    // @ts-expect-error clients and products have no junction table between them
    void (() => pgRest.query({ table: "clients", select: [{ products: ["name"] }] }));
    // @ts-expect-error the embedded column does not exist
    void (() => pgRest.query({ table: "clients", select: [{ orders: ["nope"] }] }));
    // @ts-expect-error a filter value has to match the column
    void (() => pgRest.query({ table: "clients", where: { id: "one" } }));
    // @ts-expect-error an enum only takes its labels
    void (() => pgRest.query({ table: "moods", where: { mood: "elated" } }));
    // @ts-expect-error order only takes real columns
    void (() => pgRest.query({ table: "clients", order: ["nope.desc"] }));
    // @ts-expect-error an aggregate view cannot be written to (insert: never)
    void (() => pgRest.query({ table: "client_totals", action: "insert", rows: { client_id: 1 } }));
    // @ts-expect-error `name` has no default and is NOT NULL
    void (() => pgRest.query({ table: "clients", action: "insert", rows: {} }));
    // @ts-expect-error a table of another schema needs `schema`
    void (() => pgRest.query({ table: "things", select: ["label"] }));
    // @ts-expect-error the function does not exist
    void (() => pgRest.query({ rpc: "nope" }));
    // @ts-expect-error the argument is an integer
    void (() => pgRest.query({ rpc: "add", args: { a: "two", b: 3 } }));
    // @ts-expect-error a scalar function has no columns to select
    void (() => pgRest.query({ rpc: "hello", select: ["anything"] }));
    // @ts-expect-error a field that is in no query is dropped in silence at runtime, so it is refused here
    void (() => pgRest.query({ table: "clients", select: ["id"], limitt: 10 }));
    // @ts-expect-error the payload is checked the same way: no such column
    void (() => pgRest.query({ table: "clients", action: "insert", rows: { name: "x", nope: 1 } }));
    // @ts-expect-error ... in a bulk insert too
    void (() => pgRest.query({ table: "clients", action: "insert", rows: [{ name: "x" }, { name: "y", nope: 1 }] }));
    // @ts-expect-error ... and in an update
    void (() => pgRest.query({ table: "clients", action: "update", set: { nope: 1 } }));
    // reads and writes share one member per table, so what the shape no longer says is checked
    // by WriteRules: each action's payload is required, and refused on the others
    // @ts-expect-error an insert needs its rows
    void (() => pgRest.query({ table: "clients", action: "insert" }));
    // @ts-expect-error an update needs its set
    void (() => pgRest.query({ table: "clients", action: "update" }));
    // @ts-expect-error a read has no rows
    void (() => pgRest.query({ table: "clients", rows: { name: "x" } }));
    // @ts-expect-error an insert has no set
    void (() => pgRest.query({ table: "clients", action: "insert", rows: { name: "x" }, set: { name: "y" } }));
    // @ts-expect-error on_conflict belongs to an upsert
    void (() => pgRest.query({ table: "clients", onConflict: ["id"] }));
    // @ts-expect-error there is nothing to return from a read
    void (() => pgRest.query({ table: "clients", select: ["id"], returning: "minimal" }));
    // @ts-expect-error a query names a table or a function, not both
    void (() => pgRest.query({ table: "clients", rpc: "add" }));
    // @ts-expect-error an identity column cannot be written (the fixture's moods.id is one)
    void (() => pgRest.query({ table: "moods", action: "insert", rows: { id: 42, mood: "ok" } }));
    // the string forms that change or invent a column are not described by the types: a cast, a
    // JSON path and an aggregate all need an untyped instance
    // @ts-expect-error
    void (() => pgRest.query({ table: "orders", select: ["total::text"] }));
    // @ts-expect-error
    void (() => pgRest.query({ table: "clients", select: ["meta->>tier"] }));
    // @ts-expect-error
    void (() => pgRest.query({ table: "orders", select: ["total.sum()"] }));
    expect(true).toBe(true);
  });
});
