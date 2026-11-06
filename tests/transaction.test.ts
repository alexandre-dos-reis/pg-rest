import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { authed, makeApi, type TestApi } from "./support/api";
import type { RequestContext } from "../src/index";

/**
 * `transaction()`: one scope, one transaction. What is pinned here is the boundary -- what lands,
 * what is undone, and who the database thinks is asking for the whole of it -- plus the three
 * behaviours that stop belonging to a single query once several share a transaction.
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
      const client = await tx.query<{ id: number }>({
        table: "clients",
        action: "insert",
        rows: { name: "Ada" },
        single: true,
      });
      if (client.error) throw client.error;
      const order = await tx.query<Array<{ id: number }>>({
        table: "orders",
        action: "insert",
        rows: { client_id: client.data.id, total: 10 },
      });
      if (order.error) throw order.error;
      return { client: client.data.id, orders: order.data.length };
    }, authed());

    expect(r.error).toBeNull();
    expect(r.data).toEqual({ client: expect.any(Number), orders: 1 });
    expect(r.count).toBeUndefined();
    expect(r.status).toBe(200);
    expect(await names()).toContain("Ada");
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

  test("a QueryError thrown out of the scope comes back as it is", async () => {
    t = await makeApi();
    const r = await t.api.transaction(async (tx) => {
      const bad = await tx.query({ table: "clients", action: "insert", rows: { nope: 1 } });
      if (bad.error) throw bad.error;
      return 1;
    }, authed());

    expect(r.error?.body.code).toBe("PGRST204");
    expect(r.error?.kind).toBe("invalid_payload");
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

  test("a failed query condemns the scope, even when the callback returns anyway", async () => {
    t = await makeApi();
    const before = await names();
    // PGRST116 is raised by the library *after* a statement that worked: nothing aborted the
    // transaction, so the write before it would commit if the scope did not refuse to.
    const r = await t.api.transaction(async (tx) => {
      await tx.query({ table: "clients", action: "insert", rows: { name: "Gone" } });
      const none = await tx.query({ table: "clients", where: { name: "nobody" }, single: true });
      return none.error?.body.code ?? "committed";
    }, authed());

    expect(r.data).toBeNull();
    expect(r.error?.body.code).toBe("PGRST116");
    expect(await names()).toEqual(before);
  });

  test("a query after a failure is refused, rather than answering 25P02", async () => {
    t = await makeApi();
    // An assertion inside the callback would be swallowed as the scope's own failure, so the codes
    // are collected and read afterwards.
    const seen: Array<string | undefined> = [];
    const r = await t.api.transaction(async (tx) => {
      const dup = await tx.query({ table: "clients", action: "insert", rows: { name: "a", email: "dup@x.com" } });
      seen.push(dup.error?.body.code);
      const again = await tx.query({ table: "clients", action: "insert", rows: { name: "b", email: "dup@x.com" } });
      seen.push(again.error?.body.code);
      const after = await tx.query({ table: "clients", select: ["id"] });
      seen.push(after.error?.body.code);
      return "returned";
    }, authed());

    expect(seen).toEqual([undefined, "23505", "PGRSTX03"]);
    expect(r.data).toBeNull();
    expect(r.error?.body.code).toBe("23505");
    expect(r.error?.kind).toBe("conflict");
  });

  test("a nested scope is a savepoint: it fails on its own and the scope goes on", async () => {
    t = await makeApi();
    const seen: Array<unknown> = [];
    const r = await t.api.transaction(async (tx) => {
      const first = await tx.query({ table: "clients", action: "insert", rows: { name: "Ada", email: "ada@x.com" } });
      seen.push(first.error?.body.code);

      const dup = await tx.transaction(async (inner) => {
        const bad = await inner.query({
          table: "clients",
          action: "insert",
          rows: { name: "Dup", email: "ada@x.com" },
        });
        if (bad.error) throw bad.error;
        return "unreachable";
      });
      seen.push(dup.error?.body.code);

      const kept = await tx.transaction(async (inner) => {
        const ok = await inner.query({ table: "clients", action: "insert", rows: { name: "Bob", email: "bob@x.com" } });
        if (ok.error) throw ok.error;
        return "kept";
      });
      seen.push(kept.data);

      const last = await tx.query({ table: "clients", action: "insert", rows: { name: "Cleo" } });
      return last.error === null;
    }, authed());

    expect(seen).toEqual([undefined, "23505", "kept"]);
    expect(r.data).toBe(true);
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
        if (a.error || b.error) throw a.error ?? b.error;
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
      const mine = await tx.query({ table: "notes", action: "insert", rows: { body: "mine" } });
      if (mine.error) throw mine.error;
      const theirs = await tx.query<Array<{ owner: string }>>({ table: "notes", select: ["owner"] });
      if (theirs.error) throw theirs.error;
      return theirs.data.map((n) => n.owner);
    }, authed("u-7"));

    expect(r.error).toBeNull();
    expect(new Set(r.data)).toEqual(new Set(["u-7"]));
  });

  test("two schemas in one scope: every query sets its own search_path", async () => {
    t = await makeApi();
    const r = await t.api.transaction(async (tx) => {
      const thing = await tx.query<Array<{ id: number }>>({
        schema: "v2",
        table: "things",
        action: "insert",
        rows: { label: "x" },
      });
      if (thing.error) throw thing.error;
      const client = await tx.query<Array<{ id: number }>>({
        table: "clients",
        action: "insert",
        rows: { name: "Both" },
      });
      if (client.error) throw client.error;
      return "both";
    }, authed());

    expect(r.error).toBeNull();
    expect(r.data).toBe("both");
    expect(await names()).toContain("Both");
  });

  test("readOnly is decided by the scope, not by whichever query went first", async () => {
    t = await makeApi();
    let readFailed: string | undefined;
    const r = await t.api.transaction(
      async (tx) => {
        const read = await tx.query<Array<unknown>>({ table: "clients", select: ["id"] });
        readFailed = read.error?.body.code;
        const write = await tx.query({ table: "clients", action: "insert", rows: { name: "No" } });
        return write.error?.body.code;
      },
      { ...authed(), readOnly: true },
    );

    expect(readFailed).toBeUndefined();

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
        async (tx) => {
          const read = await tx.query<{ level: string; readOnly: string }>({ rpc: "iso" });
          if (read.error) throw read.error;
          return read.data;
        },
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
          const seen = await tx.query<Array<unknown>>({ table: "clients", select: ["id"] });
          if (seen.error) throw seen.error;
          if (++read === 2) bothRead!();
          await everyoneRead;
          const wrote = await tx.query({ table: "clients", action: "insert", rows: { name } });
          if (wrote.error) throw wrote.error;
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
    const fn = async (tx: { query: (i: any) => Promise<{ error: unknown }> }) => {
      runs++;
      const r = await tx.query({ rpc: "flaky" });
      if (r.error) throw r.error;
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

    const inside = await store.run(authed("u-1"), () =>
      bound.transaction(async (tx) => {
        const who = await tx.query<{ claims: { sub: string } }>({ rpc: "whoami" });
        if (who.error) throw who.error;
        return who.data.claims.sub;
      }),
    );
    expect(inside.data).toBe("u-1");

    // outside the store there is nothing to read, and no transaction is opened
    const outside = await bound.transaction(async () => 1);
    expect(outside.error?.body.code).toBe("PGRSTX01");
    expect(outside.error?.kind).toBe("no_context");

    // readOnly alone keeps the ambient context; a role replaces it for the whole scope
    const stillAmbient = await store.run(authed("u-2"), () =>
      bound.transaction(
        async (tx) => {
          const who = await tx.query<{ claims: { sub: string } }>({ rpc: "whoami" });
          if (who.error) throw who.error;
          return who.data.claims.sub;
        },
        { readOnly: true },
      ),
    );
    expect(stillAmbient.data).toBe("u-2");

    const overridden = await store.run(authed("u-3"), () =>
      bound.transaction(
        async (tx) => {
          const who = await tx.query<{ role: string }>({ rpc: "whoami" });
          if (who.error) throw who.error;
          return who.data.role;
        },
        { role: "anon" },
      ),
    );
    expect(overridden.data).toBe("anon");
  });
});
