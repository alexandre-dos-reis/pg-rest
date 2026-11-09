import { SQL } from "bun";
import { bunSqlAdapter } from "../../packages/adapters/src/bun";
import type { DbAdapter } from "../../packages/adapters/src";

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

/**
 * Replaying fixture.sql costs about 250 ms, most of it `CREATE EXTENSION postgis`, and some suites
 * want a pristine database per *test* -- `write.test.ts` creates fifty of them. So it is loaded once
 * into a template, and every test database is a copy of it: about 30 ms.
 *
 * The template is named after a hash of the fixture, so it survives between runs and a change to
 * the schema builds a new one; the stale ones are dropped on the way.
 */
const templateName = `pgrest_template_${Bun.hash(fixture).toString(16)}`;
let templateReady: Promise<void> | undefined;

const ensureTemplate = (admin: SQL): Promise<void> =>
  (templateReady ??= (async () => {
    const existing = await admin.unsafe(`SELECT datname FROM pg_database WHERE datname LIKE 'pgrest_template_%'`);
    for (const row of existing as Array<{ datname: string }>) {
      if (row.datname !== templateName) await admin.unsafe(`DROP DATABASE IF EXISTS ${row.datname} WITH (FORCE)`);
    }
    if (existing.some((r: { datname: string }) => r.datname === templateName)) return;
    await admin.unsafe(`CREATE DATABASE ${templateName}`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${templateName}`;
    const sql = new SQL(url.toString());
    try {
      await sql.unsafe(fixture);
    } finally {
      // nothing may be connected to a database used as a template
      await sql.close();
    }
  })());

/** Create a fresh database from fixture.sql (isolated per test file, or per test). */
export const createTestDb = async (): Promise<TestDb> => {
  if (!ADMIN_URL) throw new Error("TEST_DATABASE_URL is not set");
  const name = `pgrest_test_${process.pid}_${Date.now()}_${counter++}`;
  const admin = new SQL(ADMIN_URL);
  await ensureTemplate(admin);
  await admin.unsafe(`CREATE DATABASE ${name} TEMPLATE ${templateName}`);
  await admin.close();

  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  const sql = new SQL(url.toString());
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
      "Point TEST_DATABASE_URL at a Postgres 16 that has PostGIS available (`mise run db:start`, or postgis/postgis:16-3.6 as CI does).",
  );
};
