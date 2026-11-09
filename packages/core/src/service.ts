import type { DbAdapter } from "@tsql/adapters";
import { type SchemaCache, introspect } from "./schema";

/** The schema could not be read from the database catalog. */
export class SchemaLoadError extends Error {
  readonly _tag = "SchemaLoadError";
  constructor(override readonly cause: unknown) {
    super(`pg-rest: could not load the database schema: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "SchemaLoadError";
  }
}

/** Holds the schema cache; reloads are serialized and never discard a good cache on failure. */
export interface SchemaStore {
  current(): SchemaCache;
  reload(): Promise<SchemaCache>;
}

export const createSchemaStore = async (db: DbAdapter, schemas: ReadonlyArray<string>): Promise<SchemaStore> => {
  const load = () =>
    introspect(db, schemas).catch((cause: unknown) => {
      throw new SchemaLoadError(cause);
    });
  let cache = await load();
  let queue: Promise<unknown> = Promise.resolve();
  return {
    current: () => cache,
    reload() {
      const run = queue.then(async () => {
        try {
          cache = await load();
          return cache;
        } catch (e) {
          console.warn("pg-rest: schema cache reload failed, keeping the previous cache", (e as SchemaLoadError).cause);
          throw e;
        }
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };
};
