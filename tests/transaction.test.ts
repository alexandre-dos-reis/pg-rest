import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { authed, makeApi, type TestApi } from "./support/api";
import { QueryError, type RequestContext } from "./support/pgrest";

/**
 * `transaction()`: one scope, one transaction. What is pinned here is the boundary -- what lands,
 * what is undone, and who the database thinks is asking for the whole of it -- plus the three
 * behaviours that stop belonging to a single query once several share a transaction.
 *
 * The other half is the failure. `tx.query` rejects rather than answering an `error`, because a
 * query that failed is a transaction that will not commit; the scope is what catches it and never
 * rejects. So most of the tests below read the failure off the *scope*, not off the query.
 */
describe.skipIf(!hasDb)("transaction()", () => {
  let t: TestApi | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  const names = async (): Promise<string[]> => {
    const r = await t!.api.query<Array<{ name: string }>>({ table: "clients", select: ["name"] });
    if (r.error) throw r.error;
    return r.data.map((c) => c.name);
  };

  test("two writes land together, and the callback's value is the data", async () => {
    t = await makeApi();
    const r = await t.api.transaction(async (tx) => {
      // nothing is narrowed: `tx.query` left on failure, so this result is the success
      const client = await tx.query<{ id: number }>({
        table: "clients",
        action: "insert",
        rows: { name: "Ada" },
        single: true,
      });
      const order = await tx.query<Array<{ id: number }>>({
        table: "orders",
        action: "insert",
        rows: { client_id: client.data.id, total: 10 },
      });
      return { client: client.data.id, orders: order.data.length };
    }, authed());

    expect(r.error).toBeNull();
    expect(r.data).toEqual({ client: expect.any(Number), orders: 1 });
    expect(r.count).toBeUndefined();
    expect(r.status).toBe(200);
    expect(await names()).toContain("Ada");
  });

  test("a failed query leaves the scope, and the write before it is undone", async () => {
    t = await makeApi();
    const before = await names();
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "clients", action: "insert", rows: { name: "Gone", email: "dup@x.com" } });
      await tx.query({ table: "clients", action: "insert", rows: { name: "Dup", email: "dup@x.com" } });
      return "unreachable";
    }, authed());

    expect(r.data).toBeNull();
    expect(r.error?.body.code).toBe("23505");
    expect(r.error?.kind).toBe("conflict");
    // the error is the query's own, so it names the input that produced it
    expect(r.error?.input).toMatchObject({ table: "clients", action: "insert" });
    expect(await names()).toEqual(before);
  });

  test("what it throws is a QueryError, so a callback may act on it before leaving", async () => {
    t = await makeApi();
    let seen: string | undefined;
    const r = await t.api.transaction(async (tx) => {
      try {
        await tx.query({ table: "clients", where: { name: "nobody" }, single: true });
      } catch (e) {
        seen = e instanceof QueryError ? e.kind : "something else";
        throw e; //                                leaving is still the caller's decision
      }
      return "unreachable";
    }, authed());

    expect(seen).toBe("not_single_row");
    expect(r.error?.body.code).toBe("PGRST116");
  });

  test("a throw rolls the whole scope back", async () => {
    t = await makeApi();
    const before = await names();
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "clients", action: "insert", rows: { name: "Gone" } });
      throw new Error("no");
    }, authed());

    expect(r.data).toBeNull();
    expect(r.error?.status).toBe(500);
    expect(r.error?.body.code).toBe("PGRSTX00");
    expect((r.error!.cause as Error).message).toBe("no");
    expect(r.error?.summary).toStartWith("transaction failed:");
    expect(await names()).toEqual(before);
  });

  test("rollback() undoes the scope and says so", async () => {
    t = await makeApi();
    const before = await names();
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "clients", action: "insert", rows: { name: "Gone" } });
      tx.rollback();
    }, authed());

    expect(r.error?.body.code).toBe("PGRSTX02");
    expect(r.error?.kind).toBe("rolled_back");
    expect(await names()).toEqual(before);
  });

  test("a failure swallowed by the callback still cannot commit", async () => {
    t = await makeApi();
    const before = await names();
    // PGRST116 is raised by the library *after* a statement that worked: nothing aborted the
    // transaction, so the write before it would commit if the scope did not refuse to. Reaching
    // this needs a deliberate catch, which is the only way past `tx.query` leaving.
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "clients", action: "insert", rows: { name: "Gone" } });
      try {
        await tx.query({ table: "clients", where: { name: "nobody" }, single: true });
      } catch {
        return "committed anyway?";
      }
      return "unreachable";
    }, authed());

    expect(r.data).toBeNull();
    expect(r.error?.body.code).toBe("PGRST116");
    expect(await names()).toEqual(before);
  });

  test("a query after a swallowed failure is refused, rather than answering 25P02", async () => {
    t = await makeApi();
    const seen: string[] = [];
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "clients", action: "insert", rows: { name: "a", email: "dup@x.com" } });
      try {
        await tx.query({ table: "clients", action: "insert", rows: { name: "b", email: "dup@x.com" } });
      } catch (e) {
        seen.push((e as QueryError).body.code);
      }
      try {
        await tx.query({ table: "clients", select: ["id"] });
      } catch (e) {
        seen.push((e as QueryError).body.code);
      }
      return "returned";
    }, authed());

    expect(seen).toEqual(["23505", "PGRSTX03"]);
    expect(r.data).toBeNull();
    expect(r.error?.body.code).toBe("23505");
  });

  test("a nested scope is a savepoint: it fails on its own and the scope goes on", async () => {
    t = await makeApi();
    const seen: Array<unknown> = [];
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "clients", action: "insert", rows: { name: "Ada", email: "ada@x.com" } });

      // the nested scope catches what the query throws, rolls back to its savepoint, and answers
      // a result -- which is why nothing here has to try/catch
      const dup = await tx.transaction((inner) =>
        inner.query({ table: "clients", action: "insert", rows: { name: "Dup", email: "ada@x.com" } }),
      );
      seen.push(dup.error?.body.code);

      const kept = await tx.transaction(async (inner) => {
        await inner.query({ table: "clients", action: "insert", rows: { name: "Bob", email: "bob@x.com" } });
        return "kept";
      });
      seen.push(kept.data);

      await tx.query({ table: "clients", action: "insert", rows: { name: "Cleo" } });
      return "done";
    }, authed());

    expect(seen).toEqual(["23505", "kept"]);
    expect(r.data).toBe("done");
    const after = await names();
    expect(after).toContain("Ada");
    expect(after).toContain("Bob");
    expect(after).toContain("Cleo");
    expect(after).not.toContain("Dup");
  });

  test("rollback() in a nested scope undoes the savepoint only", async () => {
    t = await makeApi();
    let nestedCode: string | undefined;
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "clients", action: "insert", rows: { name: "Kept" } });
      const inner = await tx.transaction(async (nested) => {
        await nested.query({ table: "clients", action: "insert", rows: { name: "Dropped" } });
        nested.rollback();
      });
      nestedCode = inner.error?.body.code;
      return "done";
    }, authed());

    expect(nestedCode).toBe("PGRSTX02");
    expect(r.data).toBe("done");
    const after = await names();
    expect(after).toContain("Kept");
    expect(after).not.toContain("Dropped");
  });

  test("the context is applied once, and every query in the scope sees it", async () => {
    t = await makeApi();
    const r = await t.api.transaction(
      async (tx) => {
        const a = await tx.query<{ role: string; claims: Record<string, string>; tenant: string }>({ rpc: "whoami" });
        const b = await tx.query<{ role: string }>({ rpc: "whoami" });
        return [a.data, b.data.role] as const;
      },
      { role: "authenticated", claims: { sub: "u-9" }, settings: { "app.tenant": "acme" } },
    );

    expect(r.error).toBeNull();
    expect(r.data?.[0]).toEqual({
      role: "authenticated",
      claims: { role: "authenticated", sub: "u-9" },
      tenant: "acme",
    });
    expect(r.data?.[1]).toBe("authenticated");
  });

  test("RLS reads the claims the scope set", async () => {
    t = await makeApi();
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "notes", action: "insert", rows: { body: "mine" } });
      const theirs = await tx.query<Array<{ owner: string }>>({ table: "notes", select: ["owner"] });
      return theirs.data.map((n) => n.owner);
    }, authed("u-7"));

    expect(r.error).toBeNull();
    expect(new Set(r.data)).toEqual(new Set(["u-7"]));
  });

  test("two schemas in one scope: every query sets its own search_path", async () => {
    t = await makeApi();
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ schema: "v2", table: "things", action: "insert", rows: { label: "x" } });
      await tx.query({ table: "clients", action: "insert", rows: { name: "Both" } });
      return "both";
    }, authed());

    expect(r.error).toBeNull();
    expect(r.data).toBe("both");
    expect(await names()).toContain("Both");
  });

  test("a count asked for inside a scope is the number, not a maybe", async () => {
    t = await makeApi();
    const r = await t.api.transaction(async (tx) => {
      const { count } = await tx.query<Array<unknown>, number>({
        table: "clients",
        select: ["id"],
        count: "exact",
        limit: 1,
      });
      return count + 1;
    }, authed());

    expect(r.error).toBeNull();
    expect(r.data).toBeGreaterThan(1);
  });

  test("readOnly is decided by the scope, not by whichever query went first", async () => {
    t = await makeApi();
    const r = await t.api.transaction(
      async (tx) => {
        await tx.query<Array<unknown>>({ table: "clients", select: ["id"] });
        await tx.query({ table: "clients", action: "insert", rows: { name: "No" } });
        return "unreachable";
      },
      { ...authed(), readOnly: true },
    );

    // 25006 read_only_sql_transaction, which PostgREST answers 405 to
    expect(r.error?.body.code).toBe("25006");
    expect(r.error?.status).toBe(405);
  });

  test("the isolation level is the scope's too", async () => {
    t = await makeApi();
    await t.db.adapter.query(`
      CREATE FUNCTION api.iso() RETURNS json LANGUAGE sql STABLE AS $$
        SELECT json_build_object(
          'level', current_setting('transaction_isolation'),
          'readOnly', current_setting('transaction_read_only'));
      $$;
    `);
    await t.db.adapter.query(`GRANT EXECUTE ON FUNCTION api.iso() TO authenticated`);
    await t.api.reloadSchema();

    const iso = async (options: Record<string, unknown>) => {
      const r = await t!.api.transaction(
        async (tx) => (await tx.query<{ level: string; readOnly: string }>({ rpc: "iso" })).data,
        { ...authed(), ...options },
      );
      if (r.error) throw r.error;
      return r.data;
    };

    expect(await iso({})).toEqual({ level: "read committed", readOnly: "off" });
    expect(await iso({ isolationLevel: "repeatable read" })).toEqual({ level: "repeatable read", readOnly: "off" });
    // both go in one `SET TRANSACTION`, which has to be the transaction's first statement
    expect(await iso({ isolationLevel: "serializable", readOnly: true })).toEqual({
      level: "serializable",
      readOnly: "on",
    });
  });

  test("serializable really is serializable: one of two concurrent scopes is told so", async () => {
    t = await makeApi();
    // Write skew: each scope reads the whole table, then writes. Under SSI one of the two commits
    // is refused with 40001, which is the failure `retry` exists for.
    const seeded = (await names()).length;
    let read = 0;
    let bothRead: (() => void) | undefined;
    const everyoneRead = new Promise<void>((resolve) => {
      bothRead = resolve;
    });

    const scope = (name: string) =>
      t!.api.transaction(
        async (tx) => {
          await tx.query<Array<unknown>>({ table: "clients", select: ["id"] });
          if (++read === 2) bothRead!();
          await everyoneRead;
          await tx.query({ table: "clients", action: "insert", rows: { name } });
          return name;
        },
        { ...authed(), isolationLevel: "serializable" },
      );

    const [a, b] = await Promise.all([scope("one"), scope("two")]);
    const failed = [a, b].filter((r) => r.error);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.error?.body.code).toBe("40001");
    expect(await names()).toHaveLength(seeded + 1); // only the scope that was not refused committed
  });

  test("no retry by default, and `retry` replays the callback", async () => {
    t = await makeApi();
    await t.db.adapter.query(`
      CREATE FUNCTION api.flaky() RETURNS int LANGUAGE plpgsql AS $$
      DECLARE n int;
      BEGIN
        SELECT count(*)::int INTO n FROM api.clients WHERE name = 'attempt';
        IF n < 2 THEN
          INSERT INTO api.clients (name) VALUES ('attempt');
          RAISE EXCEPTION 'serialization' USING ERRCODE = '40001';
        END IF;
        RETURN n;
      END $$;
    `);
    await t.db.adapter.query(`GRANT EXECUTE ON FUNCTION api.flaky() TO authenticated`);
    await t.api.reloadSchema();

    let runs = 0;
    const fn = async (tx: { query: (i: any) => Promise<unknown> }) => {
      runs++;
      await tx.query({ rpc: "flaky" });
      return runs;
    };

    const once = await t.api.transaction(fn, authed());
    expect(runs).toBe(1);
    expect(once.error?.body.code).toBe("40001");

    runs = 0;
    const retried = await t.api.transaction(fn, { ...authed(), retry: { attempts: 3, delayMs: 1 } });
    // the 'attempt' rows never commit, so the function keeps raising: three runs, then the failure
    expect(runs).toBe(3);
    expect(retried.error?.body.code).toBe("40001");

    // `on` names what is worth replaying: a deadlock is not a serialization failure
    runs = 0;
    const other = await t.api.transaction(fn, { ...authed(), retry: { attempts: 3, on: ["40P01"] } });
    expect(runs).toBe(1);
    expect(other.error?.body.code).toBe("40001");
  });

  test("anonymous access disabled is refused before the BEGIN", async () => {
    t = await makeApi({ anonymousRole: false });
    let entered = false;
    const r = await t.api.transaction(async () => {
      entered = true;
    });
    expect(entered).toBe(false);
    expect(r.error?.body.code).toBe("PGRST302");
  });

  test("the bound form reads its source once, on entry", async () => {
    t = await makeApi();
    const store = new AsyncLocalStorage<RequestContext>();
    const bound = t.api.setContextQuery(() => store.getStore());
    const whoami = async (tx: { query: <T>(i: any) => Promise<{ data: T }> }) =>
      (await tx.query<{ role: string; claims: { sub: string } }>({ rpc: "whoami" })).data;

    const inside = await store.run(authed("u-1"), () => bound.transaction(async (tx) => (await whoami(tx)).claims.sub));
    expect(inside.data).toBe("u-1");

    // outside the store there is nothing to read, and no transaction is opened
    const outside = await bound.transaction(async () => 1);
    expect(outside.error?.body.code).toBe("PGRSTX01");
    expect(outside.error?.kind).toBe("no_context");

    // readOnly alone keeps the ambient context; a role replaces it for the whole scope
    const stillAmbient = await store.run(authed("u-2"), () =>
      bound.transaction(async (tx) => (await whoami(tx)).claims.sub, { readOnly: true }),
    );
    expect(stillAmbient.data).toBe("u-2");

    const overridden = await store.run(authed("u-3"), () =>
      bound.transaction(async (tx) => (await whoami(tx)).role, { role: "anon" }),
    );
    expect(overridden.data).toBe("anon");
  });
});
