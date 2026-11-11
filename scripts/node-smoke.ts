// Runs the *built* library on Node.js with node-postgres:
//   bun run build && node scripts/node-smoke.ts      (Node >= 22.18 strips types natively)
// Needs TEST_DATABASE_URL (a superuser URL of a throwaway server).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import pg from "pg";
import { createRest } from "../packages/rest/dist/index.js";
import { createQuery } from "../packages/query/dist/index.js";
import { nodePostgresAdapter } from "../packages/rest/dist/adapters/node-postgres.js";

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
  const options = {
    db: nodePostgresAdapter(pool as never),
    schemas: ["api"],
    // two instances over one pool, and the script ends it itself in `finally`
    onClose: () => {},
    resolveContext: (req: Request) => {
      const sub = req.headers.get("x-user");
      return sub ? { role: "authenticated", claims: { sub } } : undefined;
    },
  };
  // the two packages, each built on its own: an app that uses both creates both
  const rest = await createRest(options);
  // query runs on a generated descriptor: the catalog is read here, at "build time", by the built
  // generator -- one call on the same options, which is all a generator script does
  const { generateModule, generateSchema } = await import("../packages/query/dist/types.js");
  const schemaModule = await generateSchema(options);
  const schema = JSON.parse(schemaModule.slice(schemaModule.indexOf("= ") + 2, schemaModule.lastIndexOf(";")));
  const { schemas: _schemas, ...queryOptions } = options;
  const api = { ...createQuery({ ...queryOptions, schema }), handle: rest.handle };
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
  const rows = await api.select({ table: "clients", columns: ["name"], order: ["id"], limit: 1 });
  assert.deepEqual(rows.data, [{ name: "Ada" }]);
  assert.deepEqual(
    (await api.select({ table: "notes", columns: ["body"] }, { role: "authenticated", claims: { sub: "alice" } })).data,
    [{ body: "hi" }],
  );
  const failed: any = await api.select({ table: "cients" });
  assert.equal(failed.data, null);
  assert.equal(failed.error.kind, "undefined_object");
  assert.equal(failed.error.input.table, "cients");
  assert.equal(rows.error, null);

  // the generator is plain text, with the types and the descriptor in one module
  const generated = await generateModule(options, { name: "Db" });
  assert.match(generated, /export type Db = \{/);
  assert.match(generated, /name: string;/);
  assert.match(generated, /export const schema: SchemaDescriptor = /);

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
