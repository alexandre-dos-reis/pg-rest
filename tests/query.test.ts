import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ApiError, QueryError, type QueryInput } from "../src/index";
import { hasDb } from "./support/db";
import { authed, makeApi, type TestApi } from "./support/api";
import { toParams } from "../src/query";

/** The query string the object describes, as `handle()` would receive it. */
const qs = (input: QueryInput): string => new URLSearchParams(toParams(input) as Array<[string, string]>).toString();

describe("input -> query string", () => {
  test("select, filters, order and paging", () => {
    expect(qs({ table: "clients", select: ["id", "name"], limit: 10 })).toBe("select=id%2Cname&limit=10");
    expect(qs({ table: "orders", where: { status: "paid", total: ["gte", 100] } })).toBe(
      "status=eq.paid&total=gte.100",
    );
    expect(qs({ table: "clients", where: { meta: null, email: { op: "is", value: null, not: true } } })).toBe(
      "meta=is.null&email=not.is.null",
    );
    expect(qs({ table: "orders", where: { id: ["in", [1, 2, 3]] } })).toBe("id=in.%281%2C2%2C3%29");
    expect(qs({ table: "clients", where: { tags: ["cs", ["vip", "early"]] } })).toBe("tags=cs.%7Bvip%2Cearly%7D");
    expect(qs({ table: "orders", order: [{ column: "total", desc: true, nulls: "last" }, "id"] })).toBe(
      "order=total.desc.nullslast%2Cid",
    );
  });

  test("a lone value is verbatim; a delimited one is quoted", () => {
    // tests/compare pins this against PostgREST: on its own, a value is taken as it is
    expect(qs({ table: "clients", where: { name: "null" } })).toBe("name=eq.null");
    expect(qs({ table: "clients", where: { name: "a,b" } })).toBe("name=eq.a%2Cb");
    expect(qs({ table: "clients", where: { email: "a.b@c.d" } })).toBe("email=eq.a.b%40c.d");
    // in a list or a logic tree, the separators have to be escaped
    expect(qs({ table: "clients", where: { name: ["in", ["a,b", "null", ""]] } })).toBe(
      "name=in.%28%22a%2Cb%22%2C%22null%22%2C%22%22%29",
    );
    expect(qs({ table: "clients", where: { or: [{ email: "a.b@c.d" }] } })).toBe("or=%28email.eq.%22a.b%40c.d%22%29");
    expect(qs({ table: "clients", where: { or: [{ name: 'q"z' }] } })).toBe("or=%28name.eq.%22q%5C%22z%22%29");
    // comparing with null is a NULL test, whichever form it is written in
    expect(qs({ table: "clients", where: { meta: null, email: { op: "eq", value: null, not: true } } })).toBe(
      "meta=is.null&email=not.is.null",
    );
    expect(qs({ table: "clients", where: { meta: ["neq", null] } })).toBe("meta=not.is.null");
  });

  test("and/or groups nest, and several conditions in one group are ANDed", () => {
    expect(qs({ table: "orders", where: { or: [{ status: "paid" }, { total: ["gte", 400] }] } })).toBe(
      "or=%28status.eq.paid%2Ctotal.gte.400%29",
    );
    expect(qs({ table: "orders", where: { or: [{ status: "new", total: ["lt", 50] }, { id: 4 }] } })).toBe(
      "or=%28and%28status.eq.new%2Ctotal.lt.50%29%2Cid.eq.4%29",
    );
  });

  test("embeds carry their own modifiers, filters and paging", () => {
    expect(qs({ table: "clients", select: ["name", { orders: ["total"] }] })).toBe("select=name%2Corders%28total%29");
    expect(
      qs({
        table: "clients",
        select: [
          "name",
          { orders: { select: ["total"], inner: true, where: { status: "paid" }, order: ["total"], limit: 1 } },
        ],
      }),
    ).toBe("select=name%2Corders%21inner%28total%29&orders.status=eq.paid&orders.order=total&orders.limit=1");
    // an alias is also the path its filters use
    expect(qs({ table: "clients", select: [{ orders: { as: "o", select: ["id"], where: { id: 1 } } }] })).toBe(
      "select=o%3Aorders%28id%29&o.id=eq.1",
    );
    expect(qs({ table: "orders", select: [{ clients: { hint: "client_id", spread: true, select: ["name"] } }] })).toBe(
      "select=...clients%21client_id%28name%29",
    );
  });

  test("a bad operator is refused before touching the database", () => {
    expect(() => qs({ table: "orders", where: { total: ["nope" as never, 1] } })).toThrow(/Unknown filter operator/);
  });
});

