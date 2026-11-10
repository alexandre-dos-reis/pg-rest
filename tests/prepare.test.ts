import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createQuery, type QueryInput, type QueryInstance, type SelectInput } from "../packages/query/src/index";
import { exec } from "./support/pgrest";
import { introspect, toDescriptor } from "../packages/core/src/schema";
import { createTestDb, hasDb, type TestDb } from "./support/db";

const authed = { role: "authenticated", claims: { sub: "user-1" } };

describe.skipIf(!hasDb)("prepared queries", () => {
  let db: TestDb;
  let q: QueryInstance;
  /** Every statement that reached the driver, in order. */
  let sent: Array<{ text: string; params: unknown[] | undefined }> = [];

  beforeAll(async () => {
    db = await createTestDb();
    const schema = toDescriptor(await introspect(db.adapter, ["api"]));
    const spy = (s: { query: (t: string, p?: unknown[]) => Promise<any> }) => ({
      query: (t: string, p?: unknown[]) => (sent.push({ text: t, params: p }), s.query(t, p)),
    });
    q = createQuery({
      db: { ...db.adapter, transaction: (fn: any) => db.adapter.transaction((s: any) => fn(spy(s))) } as never,
      schema,
    });
  });
  afterAll(() => db.drop());

  /** The statement a query sends -- the last one of its transaction -- with the parameters it travels with. */
  const statementOf = async (run: () => Promise<unknown>): Promise<{ text: string; params: unknown[] | undefined }> => {
    sent = [];
    await run();
    return sent[sent.length - 1]!;
  };

  const paid = (a: { status: string; min: number }): SelectInput => ({
    table: "orders",
    columns: ["id", "total", { clients: { columns: ["name"], inner: true } }],
    where: { status: a.status, total: { $gte: a.min } },
    order: ["id"],
  });

  test("a call answers what the same query object answers, with the same SQL", async () => {
    const find = q.prepare(paid);
    for (const args of [
      { status: "paid", min: 100 },
      { status: "new", min: 0 },
      { status: "shipped", min: 499.5 },
      { status: "it's \\ quoted", min: 1 },
      { status: "", min: -1 },
    ]) {
      const by = { prepared: () => q.run(find(args), authed), direct: () => q.select(paid(args), authed) };
      const [a, b] = [await statementOf(by.prepared), await statementOf(by.direct)];
      expect(a).toEqual(b);
      expect(await by.prepared()).toEqual(await by.direct());
    }
    expect((await q.run(find({ status: "paid", min: 100 }), authed)).data).toEqual([
      { id: 1, total: 250, clients: { name: "Ada" } },
    ]);
  });

  test("a value that changes the SQL itself takes the ordinary route", async () => {
    const like = q.prepare((a: { name: string }) => ({
      table: "clients",
      where: { name: { $ilike: a.name } },
      order: ["id"],
    }));
    const eq = q.prepare((a: { email: string | null }) => ({ table: "clients", where: { email: a.email as never } }));
    // `*` is a wildcard for like, which the stand-in did not know about
    expect((await q.run(like({ name: "a*" }), authed)).data).toEqual(
      (await q.select({ table: "clients", where: { name: { $ilike: "a*" } }, order: ["id"] }, authed)).data,
    );
    expect(((await q.run(like({ name: "*a" }), authed)).data as unknown[]).length).toBe(1); // only Ada ends in a
    // null is IS NULL, not `= 'null'`
    const nullEmail = await q.run(eq({ email: null }), authed);
    expect(nullEmail.error).toBeNull();
    expect(nullEmail.data).toEqual((await q.select({ table: "clients", where: { email: null } }, authed)).data);
    // a missing argument is null too
    expect((await q.run(eq({} as never), authed)).error).toBeNull();
  });

  test("it works in a transaction and on a context query", async () => {
    const find = q.prepare((a: { status: string }) => ({
      table: "orders",
      columns: ["id"],
      where: { status: a.status },
      order: ["id"],
    }));
    const inTx = await q.transaction(async (tx) => (await tx.run(find({ status: "paid" }))).data, authed);
    expect(inTx.data).toEqual([{ id: 1 }, { id: 3 }]);
    const db2 = q.setContextQuery(() => authed);
    expect((await db2.run(find({ status: "new" }))).data).toEqual([{ id: 2 }]);
    // a failure inside the scope rolls it back like any other query's
    const failing = q.prepare((a: { s: string }) => ({ table: "orders", columns: ["nope"], where: { status: a.s } }));
    const out = await q.transaction(async (tx) => tx.run(failing({ s: "paid" })), authed);
    expect(out.error?.kind).toBe("undefined_object");
  });

  test("a failure names the query that ran", async () => {
    const failing = q.prepare((a: { s: string }) => ({ table: "orders", columns: ["nope"], where: { status: a.s } }));
    const r = await q.run(failing({ s: "paid" }), authed);
    expect(r.error?.kind).toBe("undefined_object");
    expect(r.error?.input).toEqual({ table: "orders", columns: ["nope"], where: { status: "paid" } });
  });

  test("count, paging and the single row", async () => {
    const page = q.prepare((a: { status: string }) => ({
      table: "orders",
      columns: ["id"],
      where: { status: a.status },
      order: ["id"],
      limit: 1,
      count: "exact" as const,
    }));
    const r = await q.run(page({ status: "paid" }), authed);
    expect(r.data).toEqual([{ id: 1 }]);
    expect(r.count).toBe(2);
    const one = q.prepare((a: { id: number }) => ({
      table: "orders",
      columns: ["id", "status"],
      where: { id: a.id },
      single: true as const,
    }));
    expect((await q.run(one({ id: 3 }), authed)).data).toEqual({ id: 3, status: "paid" });
    expect((await q.run(one({ id: 99 }), authed)).error?.kind).toBe("not_single_row");
  });

  test("filters inside groups and `in` lists take their values from the arguments", async () => {
    const find = q.prepare((a: { a: string; b: string; id: number }) => ({
      table: "orders",
      columns: ["id"],
      where: { $or: [{ status: a.a }, { status: a.b, id: a.id }] },
      order: ["id"],
    }));
    const direct = (a: { a: string; b: string; id: number }) => ({
      table: "orders",
      columns: ["id"],
      where: { $or: [{ status: a.a }, { status: a.b, id: a.id }] },
      order: ["id"],
    });
    const args = { a: "new", b: "paid", id: 3 };
    expect(await statementOf(() => q.run(find(args), authed))).toEqual(
      await statementOf(() => q.select(direct(args), authed)),
    );
    expect((await q.run(find(args), authed)).data).toEqual([{ id: 2 }, { id: 3 }]);
    const inList = q.prepare((a: { x: number; y: number }) => ({
      table: "orders",
      columns: ["id"],
      where: { id: { $in: [a.x, a.y] } },
      order: ["id"],
    }));
    expect((await q.run(inList({ x: 1, y: 4 }), authed)).data).toEqual([{ id: 1 }, { id: 4 }]);
  });

  test("set-up refuses what a prepared query cannot be", () => {
    // an argument that is not a filter value
    expect(() => q.prepare((a: { c: string }) => ({ table: "orders", where: { [a.c]: 1 } }))).toThrow("filter values");
    expect(() => q.prepare((a: { c: string }) => ({ table: "orders", columns: [a.c] }))).toThrow();
    expect(() => q.prepare((a: { n: number }) => ({ table: "orders", limit: a.n }))).toThrow();
    // an argument that never reaches the SQL
    expect(() =>
      q.prepare((a: { x: string }) => {
        void a.x;
        return { table: "orders" };
      }),
    ).toThrow("never ends up");
    // only selects
    expect(() =>
      q.prepare(
        (a: { s: string }) => ({ table: "orders", action: "delete" as const, where: { status: a.s } }) as never,
      ),
    ).toThrow("only a select");
    expect(() => q.prepare((a: { s: string }) => ({ name: "orders_by_status", args: { s: a.s } }) as never)).toThrow(
      "only a select",
    );
    // a table that is not there
    expect(() => q.prepare((a: { s: string }) => ({ table: "nope", where: { s: a.s } }))).toThrow();
  });

  test("it takes the work off the call", async () => {
    const find = q.prepare(paid);
    const n = 3000;
    const time = async (f: () => Promise<unknown>) => {
      for (let i = 0; i < 300; i++) await f();
      const t = performance.now();
      for (let i = 0; i < n; i++) await f();
      return performance.now() - t;
    };
    const prepared = await time(() => q.run(find({ status: "paid", min: 100 }), authed));
    const direct = await time(() => q.select(paid({ status: "paid", min: 100 }), authed));
    // not a benchmark -- the database dominates -- but it must not be slower than doing the work again
    expect(prepared).toBeLessThan(direct * 1.25);
  });
});

