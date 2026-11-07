// The two entry points side by side, for tests that exercise both on one database.
// `@tsql/rest` and `@tsql/query` are separate packages; this is what an app that uses both writes.
import {
  createQuery,
  type AnyDatabase,
  type QueryInstance,
  type TypedQueryInstance,
} from "../../packages/query/src/index";
import { createRest, type RestInstance, type RestOptions } from "../../packages/rest/src/index";

export * from "../../packages/query/src/index";
export { createRest, type RestInstance, type RestOptions };

export type PgRestOptions = RestOptions;
export type PgRestInstance = RestInstance & QueryInstance;
export type TypedPgRestInstance<Db extends AnyDatabase> = RestInstance & TypedQueryInstance<Db>;

interface CreatePgRest {
  (options: PgRestOptions): Promise<PgRestInstance>;
  <Db extends AnyDatabase>(options: PgRestOptions): Promise<TypedPgRestInstance<Db>>;
}

const create = async (options: PgRestOptions): Promise<PgRestInstance> => {
  const [rest, query] = await Promise.all([createRest(options), createQuery(options)]);
  return {
    ...query,
    handle: rest.handle,
    reloadSchema: async () => {
      await Promise.all([rest.reloadSchema(), query.reloadSchema()]);
    },
    close: async () => {
      await Promise.all([rest.close(), query.close()]);
    },
  };
};

export const createPgRest: CreatePgRest = create as CreatePgRest;
