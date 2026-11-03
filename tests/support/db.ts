import { SQL } from "bun";
import { bunSqlAdapter } from "../../src/adapters/bun";
import type { DbAdapter } from "../../src/adapter";

/** Superuser URL of a throwaway Postgres server. Integration tests are skipped without it. */
export const ADMIN_URL = process.env["TEST_DATABASE_URL"];
export const hasDb = Boolean(ADMIN_URL);

const fixture = await Bun.file(new URL("./fixture.sql", import.meta.url)).text();

export interface TestDb {
  readonly url: string;
  readonly adapter: DbAdapter;
  drop(): Promise<void>;
}

let counter = 0;

/** Create a fresh database from fixture.sql (isolated per test file). */
export const createTestDb = async (): Promise<TestDb> => {
  if (!ADMIN_URL) throw new Error("TEST_DATABASE_URL is not set");
  const name = `pgrest_test_${process.pid}_${Date.now()}_${counter++}`;
  const admin = new SQL(ADMIN_URL);
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.close();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const sql = new SQL(url.toString());
  await sql.unsafe(fixture);
  const adapter = bunSqlAdapter(sql);

  return {
    url: url.toString(),
    adapter,
    async drop() {
      await sql.close();
      const a = new SQL(ADMIN_URL);
      await a.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await a.close();
    },
  };
};
