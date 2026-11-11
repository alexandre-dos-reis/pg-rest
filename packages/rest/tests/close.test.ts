import { describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { DbAdapter } from "../../adapters/src";
import { pgliteAdapter } from "../../adapters/src/pglite";
import { createRest } from "../src/index";

/**
 * What `close()` does to the driver. `createRest` reads the catalog when it is created, so these
 * need a real one: PGlite, like the lazy-schema suite next door, rather than the shared fixture --
 * nothing here writes, and what is tested is the adapter's lifecycle, not a query.
 */

const SCHEMA = `
  CREATE SCHEMA api;
  CREATE ROLE anon;
  CREATE TABLE api.books (id serial PRIMARY KEY, title text NOT NULL);
  GRANT USAGE ON SCHEMA api TO anon;
  GRANT SELECT ON ALL TABLES IN SCHEMA api TO anon;
`;

/** A fresh PGlite, wrapped so the closing is counted, and `close` left to the test. */
const database = async (close?: () => Promise<void>): Promise<DbAdapter & { closed: number }> => {
  const pglite = new PGlite();
  await pglite.exec(SCHEMA);
  const base = pgliteAdapter(pglite);
  let closed = 0;
  return {
    get closed() {
      return closed;
    },
    query: base.query,
    transaction: base.transaction,
    close: async () => {
      closed++;
      await (close ? close() : pglite.close());
    },
  } as DbAdapter & { closed: number };
};

describe("close()", () => {
  test("closes the adapter it was given, once", async () => {
    const db = await database();
    const api = await createRest({ db, schemas: ["api"], anonymousRole: "anon" });
    expect((await api.handle(new Request("http://x/books"))).status).toBe(200);
    expect(db.closed).toBe(0);

    await api.close();
    await api.close();
    expect(db.closed).toBe(1);
  });

  test("onClose takes it over: the driver outlives the handler", async () => {
    const db = await database();
    const seen: DbAdapter[] = [];
    const api = await createRest({
      db,
      schemas: ["api"],
      anonymousRole: "anon",
      onClose: ({ db: given }) => void seen.push(given),
    });
    await api.close();
    expect([db.closed, seen]).toEqual([0, [db]]);

    // the point of it: a second instance on the same driver still works
    const other = await createRest({ db, schemas: ["api"], anonymousRole: "anon" });
    expect((await other.handle(new Request("http://x/books"))).status).toBe(200);
    await other.close();
    expect(db.closed).toBe(1);
  });

  test("a driver something else already closed is not an error", async () => {
    const db = await database(async () => {
      throw new Error("already closed");
    });
    const api = await createRest({ db, schemas: ["api"], anonymousRole: "anon" });
    await api.close(); // does not reject
    expect(db.closed).toBe(1);
  });
});
