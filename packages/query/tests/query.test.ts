import { AsyncLocalStorage } from "node:async_hooks";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { QueryError, type QueryInput, type RequestContext, type SelectInput } from "../src/index";
import { createQuery } from "../src/index";
import { introspect, toDescriptor } from "../../core/src/schema";
import { exec } from "./support/exec";
import { createTestDb, hasDb } from "../../../tests/support/db";
import { authed, makeApi, type TestQuery } from "./support/api";
import {} from "../src/query";
import { toParams } from "./support/render";

/** The query string the object describes, as `handle()` would receive it. */
const qs = (input: QueryInput): string => new URLSearchParams(toParams(input) as Array<[string, string]>).toString();

describe("input -> query string", () => {
  test("select, filters, order and paging", () => {
    expect(qs({ table: "clients", columns: ["id", "name"], limit: 10 })).toBe("select=id%2Cname&limit=10");
    expect(qs({ table: "orders", where: { status: "paid", total: { $gte: 100 } } })).toBe(
      "status=eq.paid&total=gte.100",
    );
    expect(qs({ table: "clients", where: { meta: null, email: { $not: { $is: null } } } })).toBe(
      "meta=is.null&email=not.is.null",
    );
    expect(qs({ table: "orders", where: { id: { $in: [1, 2, 3] } } })).toBe("id=in.%281%2C2%2C3%29");
    expect(qs({ table: "clients", where: { tags: { $cs: ["vip", "early"] } } })).toBe("tags=cs.%7Bvip%2Cearly%7D");
    expect(qs({ table: "orders", order: [{ column: "total", desc: true, nulls: "last" }, "id"] })).toBe(
      "order=total.desc.nullslast%2Cid",
    );
  });

  test("a lone value is verbatim; a delimited one is quoted", () => {
    // packages/rest/tests/compare pins this against PostgREST: on its own, a value is taken as it is
    expect(qs({ table: "clients", where: { name: "null" } })).toBe("name=eq.null");
    expect(qs({ table: "clients", where: { name: "a,b" } })).toBe("name=eq.a%2Cb");
    expect(qs({ table: "clients", where: { email: "a.b@c.d" } })).toBe("email=eq.a.b%40c.d");
    // in a list or a logic tree, the separators have to be escaped
    expect(qs({ table: "clients", where: { name: { $in: ["a,b", "null", ""] } } })).toBe(
      "name=in.%28%22a%2Cb%22%2C%22null%22%2C%22%22%29",
    );
    expect(qs({ table: "clients", where: { $or: [{ email: "a.b@c.d" }] } })).toBe("or=%28email.eq.%22a.b%40c.d%22%29");
    expect(qs({ table: "clients", where: { $or: [{ name: 'q"z' }] } })).toBe("or=%28name.eq.%22q%5C%22z%22%29");
    // comparing with null is a NULL test, whichever form it is written in
    expect(qs({ table: "clients", where: { meta: null, email: { $not: { $eq: null } } } })).toBe(
      "meta=is.null&email=not.is.null",
    );
    expect(qs({ table: "clients", where: { meta: { $neq: null } } })).toBe("meta=not.is.null");
  });

  test("several operators on one column are ANDed, and the modifiers wrap one operator", () => {
    expect(qs({ table: "orders", where: { total: { $gte: 100, $lt: 500 } } })).toBe("total=gte.100&total=lt.500");
    expect(qs({ table: "orders", where: { status: { $not: { $in: ["paid", "shipped"] } } } })).toBe(
      "status=not.in.%28paid%2Cshipped%29",
    );
    expect(qs({ table: "clients", where: { name: { $any: { $eq: ["Ada", "Bob"] } } } })).toBe(
      "name=eq%28any%29.%7BAda%2CBob%7D",
    );
    expect(qs({ table: "clients", where: { name: { $not: { $all: { $like: ["a*"] } } } } })).toBe(
      "name=not.like%28all%29.%7Ba*%7D",
    );
    expect(qs({ table: "clients", where: { name: { $fts: { query: "ada", config: "english" } } } })).toBe(
      "name=fts%28english%29.ada",
    );
    expect(qs({ table: "clients", where: { name: { $ilike: "*@EXAMPLE.com" } } })).toBe("name=ilike.*%40EXAMPLE.com");
    // the same operator twice on one column needs $and: an object cannot repeat a key
    expect(qs({ table: "clients", where: { $and: [{ name: { $like: "A*" } }, { name: { $like: "*z" } }] } })).toBe(
      "and=%28name.like.A*%2Cname.like.*z%29",
    );
    expect(() => qs({ table: "clients", where: { name: { $any: ["Ada"] } } as never })).toThrow("wraps an operator");
    // a plain value under $not is an eq
    expect(qs({ table: "clients", where: { email: { $not: null } } })).toBe("email=not.is.null");
    expect(qs({ table: "orders", where: { status: { $not: "paid" } } })).toBe("status=not.eq.paid");
    expect(qs({ table: "orders", where: { status: { $not: { $not: "paid" } } } })).toBe("status=eq.paid");
    // $not on a column with two operators would be ambiguous
    expect(() => qs({ table: "orders", where: { total: { $not: { $gte: 1, $lt: 5 } } } })).toThrow("exactly one");
  });

  test("a $not group inverts the AND of its conditions", () => {
    expect(qs({ table: "orders", where: { $not: { status: "paid", total: { $gte: 100 } } } })).toBe(
      "not.and=%28status.eq.paid%2Ctotal.gte.100%29",
    );
    expect(qs({ table: "orders", where: { $or: [{ $not: { status: "paid" } }, { id: 4 }] } })).toBe(
      "or=%28not.and%28status.eq.paid%29%2Cid.eq.4%29",
    );
  });

  test("the former syntaxes are refused rather than read as something else", () => {
    const bad = (where: object) => () => qs({ table: "orders", where } as never);
    expect(bad({ total: ["gte", 100] })).toThrow("compared with an array");
    expect(bad({ total: { op: "gte", value: 100 } })).toThrow("former { op, value } syntax");
    expect(bad({ total: { $nope: 1 } })).toThrow("Unknown filter operator '$nope'");
    expect(bad({ total: { $gte: 1, extra: 2 } })).toThrow("mixes operators and fields");
    expect(bad({ $nope: [] })).toThrow("Unknown key '$nope'");
    expect(bad({ total: {} })).not.toThrow();
  });

  test("and/or groups nest, and several conditions in one group are ANDed", () => {
    expect(qs({ table: "orders", where: { $or: [{ status: "paid" }, { total: { $gte: 400 } }] } })).toBe(
      "or=%28status.eq.paid%2Ctotal.gte.400%29",
    );
    expect(qs({ table: "orders", where: { $or: [{ status: "new", total: { $lt: 50 } }, { id: 4 }] } })).toBe(
      "or=%28and%28status.eq.new%2Ctotal.lt.50%29%2Cid.eq.4%29",
    );
  });

  test("embeds carry their own modifiers, filters and paging", () => {
    expect(qs({ table: "clients", columns: ["name", { orders: ["total"] }] })).toBe("select=name%2Corders%28total%29");
    expect(
      qs({
        table: "clients",
        columns: [
          "name",
          { orders: { columns: ["total"], inner: true, where: { status: "paid" }, order: ["total"], limit: 1 } },
        ],
      }),
    ).toBe("select=name%2Corders%21inner%28total%29&orders.status=eq.paid&orders.order=total&orders.limit=1");
    // an alias is also the path its filters use
    expect(qs({ table: "clients", columns: [{ orders: { as: "o", columns: ["id"], where: { id: 1 } } }] })).toBe(
      "select=o%3Aorders%28id%29&o.id=eq.1",
    );
    expect(
      qs({ table: "orders", columns: [{ clients: { hint: "client_id", spread: true, columns: ["name"] } }] }),
    ).toBe("select=...clients%21client_id%28name%29");
  });

  test("a bad operator is refused before touching the database", () => {
    expect(() => qs({ table: "orders", where: { total: { $nope: 1 } as never } })).toThrow(/Unknown filter operator/);
  });
});