describe.skipIf(!hasDb)("query()", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  /**
   * The guarantee this API rests on: the object and the equivalent URL go through the same
   * parser, SQL and error mapping, so they must answer with the same thing.
   */
  const same = async (input: QueryInput, path: string, ctx = authed()) => {
    const viaHttp = await t.get(path, { ctx, headers: { Prefer: "return=representation" } });
    const viaObject = await t.api.query(input, ctx).catch((e: unknown) => e);
    if (viaObject instanceof QueryError) {
      expect(viaObject.body).toEqual(viaHttp.json());
      expect(viaObject.status).toBe(viaHttp.status);
      return viaObject;
    }
    expect((viaObject as { data: unknown }).data).toEqual(viaHttp.json());
    return viaObject;
  };

  describe("reads", () => {
    test("the shape the question started with", async () => {
      const r = await t.api.query<Array<{ id: number }>>({ table: "orders", select: ["id"], limit: 10 });
      expect(r.data).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
      expect(r.status).toBe(200);
      expect(r.count).toBeUndefined();
    });

    test("filters, order, paging and count", async () => {
      const r = await t.api.query<Array<{ total: number }>>({
        table: "orders",
        select: ["total"],
        where: { status: "paid" },
        order: [{ column: "total", desc: true }],
        limit: 1,
        count: "exact",
      });
      expect(r.data).toEqual([{ total: 250 }]);
      expect(r.count).toBe(2);
      expect(r.status).toBe(206);
    });

    test("single gives one object", async () => {
      const r = await t.api.query<{ name: string }>({
        table: "clients",
        select: ["name"],
        where: { id: 1 },
        single: true,
      });
      expect(r.data).toEqual({ name: "Ada" });
    });

    test("stripNulls", async () => {
      const r = await t.api.query({ table: "clients", select: ["name", "meta"], where: { id: 3 }, stripNulls: true });
      expect(r.data).toEqual([{ name: "Grace" }]);
    });

    test("embeds, aliases and embedded filters", async () => {
      const r = await t.api.query({
        table: "clients",
        select: ["name", { orders: { as: "paid", select: ["total"], where: { status: "paid" }, inner: true } }],
        order: ["id"],
      });
      expect(r.data).toEqual([
        { name: "Ada", paid: [{ total: 250 }] },
        { name: "Linus", paid: [{ total: 99.99 }] },
      ]);
    });

    test("or groups", async () => {
      const r = await t.api.query<Array<{ id: number }>>({
        table: "orders",
        select: ["id"],
        where: { or: [{ status: "new" }, { total: ["gte", 400] }] },
        order: ["id"],
      });
      expect(r.data).toEqual([{ id: 2 }, { id: 4 }]);
    });

    test("another exposed schema", async () => {
      const r = await t.api.query({ table: "things", schema: "v2", select: ["label"], order: ["id"] });
      expect(r.data).toEqual([{ label: "one" }, { label: "two" }]);
    });
  });

  describe("writes", () => {
    test("insert returns its rows, unlike HTTP, and returning: minimal restores that", async () => {
      const inserted = await t.api.query<Array<{ id: number; name: string }>>(
        { table: "clients", action: "insert", rows: { name: "Hopper" }, select: ["id", "name"] },
        authed(),
      );
      expect(inserted.data).toEqual([{ id: expect.any(Number), name: "Hopper" }]);
      expect(inserted.status).toBe(201);

      const quiet = await t.api.query(
        { table: "clients", action: "insert", rows: { name: "Quiet" }, returning: "minimal" },
        authed(),
      );
      expect(quiet.data).toBeNull();
      expect(quiet.status).toBe(201);
    });

    test("upsert, update and delete", async () => {
      await t.api.query({ table: "products", action: "insert", rows: { id: 90, name: "Pad", price: 5 } }, authed());
      const up = await t.api.query<Array<{ name: string }>>(
        {
          table: "products",
          action: "upsert",
          rows: { id: 90, name: "Pad mk2", price: 6 },
          onConflict: ["id"],
          select: ["name"],
        },
        authed(),
      );
      expect(up.data).toEqual([{ name: "Pad mk2" }]);

      const patched = await t.api.query<Array<{ price: number }>>(
        { table: "products", action: "update", set: { price: 7 }, where: { id: 90 }, select: ["price"] },
        authed(),
      );
      expect(patched.data).toEqual([{ price: 7 }]);

      const deleted = await t.api.query<Array<{ id: number }>>(
        { table: "products", action: "delete", where: { id: 90 }, select: ["id"] },
        authed(),
      );
      expect(deleted.data).toEqual([{ id: 90 }]);
      expect((await t.api.query({ table: "products", where: { id: 90 } })).data).toEqual([]);
    });

    test("maxAffected refuses a too wide update", async () => {
      const e = (await t.api
        .query({ table: "orders", action: "update", set: { status: "x" }, maxAffected: 1 }, authed())
        .catch((x: unknown) => x)) as QueryError;
      expect(e.body.code).toBe("PGRST124");
      expect(
        (await t.api.query<Array<{ status: string }>>({ table: "orders", select: ["status"], where: { status: "x" } }))
          .data,
      ).toEqual([]);
    });
  });

  describe("rpc", () => {
    test("scalar, set-returning with a select, and void", async () => {
      expect((await t.api.query({ rpc: "add", args: { a: 2, b: 3 } })).data).toBe(5);
      expect((await t.api.query({ rpc: "hello" })).data).toBe("hello");
      const rows = await t.api.query({
        rpc: "orders_by_status",
        args: { s: "paid" },
        select: ["total"],
        order: [{ column: "total", desc: true }],
      });
      expect(rows.data).toEqual([{ total: 250 }, { total: 99.99 }]);
      expect((await t.api.query({ rpc: "nothing" }, authed())).data).toBeNull();
    });

    test("the function sees the same request settings as over HTTP, minus the headers", async () => {
      const r = await t.api.query<{ method: string; path: string; header: string | null }>({
        rpc: "req_info",
        single: true,
      });
      expect(r.data.method).toBe("POST");
      expect(r.data.path).toBe("/rpc/req_info");
      expect(r.data.header).toBeNull();
    });
  });

  describe("the caller", () => {
    test("the role and claims reach RLS, exactly like handle()", async () => {
      await t.api.query({ table: "notes", action: "insert", rows: { body: "mine" } }, authed("alice"));
      expect(
        (await t.api.query<Array<{ body: string }>>({ table: "notes", select: ["body"] }, authed("alice"))).data,
      ).toEqual([{ body: "mine" }]);
      expect((await t.api.query({ table: "notes", select: ["body"] }, authed("bob"))).data).toEqual([]);
    });

    test("extra settings are applied", async () => {
      const r = await t.api.query<{ tenant: string }>(
        { rpc: "whoami", single: true },
        { role: "authenticated", claims: { sub: "u" }, settings: { "app.tenant": "acme" } },
      );
      expect(r.data.tenant).toBe("acme");
    });
  });

  describe("errors", () => {
    test("a QueryError is an ApiError carrying the PostgREST body and the input", async () => {
      const input: QueryInput = { table: "cients", select: ["id"] };
      const e = (await t.api.query(input).catch((x: unknown) => x)) as QueryError;
      expect(e).toBeInstanceOf(QueryError);
      expect(e).toBeInstanceOf(ApiError);
      expect(e).toBeInstanceOf(Error);
      expect(e.status).toBe(404);
      expect(e.body).toEqual({
        code: "PGRST205",
        message: "Could not find the table 'api.cients' in the schema cache",
        details: null,
        hint: "Perhaps you meant the table 'api.clients'",
      });
      expect(e.input).toBe(input);
      // the thrown Error reads for a human; the wire body is untouched
      expect(e.message).toBe(
        "PGRST205: Could not find the table 'api.cients' in the schema cache hint: Perhaps you meant the table 'api.clients'",
      );
    });

    test("permissions, RLS and database errors keep their PostgREST code", async () => {
      const denied = (await t.api
        .query({ table: "clients", action: "insert", rows: { name: "x" } })
        .catch((x: unknown) => x)) as QueryError;
      expect(denied.status).toBe(401);
      expect(denied.body.code).toBe("42501");

      const dup = (await t.api
        .query({ table: "clients", action: "insert", rows: { name: "dup", email: "ada@example.com" } }, authed())
        .catch((x: unknown) => x)) as QueryError;
      expect(dup.status).toBe(409);
      expect(dup.body.code).toBe("23505");

      const raised = (await t.api.query({ rpc: "boom" }, authed()).catch((x: unknown) => x)) as QueryError;
      expect(raised.status).toBe(418);
      expect(raised.body).toEqual({
        code: "PT418",
        message: "teapot",
        details: "tip me over",
        hint: "short and stout",
      });
    });

    test("single with the wrong number of rows, and an undeclared embed", async () => {
      const none = (await t.api
        .query({ table: "clients", where: { id: 999 }, single: true })
        .catch((x: unknown) => x)) as QueryError;
      expect(none.status).toBe(406);
      expect(none.body.code).toBe("PGRST116");

      const embed = (await t.api
        .query({ table: "clients", select: ["name"], where: { "orders.total": ["gte", 1] } })
        .catch((x: unknown) => x)) as QueryError;
      expect(embed.body.code).toBe("PGRST108");
    });

    test("anonymous access can be disabled", async () => {
      const closed = await makeApi({ anonymousRole: false });
      const e = (await closed.api.query({ table: "clients" }).catch((x: unknown) => x)) as QueryError;
      expect(e.status).toBe(401);
      expect(e.body.code).toBe("PGRST302");
      await closed.close();
    });
  });

  describe("same answer as handle()", () => {
    const cases: Array<[string, QueryInput, string]> = [
      [
        "columns and paging",
        { table: "orders", select: ["id", "total"], limit: 2, offset: 1, order: ["id"] },
        "/orders?select=id,total&limit=2&offset=1&order=id",
      ],
      [
        "filters",
        { table: "orders", select: ["id"], where: { status: "paid", total: ["gte", 100] } },
        "/orders?select=id&status=eq.paid&total=gte.100",
      ],
      [
        "in and is",
        { table: "clients", select: ["id"], where: { id: ["in", [1, 3]], meta: null } },
        "/clients?select=id&id=in.(1,3)&meta=is.null",
      ],
      [
        "array containment",
        { table: "clients", select: ["name"], where: { tags: ["cs", ["vip"]] }, order: ["id"] },
        "/clients?select=name&tags=cs.{vip}&order=id",
      ],
      [
        "or group",
        { table: "orders", select: ["id"], where: { or: [{ status: "new" }, { total: ["gte", 400] }] }, order: ["id"] },
        "/orders?select=id&or=(status.eq.new,total.gte.400)&order=id",
      ],
      [
        "embed with its own paging",
        {
          table: "clients",
          select: ["name", { orders: { select: ["total"], order: [{ column: "total", desc: true }], limit: 1 } }],
          order: ["id"],
        },
        "/clients?select=name,orders(total)&orders.order=total.desc&orders.limit=1&order=id",
      ],
      [
        "aggregate",
        { table: "orders", select: ["status", "total.sum()"], order: ["status"] },
        "/orders?select=status,total.sum()&order=status",
      ],
      [
        "json path",
        { table: "clients", select: ["name", "tier:meta->>tier"], order: ["id"] },
        "/clients?select=name,tier:meta->>tier&order=id",
      ],
      [
        "rpc with a select",
        { rpc: "orders_by_status", args: { s: "paid" }, select: ["id"], order: ["id"] },
        "/rpc/orders_by_status?s=paid&select=id&order=id",
      ],
      ["unknown table", { table: "nope" }, "/nope"],
      ["unknown column", { table: "clients", select: ["nope"] }, "/clients?select=nope"],
      [
        "undeclared embed filter",
        { table: "clients", select: ["name"], where: { "orders.total": ["gte", 1] } },
        "/clients?select=name&orders.total=gte.1",
      ],
    ];
    for (const [name, input, path] of cases) {
      test(name, async () => {
        await same(input, path);
      });
    }
  });
});