describe.skipIf(!hasDb)("values are bound, not written into the SQL", () => {
  let db: TestDb;
  let q: QueryInstance;
  let sent: Array<{ text: string; params: unknown[] | undefined }> = [];

  beforeAll(async () => {
    db = await createTestDb();
    const schema = toDescriptor(await introspect(db.adapter, ["api"]));
    const spy = (s: { query: (t: string, p?: unknown[]) => Promise<any> }) => ({
      query: (t: string, p?: unknown[]) => (sent.push({ text: t, params: p }), s.query(t, p)),
    });
    q = createQuery({
      db: { ...db.adapter, transaction: (fn: any) => db.adapter.transaction((s: any) => fn(spy(s))) } as never,
      schema,
    });
  });
  afterAll(() => db.drop());

  const lastOf = async (input: QueryInput) => {
    sent = [];
    const r = await exec(q, input, authed);
    expect(r.error).toBeNull();
    return { ...sent[sent.length - 1]!, result: r };
  };

  test("the text depends on the shape of the query, not on its values", async () => {
    const a = await lastOf({ table: "orders", columns: ["id"], where: { status: "paid", total: { $gte: 100 } } });
    const b = await lastOf({ table: "orders", columns: ["id"], where: { status: "new", total: { $gte: 5 } } });
    expect(a.text).toBe(b.text);
    expect(a.text).not.toContain("'paid'");
    expect(a.params).toEqual(["paid", "100"]);
    expect(b.params).toEqual(["new", "5"]);
  });

  test("a value is never part of the SQL", async () => {
    const r = await lastOf({ table: "clients", columns: ["id"], where: { name: "x' OR 1=1 --" } });
    expect(r.text).not.toContain("OR 1=1");
    expect(r.params).toEqual(["x' OR 1=1 --"]);
    expect(r.result.data).toEqual([]);
  });

  test("in lists, groups, quantifiers, text search and embeds bind too", async () => {
    const r = await lastOf({
      table: "orders",
      columns: ["id", { clients: { columns: ["name"], where: { name: { $like: "A*" } } } }],
      where: { $or: [{ id: { $in: [1, 2] } }, { status: { $any: { $eq: ["paid", "new"] } } }] },
    });
    expect(r.text).not.toMatch(/'(paid|new|A%)'/);
    // the embed is built with the select, before the filters of the root
    expect(r.params).toEqual(["A%", "1", "2", "{paid,new}"]);
    expect((r.result.data as unknown[]).length).toBeGreaterThan(0);
  });

  test("numbers after the body of a write", async () => {
    const r = await lastOf({
      table: "orders",
      action: "update",
      set: { status: "x" },
      where: { id: 9999 },
      returning: "minimal",
    });
    expect(r.params).toEqual([JSON.stringify({ status: "x" }), "9999"]);
    expect(r.text).toContain("$2");
    const d = await lastOf({ table: "orders", action: "delete", where: { id: 9999 }, returning: "minimal" });
    expect(d.params).toEqual(["9999"]);
  });

  test("json and jsonb columns keep a literal, a text path is bound", async () => {
    const j = await lastOf({ table: "clients", columns: ["id"], where: { meta: { $cs: { tier: "gold" } } } });
    expect(j.params ?? []).toEqual([]);
    expect(j.text).toContain("tier");
    expect(j.result.data).toEqual([{ id: 1 }]);
    const t = await lastOf({ table: "clients", columns: ["id"], where: { "meta->>tier": "silver" } });
    expect(t.params).toEqual(["silver"]);
    expect(t.result.data).toEqual([{ id: 2 }]);
    const p = await lastOf({ table: "clients", columns: ["id"], where: { "meta->tier": '"gold"' } });
    expect(p.params ?? []).toEqual([]);
    expect(p.result.data).toEqual([{ id: 1 }]);
  });

  test("counts and plans work with bound values", async () => {
    const c = await lastOf({ table: "orders", columns: ["id"], where: { status: "paid" }, limit: 1, count: "exact" });
    expect((c.result as { count: number }).count).toBe(2);
    const e = await lastOf({ table: "orders", columns: ["id"], where: { status: "paid" }, count: "planned" });
    expect(e.result.error).toBeNull();
  });

  test("the HTTP route keeps its literals", async () => {
    // `@tspg/rest` has not changed: only `query` binds (see `tests/compare`, which pins HTTP against PostgREST)
    const { createRest } = await import("../packages/rest/src/index");
    const rest = await createRest({ db: db.adapter, schemas: ["api"] });
    const res = await rest.handle(new Request("http://x/orders?status=eq.paid&select=id"));
    expect(res.status).toBe(200);
    await rest.close();
  });
});
