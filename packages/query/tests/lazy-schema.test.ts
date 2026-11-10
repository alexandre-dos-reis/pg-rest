import { beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { DbAdapter } from "../../adapters/src";
import { pgliteAdapter } from "../../adapters/src/pglite";
import { createQuery } from "../src/index";
import { introspect } from "../src/types";
import { toDescriptor } from "../../core/src/schema";

/**
 * `createQuery` with no `schema` descriptor reads the catalog itself, once, on its first operation.
 * What is tested here is that read and nothing else -- the queries it then answers are the suites
 * next door, which run on a descriptor. It is on PGlite rather than the shared fixture because a
 * catalog read needs a real catalog, and no test here writes, so one database serves them all.
 */

const SCHEMA = `
  CREATE SCHEMA api;
  CREATE ROLE anon;
  CREATE TABLE api.books (id serial PRIMARY KEY, title text NOT NULL);
  INSERT INTO api.books (title) VALUES ('Emma');
  GRANT USAGE ON SCHEMA api TO anon;
  GRANT SELECT ON ALL TABLES IN SCHEMA api TO anon;
`;

/** A catalog read is a statement selecting from the catalog; `reset` scopes the count to one test. */
const statements: string[] = [];
const catalogReads = () => statements.filter((s) => /\bpg_(class|proc|type)\b/.test(s)).length;
const reset = () => (statements.length = 0);

let bare: DbAdapter; //  the driver itself: introspecting through it is not counted
let db: DbAdapter; //    the same, with every statement recorded
const options = () => ({ db, schemas: ["api"], anonymousRole: "anon" });

beforeAll(async () => {
  const pglite = new PGlite();
  await pglite.exec(SCHEMA);
  bare = pgliteAdapter(pglite);
  const seen =
    (q: DbAdapter["query"]): DbAdapter["query"] =>
    (text, params) => (statements.push(text), q(text, params));
  db = { query: seen(bare.query), transaction: (fn) => bare.transaction((s) => fn({ query: seen(s.query) })) };
});

describe("createQuery without a descriptor", () => {
  test("creating it reads nothing; the first operation reads the catalog, and only it does", async () => {
    reset();
    const api = createQuery(options());
    expect(catalogReads()).toBe(0); // creating an instance is synchronous and touches nothing

    const first = await api.select({ table: "books", columns: ["title"] });
    expect(first.error).toBeNull();
    expect(first.data).toEqual([{ title: "Emma" }]); // the live catalog, so the query resolves
    const read = catalogReads();
    expect(read).toBeGreaterThan(0);

    expect((await api.select({ table: "books", columns: ["title"] })).error).toBeNull();
    await api.ready();
    expect(catalogReads()).toBe(read); // the cache is kept: nothing reads it again
  });

  test("concurrent first calls share the one read", async () => {
    reset();
    await createQuery(options()).ready();
    const perRead = catalogReads(); // what reading the catalog once costs
    expect(perRead).toBeGreaterThan(0);

    reset();
    const api = createQuery(options());
    const [a, b] = await Promise.all([
      api.select({ table: "books", columns: ["title"] }),
      api.select({ table: "books", columns: ["id"] }),
      api.ready(),
      api.ready(),
    ]);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect(catalogReads()).toBe(perRead); // four callers, one read between them
  });

  test("a read that failed is an error, not a rejection, and the next call tries again", async () => {
    let down = true;
    const flaky: DbAdapter = {
      query: (text, params) => {
        if (down && /\bpg_(class|proc|type)\b/.test(text)) return Promise.reject(new Error("connection refused"));
        return db.query(text, params);
      },
      transaction: (fn) => db.transaction(fn),
    };
    const api = createQuery({ ...options(), db: flaky });

    const failed = await api.select({ table: "books", columns: ["title"] });
    expect(failed.error?.kind).toBe("internal");
    expect(failed.data).toBeNull();

    down = false;
    const ok = await api.select({ table: "books", columns: ["title"] });
    expect(ok.error).toBeNull();
    expect(ok.data).toEqual([{ title: "Emma" }]);
  });

  test("prepare() plans synchronously, so it asks for ready() first", async () => {
    const api = createQuery(options());
    const build = (a: { id: number }) => ({ table: "books", columns: ["title"], where: { id: a.id } });
    expect(() => api.prepare(build)).toThrow(/schema has not been read/);

    await api.ready();
    const { data, error } = await api.run(api.prepare(build)({ id: 1 }));
    expect(error).toBeNull();
    expect(data).toEqual([{ title: "Emma" }]);
  });

  test("a descriptor still means no read at all", async () => {
    reset();
    const cache = await introspect({ db: bare, schemas: ["api"] }); // through the uncounted adapter
    const api = createQuery({ ...options(), schema: toDescriptor(cache) });
    expect((await api.select({ table: "books", columns: ["title"] })).error).toBeNull();
    await api.ready(); // it has its schema: there is nothing to wait for
    expect(catalogReads()).toBe(0);
  });
});