describe.skipIf(!hasDb)("query()", () => {
  let t: TestQuery;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  test("the $ operators and groups select the right rows", async () => {
    // orders: 1 paid 250, 2 new 40.50, 3 paid 99.99, 4 shipped 500
    const ids = async (where: object) => {
      const r = await t.api.select({ table: "orders", columns: ["id"], where, order: ["id"] } as never);
      if (r.error) throw new Error(r.error.summary);
      return (r.data as Array<{ id: number }>).map((o) => o.id);
    };
    expect(await ids({ total: { $gte: 100, $lt: 500 } })).toEqual([1]);
    expect(await ids({ $not: { status: "paid", total: { $gte: 100 } } })).toEqual([2, 3, 4]);
    expect(await ids({ $not: { $or: [{ status: "paid" }, { status: "new" }] } })).toEqual([4]);
    expect(await ids({ $or: [{ $not: { status: "paid" } }, { id: 4 }] })).toEqual([2, 4]);
    expect(await ids({ $and: [{ status: { $like: "p*" } }, { status: { $like: "*d" } }] })).toEqual([1, 3]);
    expect(await ids({ status: { $not: "paid" } })).toEqual([2, 4]);
    expect(await ids({ status: { $not: null } })).toEqual([1, 2, 3, 4]);
    expect(await ids({ status: { $any: { $like: ["p*", "n*"] } } })).toEqual([1, 2, 3]);
    expect(await ids({ status: { $fts: { query: "paid", config: "english" } } })).toEqual([1, 3]);
  });

  describe("reads", () => {
    test("the shape the question started with", async () => {
      const r = await t.api.select<Array<{ id: number }>>({ table: "orders", columns: ["id"], limit: 10 });
      expect(r.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
      expect(r.error).toBeNull();
      expect(r.count).toBeUndefined();
    });

    test("filters, order, paging and count", async () => {
      const r = await t.api.select<Array<{ total: number }>>({
        table: "orders",
        columns: ["total"],
        where: { status: "paid" },
        order: [{ column: "total", desc: true }],
        limit: 1,
        count: "exact",
      });
      expect(r.data).toEqual([{ total: 250 }]);
      expect(r.count).toBe(2);
    });

    test("single gives one object", async () => {
      const r = await t.api.select<{ name: string }>({
        table: "clients",
        columns: ["name"],
        where: { id: 1 },
        single: true,
      });
      expect(r.data).toEqual({ name: "Ada" });
    });

    test("stripNulls", async () => {
      const r = await t.api.select({ table: "clients", columns: ["name", "meta"], where: { id: 3 }, stripNulls: true });
      expect(r.data).toEqual([{ name: "Grace" }]);
    });

    test("embeds, aliases and embedded filters", async () => {
      const r = await t.api.select({
        table: "clients",
        columns: ["name", { orders: { as: "paid", columns: ["total"], where: { status: "paid" }, inner: true } }],
        order: ["id"],
      });
      expect(r.data).toEqual([
        { name: "Ada", paid: [{ total: 250 }] },
        { name: "Linus", paid: [{ total: 99.99 }] },
      ]);
    });

    test("or groups", async () => {
      const r = await t.api.select<Array<{ id: number }>>({
        table: "orders",
        columns: ["id"],
        where: { $or: [{ status: "new" }, { total: { $gte: 400 } }] },
        order: ["id"],
      });
      expect(r.data).toEqual([{ id: 2 }, { id: 4 }]);
    });

    test("another exposed schema", async () => {
      const r = await t.api.select({ table: "things", schema: "v2", columns: ["label"], order: ["id"] });
      expect(r.data).toEqual([{ label: "one" }, { label: "two" }]);
    });
  });

  describe("writes", () => {
    test("insert returns its rows, unlike HTTP, and returning: minimal restores that", async () => {
      // one object in, one object out; `rows` says the cardinality, so `single` has nothing to add
      const inserted = await t.api.insert<{ id: number; name: string }>(
        { table: "clients", rows: { name: "Hopper" }, returning: ["id", "name"] },
        authed(),
      );
      expect(inserted.data).toEqual({ id: expect.any(Number), name: "Hopper" });
      expect(inserted.error).toBeNull();

      const bulk = await t.api.insert<Array<{ name: string }>>(
        { table: "clients", rows: [{ name: "Lovelace" }, { name: "Babbage" }], returning: ["name"] },
        authed(),
      );
      expect(bulk.data).toEqual([{ name: "Lovelace" }, { name: "Babbage" }]);

      const listed = await t.api.insert<Array<{ name: string }>>(
        { table: "clients", rows: [{ name: "Alone" }], returning: ["name"] },
        authed(),
      );
      expect(listed.data).toEqual([{ name: "Alone" }]);

      const asked = await t.api.insert<Array<{ name: string }>>(
        { table: "clients", rows: { name: "Listed" }, returning: ["name"], single: false },
        authed(),
      );
      expect(asked.data).toEqual([{ name: "Listed" }]);

      const quiet = await t.api.insert({ table: "clients", rows: { name: "Quiet" }, returning: "minimal" }, authed());
      expect(quiet.data).toBeNull();
      expect(quiet.error).toBeNull();
    });

    test("upsert, update and delete", async () => {
      await t.api.insert({ table: "products", rows: { id: 90, name: "Pad", price: 5 } }, authed());
      const up = await t.api.upsert<{ name: string }>(
        {
          table: "products",
          rows: { id: 90, name: "Pad mk2", price: 6 },
          onConflict: ["id"],
          returning: ["name"],
        },
        authed(),
      );
      expect(up.data).toEqual({ name: "Pad mk2" });

      const patched = await t.api.update<Array<{ price: number }>>(
        { table: "products", set: { price: 7 }, where: { id: 90 }, returning: ["price"] },
        authed(),
      );
      expect(patched.data).toEqual([{ price: 7 }]);

      const deleted = await t.api.delete<Array<{ id: number }>>(
        { table: "products", where: { id: 90 }, returning: ["id"] },
        authed(),
      );
      expect(deleted.data).toEqual([{ id: 90 }]);
      expect((await t.api.select({ table: "products", where: { id: 90 } })).data).toEqual([]);
    });

    test("an insert of one object whose row never arrives is not_single_row", async () => {
      // the shape comes from `rows`, so a trigger that skips the row leaves the object unsatisfied --
      // the one case where inferring the shape turns an empty answer into an error
      const own = await makeApi();
      try {
        await own.db.adapter.query(`
          CREATE FUNCTION api.skip() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
          CREATE TABLE api.skipped (id serial PRIMARY KEY, name text);
          CREATE TRIGGER skip_it BEFORE INSERT ON api.skipped FOR EACH ROW EXECUTE FUNCTION api.skip();
          GRANT ALL ON api.skipped TO authenticated;
          GRANT USAGE ON SEQUENCE api.skipped_id_seq TO authenticated;
        `);
        await own.reloadSchema();

        const one = await own.api.insert({ table: "skipped", rows: { name: "x" } }, authed());
        expect(one.error?.kind).toBe("not_single_row");

        // an array asked for a list, and an empty list is an answer
        const many = await own.api.insert({ table: "skipped", rows: [{ name: "x" }] }, authed());
        expect(many.error).toBeNull();
        expect(many.data).toEqual([]);

        // so is `single: false` on the object form
        const asked = await own.api.insert({ table: "skipped", rows: { name: "x" }, single: false }, authed());
        expect(asked.error).toBeNull();
        expect(asked.data).toEqual([]);
      } finally {
        await own.close();
      }
    });

    test("maxAffected refuses a too wide update", async () => {
      const { error } = await t.api.update({ table: "orders", set: { status: "x" }, maxAffected: 1 }, authed());
      expect(error?.kind).toBe("too_many_affected");
      expect(
        (
          await t.api.select<Array<{ status: string }>>({
            table: "orders",
            columns: ["status"],
            where: { status: "x" },
          })
        ).data,
      ).toEqual([]);
    });
  });

  describe("rpc", () => {
    test("scalar, set-returning with a select, and void", async () => {
      expect((await t.api.rpc({ name: "add", args: { a: 2, b: 3 } })).data).toBe(5);
      expect((await t.api.rpc({ name: "hello" })).data).toBe("hello");
      const rows = await t.api.rpc({
        name: "orders_by_status",
        args: { s: "paid" },
        columns: ["total"],
        order: [{ column: "total", desc: true }],
      });
      expect(rows.data).toEqual([{ total: 250 }, { total: 99.99 }]);
      expect((await t.api.rpc({ name: "nothing" }, authed())).data).toBeNull();
    });

    test("the function sees no request.* settings: there is no request", async () => {
      const r = await t.api.rpc<{ method: string | null; path: string | null; header: string | null }>({
        name: "req_info",
        single: true,
      });
      if (r.error) throw r.error;
      expect(r.data.method).toBeNull();
      expect(r.data.path).toBeNull();
      expect(r.data.header).toBeNull();
    });
  });

  describe("the caller", () => {
    test("the role and claims reach RLS, exactly like handle()", async () => {
      await t.api.insert({ table: "notes", rows: { body: "mine" } }, authed("alice"));
      expect(
        (await t.api.select<Array<{ body: string }>>({ table: "notes", columns: ["body"] }, authed("alice"))).data,
      ).toEqual([{ body: "mine" }]);
      expect((await t.api.select({ table: "notes", columns: ["body"] }, authed("bob"))).data).toEqual([]);
    });

    test("extra settings are applied", async () => {
      const r = await t.api.rpc<{ tenant: string }>(
        { name: "whoami", single: true },
        { role: "authenticated", claims: { sub: "u" }, settings: { "app.tenant": "acme" } },
      );
      if (r.error) throw r.error;
      expect(r.data.tenant).toBe("acme");
    });
  });

  describe("errors", () => {
    test("the error is a QueryError carrying the reason and the input", async () => {
      const input: QueryInput = { table: "cients", columns: ["id"] };
      const { data, count, error: e } = await exec(t.api, input);
      expect(data).toBeNull();
      expect(count).toBeUndefined();
      expect(e).toBeInstanceOf(QueryError);
      expect(e).toBeInstanceOf(Error);
      expect(e!.kind).toBe("undefined_object");
      expect(e!.message).toBe("Could not find the table 'api.cients' in the schema cache");
      expect(e!.details).toBeNull();
      expect(e!.hint).toBe("Perhaps you meant the table 'api.clients'");
      // not a database error, so there is no SQLSTATE
      expect(e!.sqlState).toBeUndefined();
      expect(e!.input).toEqual({ ...input, action: "select" });
      // `summary` is the same failure written out -- the call it came from, the reason, the kind
      expect(e!.summary).toBe(
        [
          `select on "cients" failed: Could not find the table 'api.cients' in the schema cache`,
          "  hint: Perhaps you meant the table 'api.clients'",
          "  kind: undefined_object -- no such table, view or function",
        ].join("\n"),
      );
    });

    test("every failure also carries a kind, the union a program switches on", async () => {
      const kindOf = async (input: QueryInput, ctx?: RequestContext) => (await exec(t.api, input, ctx)).error?.kind;

      // the query object itself
      expect(await kindOf({ table: "orders", where: { total: { $nope: 1 } as never } })).toBe("invalid_query");
      expect(await kindOf({ table: "clients", columns: ["name"], where: { "orders.total": { $gte: 1 } } })).toBe(
        "invalid_query",
      );
      // the schema cache
      expect(await kindOf({ table: "cients" })).toBe("undefined_object");
      expect(await kindOf({ name: "nope" })).toBe("undefined_object");
      expect(await kindOf({ table: "clients", action: "insert", rows: { nope: 1 } }, authed())).toBe("invalid_payload");
      // the response shaping
      expect(await kindOf({ table: "clients", where: { id: 999 }, single: true })).toBe("not_single_row");
      expect(
        await kindOf({ table: "orders", action: "update", set: { status: "paid" }, maxAffected: 0 }, authed()),
      ).toBe("too_many_affected");
      // Postgres
      expect(await kindOf({ table: "clients", action: "delete", where: { id: 1 } })).toBe("unauthenticated");
      expect(
        await kindOf({ table: "clients", action: "insert", rows: { name: "dup", email: "ada@example.com" } }, authed()),
      ).toBe("conflict");
      expect(await kindOf({ name: "boom" }, authed())).toBe("raised");
    });

    test("the kind of an error the library cannot map, and of a missing context", async () => {
      const closed = await makeApi({ anonymousRole: false });
      expect((await closed.api.select({ table: "clients" })).error?.kind).toBe("unauthenticated");
      expect((await closed.api.setContextQuery(() => undefined).select({ table: "clients" })).error?.kind).toBe(
        "no_context",
      );
      await closed.close();
    });

    test("permissions and database errors keep the SQLSTATE", async () => {
      const denied = await t.api.insert({ table: "clients", rows: { name: "x" } });
      // nobody is authenticated here, so what is missing is a login more than a privilege
      expect(denied.error?.kind).toBe("unauthenticated");
      expect(denied.error?.sqlState).toBe("42501");

      const dup = await t.api.insert({ table: "clients", rows: { name: "dup", email: "ada@example.com" } }, authed());
      expect(dup.error?.kind).toBe("conflict");
      expect(dup.error?.sqlState).toBe("23505");

      const raised = await t.api.rpc({ name: "boom" }, authed());
      expect(raised.error).toMatchObject({
        kind: "raised",
        message: "teapot",
        details: "tip me over",
        hint: "short and stout",
      });
    });

    test("single with the wrong number of rows, and an undeclared embed", async () => {
      const none = await t.api.select({ table: "clients", where: { id: 999 }, single: true });
      expect(none.error?.kind).toBe("not_single_row");

      const embed = await t.api.select({ table: "clients", columns: ["name"], where: { "orders.total": { $gte: 1 } } });
      expect(embed.error?.kind).toBe("invalid_query");
    });

    test("anonymous access can be disabled", async () => {
      const closed = await makeApi({ anonymousRole: false });
      const { error } = await closed.api.select({ table: "clients" });
      expect(error?.kind).toBe("unauthenticated");
      await closed.close();
    });
  });

  describe("the result carries the failure", () => {
    test("a success is error: null, a failure is data: null", async () => {
      const okq = await t.api.select<Array<{ id: number }>>({
        table: "orders",
        columns: ["id"],
        limit: 2,
        order: ["id"],
        count: "exact",
      });
      expect(okq).toEqual({ data: [{ id: 1 }, { id: 2 }], count: 4, error: null });

      const input: QueryInput = { table: "cients" };
      const bad = await exec(t.api, input);
      expect(bad.data).toBeNull();
      expect(bad.count).toBeUndefined();
      expect(bad.error).toBeInstanceOf(QueryError);
      expect(bad.error?.input).toEqual({ ...input, action: "select" });
    });

    test("narrowing on error leaves data usable", async () => {
      const r = await t.api.select<Array<{ name: string }>>({ table: "clients", columns: ["name"], where: { id: 1 } });
      if (r.error) throw r.error;
      // a type error here would fail the typecheck, which is half the point of the shape
      const names: string[] = r.data.map((row) => row.name);
      expect(names).toEqual(["Ada"]);
    });

    test("every kind of failure comes back as error, never as a rejection", async () => {
      // refused by the builder, before any SQL
      const operator = await t.api.select({ table: "orders", where: { total: { $nope: 1 } as never } });
      expect(operator.error?.kind).toBe("invalid_query");
      // refused by the schema
      expect((await t.api.select({ table: "clients", columns: ["nope"] })).error?.kind).toBe("undefined_object");
      // refused by Postgres (privileges), and by the response shaping
      expect((await t.api.delete({ table: "clients", where: { id: 1 } })).error?.sqlState).toBe("42501");
      expect((await t.api.select({ table: "clients", where: { id: 999 }, single: true })).error?.kind).toBe(
        "not_single_row",
      );
      // and the caller check that happens before anything else
      const closed = await makeApi({ anonymousRole: false });
      expect((await closed.api.select({ table: "clients" })).error?.kind).toBe("unauthenticated");
      await closed.close();
    });

    test("it never rejects, not even on an error the library cannot map", async () => {
      const db = await createTestDb();
      let broken = false;
      // a driver that fails with something that is not even an Error, after the schema was read
      const api = createQuery({
        db: {
          query: (text, params) => db.adapter.query(text, params),
          transaction: (fn) => (broken ? Promise.reject("boom") : db.adapter.transaction(fn)),
        },
        schema: toDescriptor(await introspect(db.adapter, ["api"])),
      });
      broken = true;

      const r = await api.select({ table: "clients", columns: ["id"] });
      expect(r.data).toBeNull();
      expect(r.error).toBeInstanceOf(QueryError);
      expect(r.error).toMatchObject({ kind: "internal", message: "Internal error", details: null, hint: null });
      expect(r.error?.cause).toBe("boom");

      await api.close();
      await db.drop();
    });
  });

  describe("setContextQuery()", () => {
    const store = new AsyncLocalStorage<RequestContext>();

    test("the context comes from the store, across awaits", async () => {
      const db = t.api.setContextQuery(() => store.getStore());
      const deep = async () => {
        await Promise.resolve();
        return db.select({ table: "clients", columns: ["name"], where: { id: 1 } });
      };
      const r = await store.run(authed(), () => deep());
      expect(r.data).toEqual([{ name: "Ada" }]);
      expect(r.error).toBeNull();
    });

    test("concurrent calls each see their own context", async () => {
      // one bound `db`, one store, two requests in flight: this is the whole point of the shape
      const db = t.api.setContextQuery(() => store.getStore());
      const who = () => db.rpc<{ claims: { sub: string } }>({ name: "whoami" });
      const [a, b] = await Promise.all([store.run(authed("user-a"), who), store.run(authed("user-b"), who)]);
      expect(a.data?.claims.sub).toBe("user-a");
      expect(b.data?.claims.sub).toBe("user-b");
    });

    test("a fixed context needs no store", async () => {
      const db = t.api.setContextQuery(authed());
      expect((await db.select({ table: "clients", columns: ["name"], where: { id: 1 } })).data).toEqual([
        { name: "Ada" },
      ]);
    });

    test("an async source is awaited", async () => {
      const db = t.api.setContextQuery(async () => {
        await Promise.resolve();
        return authed();
      });
      expect((await db.select({ table: "clients", columns: ["name"], where: { id: 1 } })).data).toEqual([
        { name: "Ada" },
      ]);
    });

    test("a context passed to the call wins over the source", async () => {
      // what the database saw is the proof: current_user is the overriding role, not the source's
      const db = t.api.setContextQuery({ role: "anon" });
      expect((await db.rpc<{ role: string }>({ name: "whoami" })).data?.role).toBe("anon");
      expect((await db.rpc<{ role: string }>({ name: "whoami" }, authed())).data?.role).toBe("authenticated");
    });

    test("an empty source is an error, not the anonymous role", async () => {
      const db = t.api.setContextQuery(() => store.getStore());
      const r = await db.select({ table: "clients" });
      expect(r.data).toBeNull();
      expect(r.count).toBeUndefined();
      expect(r.error).toBeInstanceOf(QueryError);
      expect(r.error?.kind).toBe("no_context");
      expect(r.error?.input).toEqual({ table: "clients", action: "select" });
    });

    test("a source that throws comes back as an error, not a rejection", async () => {
      const db = t.api.setContextQuery(() => {
        throw new Error("boom");
      });
      const r = await db.select({ table: "clients" });
      expect(r.data).toBeNull();
      expect(r.error).toBeInstanceOf(QueryError);
      expect(r.error?.kind).toBe("internal");
      expect((r.error?.cause as Error | undefined)?.message).toBe("boom");
    });

    test("it answers exactly like query() with the same context", async () => {
      const input: SelectInput = { table: "orders", columns: ["id", "total"], order: ["id"], count: "exact" };
      const db = t.api.setContextQuery(() => store.getStore());
      const bound = await store.run(authed(), () => db.select(input));
      expect(bound).toEqual(await t.api.select(input, authed()));
    });
  });
});
