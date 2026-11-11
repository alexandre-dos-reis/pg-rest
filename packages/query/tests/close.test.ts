import { describe, expect, test } from "bun:test";
import type { DbAdapter } from "../../adapters/src";
import { createQuery } from "../src/index";
import { toDescriptor } from "../../core/src/schema";

/**
 * What `close()` does to the driver. It is the adapter's lifecycle and nothing else -- no catalog is
 * read here (an instance given a descriptor reads none, and a lazy one reads on its first
 * operation), so a counting stub is the whole database these tests need.
 */

/** An adapter that answers nothing and counts the times it was closed. */
const stub = (close?: () => Promise<void>): DbAdapter & { closed: number } => {
  const calls = { closed: 0 };
  const session = { query: async () => [] };
  return {
    get closed() {
      return calls.closed;
    },
    query: session.query,
    transaction: (fn) => fn(session),
    ...(close
      ? {
          close: async () => {
            calls.closed++;
            await close();
          },
        }
      : {}),
  } as DbAdapter & { closed: number };
};

/** An empty schema, so an instance can be created without a catalog to read. */
const emptySchema = () =>
  toDescriptor({
    mediaHandlers: [],
    schemas: ["api"],
    relations: new Map(),
    foreignKeys: [],
    functions: new Map(),
    composites: new Map(),
  });

describe("close()", () => {
  test("closes the adapter it was given", async () => {
    const db = stub(async () => {});
    const api = createQuery({ db, schemas: ["api"] });
    expect(db.closed).toBe(0); // creating an instance closes nothing
    await api.close();
    expect(db.closed).toBe(1);
  });

  test("closes once, however many times it is called", async () => {
    const db = stub(async () => {});
    const api = createQuery({ db, schemas: ["api"] });
    await Promise.all([api.close(), api.close()]);
    await api.close();
    expect(db.closed).toBe(1);
  });

  test("onClose takes it over, and is handed the adapter", async () => {
    const db = stub(async () => {});
    const seen: DbAdapter[] = [];
    const api = createQuery({ db, schemas: ["api"], onClose: ({ db: given }) => void seen.push(given) });
    await api.close();
    expect(db.closed).toBe(0); // the driver is left to the caller
    expect(seen).toEqual([db]); // the adapter as it was given, so `onClose` can close it itself
    await api.close();
    expect(seen.length).toBe(1); // once, like the default
  });

  test("onClose can close the driver itself, and is awaited", async () => {
    const db = stub(async () => {});
    let done = false;
    const api = createQuery({
      db,
      schemas: ["api"],
      onClose: async ({ db: given }) => {
        await given.close?.();
        done = true;
      },
    });
    await api.close();
    expect([db.closed, done]).toEqual([1, true]);
  });

  test("a driver something else already closed is not an error", async () => {
    // pool.end() twice, a shutdown closing in both directions: the library is closing something it
    // did not open, so it has nothing to say about it.
    const db = stub(async () => {
      throw new Error("Called end on pool more than once");
    });
    const api = createQuery({ db, schemas: ["api"] });
    await api.close(); // does not reject
    expect(db.closed).toBe(1);
  });

  test("an adapter with no close() is closed by doing nothing", async () => {
    const db = stub();
    expect(db.close).toBeUndefined();
    await createQuery({ db, schemas: ["api"] }).close();
  });

  test("what onClose throws is the caller's, so it is not swallowed", async () => {
    const api = createQuery({
      db: stub(async () => {}),
      schemas: ["api"],
      onClose: () => {
        throw new Error("my shutdown is broken");
      },
    });
    await expect(api.close()).rejects.toThrow("my shutdown is broken");
  });

  test("an instance on a descriptor closes the same way", async () => {
    const db = stub(async () => {});
    const api = createQuery({ db, schema: emptySchema() });
    await api.close();
    expect(db.closed).toBe(1);
  });
});
