// `@tspg/query`'s harness: a throwaway database and `createQuery` on it. It names `@tspg/query` and
// `@tspg/core` and nothing else -- there is no `handle()` here, and no `@tspg/rest`.
//
// `createQuery` takes a descriptor and reads no catalog, which is the point of the package: in an
// app that descriptor is generated at build time by `@tspg/query/types`. A suite needs one for a
// database it has just created, so the harness reads it here with `@tspg/core`'s introspection --
// the same step the generator runs -- and `reloadSchema()` is that read done again.
import {
  createQuery,
  type AnyDatabase,
  type QueryInstance,
  type QueryOptions,
  type RequestContext,
  type TypedQueryInstance,
} from "../../src/index";
import { introspect, toDescriptor, type SchemaCache } from "../../../core/src/schema";
import { createTestDb, type TestDb } from "../../../../tests/support/db";

export interface TestQuery {
  readonly db: TestDb;
  /** Replaced by `reloadSchema()`, so a suite reads it off `t` at the moment it calls. */
  api: QueryInstance;
  /** Read the catalog again and rebuild the instance, as a deploy after a migration would. */
  reloadSchema(): Promise<void>;
  /** The catalog itself, for the suites that assert on what introspection found. */
  schemaCache(): Promise<SchemaCache>;
  close(): Promise<void>;
}

/** The user used by tests that write: the `authenticated` role. */
export const authed = (sub = "user-1"): RequestContext => ({ role: "authenticated", claims: { sub } });

export interface MakeOptions extends Partial<Omit<QueryOptions, "schema">> {
  /** The schemas introspection exposes; `schema` itself is built from them. */
  readonly schemas?: string[];
}

export const makeApi = async (options: MakeOptions = {}): Promise<TestQuery> => {
  const db = await createTestDb();
  const { schemas = ["api", "v2"], ...rest } = options;
  const read = () => introspect(db.adapter, schemas);
  const build = async () => createQuery({ db: db.adapter, ...rest, schema: toDescriptor(await read()) });

  const t: TestQuery = {
    db,
    api: await build(),
    async reloadSchema() {
      await t.api.close();
      t.api = await build();
    },
    schemaCache: read,
    async close() {
      await t.api.close();
      await db.drop();
    },
  };
  return t;
};

/** The same instance, typed over a generated database type: what `createQuery<Db>` gives an app. */
export const makeTypedApi = async <Db extends AnyDatabase>(
  options: MakeOptions = {},
): Promise<{ db: TestDb; api: TypedQueryInstance<Db>; close(): Promise<void> }> => {
  const db = await createTestDb();
  const { schemas = ["api", "v2"], ...rest } = options;
  const api = createQuery<Db>({
    db: db.adapter,
    ...rest,
    schema: toDescriptor(await introspect(db.adapter, schemas)),
  });
  return {
    db,
    api,
    async close() {
      await api.close();
      await db.drop();
    },
  };
};
