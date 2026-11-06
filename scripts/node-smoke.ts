// Runs the *built* library on Node.js with node-postgres:
//   bun run build && node scripts/node-smoke.ts      (Node >= 22.18 strips types natively)
// Needs TEST_DATABASE_URL (a superuser URL of a throwaway server).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { createPgRest } from "../dist/index.js";
import { nodePostgresAdapter } from "../dist/adapters/node-postgres.js";

const admin = process.env["TEST_DATABASE_URL"];
if (!admin) throw new Error("TEST_DATABASE_URL is not set");

const name = `pgrest_node_${process.pid}_${Date.now()}`;
const adminPool = new pg.Pool({ connectionString: admin });
await adminPool.query(`CREATE DATABASE ${name}`);
const url = new URL(admin);
url.pathname = `/${name}`;
const pool = new pg.Pool({ connectionString: url.toString() });

try {
  await pool.query(readFileSync(new URL("../tests/support/fixture.sql", import.meta.url), "utf8"));
  const api = await createPgRest({
    db: nodePostgresAdapter(pool as never),
    schemas: ["api"],
    resolveContext: (req) => {
      const sub = req.headers.get("x-user");
      return sub ? { role: "authenticated", claims: { sub } } : undefined;
    },
  });
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await api.handle(new Request(`http://localhost${path}`, init));
    return { status: res.status, body: await res.json().catch(() => null) as any, headers: res.headers };
  };
  const json = { "Content-Type": "application/json" };

  // read + embed
  const read = await call("/clients?select=name,orders(status)&order=id&limit=2");
  assert.equal(read.status, 200);
  assert.equal(read.body[0].name, "Ada");
  assert.equal(read.body[0].orders.length, 2);

  // driver errors are mapped by SQLSTATE: unique violation -> 409, missing privilege -> 401
  const dup = await call("/clients", { method: "POST", headers: { ...json, "x-user": "u1" }, body: JSON.stringify({ name: "Dup", email: "ada@example.com" }) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "23505");
  const denied = await call("/clients", { method: "POST", headers: json, body: JSON.stringify({ name: "x" }) });
  assert.equal(denied.status, 401);
  assert.equal(denied.body.code, "42501");

  // RLS through the resolved context + transactions that commit and roll back
  const note = await call("/notes?select=body", { method: "POST", headers: { ...json, "x-user": "alice", Prefer: "return=representation" }, body: JSON.stringify({ body: "hi" }) });
  assert.equal(note.status, 201);
  assert.deepEqual((await call("/notes?select=body", { headers: { "x-user": "alice" } })).body, [{ body: "hi" }]);
  assert.deepEqual((await call("/notes?select=body", { headers: { "x-user": "bob" } })).body, []);
  const bad = await call("/clients", { method: "POST", headers: { ...json, "x-user": "u1" }, body: JSON.stringify([{ name: "Fine", email: "fine@x" }, { name: "Dup", email: "ada@example.com" }]) });
  assert.equal(bad.status, 409);
  assert.equal((await call("/clients?select=id&email=eq.fine@x")).body.length, 0);

  // query(): the same plumbing, without an HTTP request
  const rows = await api.query({ table: "clients", select: ["name"], order: ["id"], limit: 1 });
  assert.deepEqual(rows.data, [{ name: "Ada" }]);
  assert.deepEqual(
    (await api.query({ table: "notes", select: ["body"] }, { role: "authenticated", claims: { sub: "alice" } })).data,
    [{ body: "hi" }],
  );
  const failed: any = await api.query({ table: "cients" });
  assert.equal(failed.data, null);
  assert.equal(failed.status, 404);
  assert.equal(failed.error.body.code, "PGRST205");
  assert.equal(failed.error.input.table, "cients");
  assert.equal(rows.error, null);

  // generateTypes, both ways: the method (which loads the generator on demand, from the built
  // chunk) and the standalone subpath. The generated module is plain text, with no imports.
  const generated = await api.generateTypes({ name: "Db" });
  assert.match(generated, /export type Db = \{/);
  assert.match(generated, /name: string;/);
  const { generateTypes } = await import("../dist/types.js");
  assert.equal(generateTypes(await api.schemaCache(), { name: "Db" }), generated);

  // RPC + OpenAPI
  assert.equal((await call("/rpc/add?a=40&b=2")).body, 42);
  assert.equal((await call("/")).body.swagger, "2.0");

  await api.close();
  console.log(`node ${process.version}: ok`);
} finally {
  await pool.end();
  await adminPool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await adminPool.end();
}
