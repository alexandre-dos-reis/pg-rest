// The one thing that is neither package's: `@tsql/rest` and `@tsql/query` composed on one database,
// which is what an app that uses both writes. It builds the instance and nothing else -- a test that
// wants a type or an error class imports it from the package that owns it, so that what a suite
// depends on is visible in its own imports.
import {
  createQuery,
  type AnyDatabase,
  type QueryInstance,
  type QueryOptions,
  type TypedQueryInstance,
} from "../../packages/query/src/index";
import { introspect, toDescriptor } from "../../packages/core/src/schema";
import { createRest, type RestInstance, type RestOptions } from "../../packages/rest/src/index";

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
