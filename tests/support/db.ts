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

/** True when the test server has the PostGIS extension available. */
export const hasPostgis: boolean = await (async () => {
  if (!ADMIN_URL) return false;
  const admin = new SQL(ADMIN_URL);
  try {
    const rows = await admin.unsafe("SELECT 1 FROM pg_available_extensions WHERE name = 'postgis'");
    return rows.length > 0;
  } catch {
    return false;
  } finally {
    await admin.close();
  }
})();

/**
 * The GeoJSON suites need PostGIS. A database without it is a broken setup, not a reason to pass
 * quietly: skipping is what let nine stale parity differences survive. Fail, and say what to do.
 */
export const requirePostgis = (): void => {
  if (hasPostgis) return;
  throw new Error(
    "PostGIS is not available on TEST_DATABASE_URL, so the GeoJSON cases cannot run.\n" +
      "Point TEST_DATABASE_URL at a Postgres 16 that has PostGIS available (CI uses postgis/postgis:16-3.4).",
  );
};
