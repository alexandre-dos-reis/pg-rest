// The two entry points side by side, for tests that exercise both on one database.
// `@tsql/rest` and `@tsql/query` are separate packages; this is what an app that uses both writes.
import {
  createQuery,
  type AnyDatabase,
  type QueryInput,
  type QueryInstance,
  type QueryOptions,
  type QueryResult,
  type RequestContext,
  type TypedQueryInstance,
} from "../../packages/query/src/index";
import { introspect, toDescriptor } from "../../packages/core/src/schema";
import {
  ApiError,
  DbQueryError,
  PgRestError,
  createRest,
  type RestInstance,
  type RestOptions,
} from "../../packages/rest/src/index";

export * from "../../packages/query/src/index";
export { ApiError, DbQueryError, PgRestError, createRest, type RestInstance, type RestOptions };

/**
 * Run an input whose operation is only known at run time (a table-driven test): the one place a test
 * dispatches on `action` itself, the way the six methods do.
 */
export const exec = <T = unknown>(
  api: QueryInstance,
  input: QueryInput,
  ctx?: RequestContext,
): Promise<QueryResult<T>> => {
  const op = "rpc" in input ? "rpc" : (input.action ?? "select");
  return (api as unknown as Record<string, (i: QueryInput, c?: RequestContext) => Promise<QueryResult<T>>>)[op]!(
    input,
    ctx,
  );
};

export type PgRestOptions = RestOptions;
export type PgRestInstance = RestInstance & QueryInstance;
export type TypedPgRestInstance<Db extends AnyDatabase> = RestInstance & TypedQueryInstance<Db>;

interface CreatePgRest {
  (options: PgRestOptions): Promise<PgRestInstance>;
  <Db extends AnyDatabase>(options: PgRestOptions): Promise<TypedPgRestInstance<Db>>;
}

const create = async (options: PgRestOptions): Promise<PgRestInstance> => {
  const rest = await createRest(options);
  // query runs on a descriptor, like in an app: the catalog is read here, at "build time"
  const build = async () =>
    createQuery({
      ...options,
      // the same callback serves both: a call of `query()` has no `request` to give it
      preRequest: options.preRequest as QueryOptions["preRequest"],
      schema: toDescriptor(await introspect(options.db, options.schemas?.length ? options.schemas : ["public"])),
    });
  let query = await build();
  return {
    handle: rest.handle,
    schemaCache: rest.schemaCache,
    select: (input, ctx) => query.select(input, ctx),
    insert: (input, ctx) => query.insert(input, ctx),
    upsert: (input, ctx) => query.upsert(input, ctx),
    update: (input, ctx) => query.update(input, ctx),
    delete: (input, ctx) => query.delete(input, ctx),
    rpc: (input, ctx) => query.rpc(input, ctx),
    run: (call, ctx) => query.run(call, ctx),
    prepare: (build) => query.prepare(build),
    setContextQuery: (source) => query.setContextQuery(source),
    transaction: (fn, scope) => query.transaction(fn, scope),
    reloadSchema: async () => {
      await rest.reloadSchema();
      query = await build();
    },
    close: async () => {
      await Promise.all([rest.close(), query.close()]);
    },
  } as PgRestInstance;
};

export const createPgRest: CreatePgRest = create as CreatePgRest;
