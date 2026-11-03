import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { makeApi, type TestApi } from "./support/api";

const PAYLOADS = [
  "1; DROP TABLE api.clients; --",
  "' OR '1'='1",
  "x') OR 1=1 --",
  "\\'; DELETE FROM api.clients; --",
  "1) UNION SELECT rolname FROM pg_roles --",
  "$$; DROP TABLE api.clients; $$",
];

describe.skipIf(!hasDb)("hostile input", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  const intact = async () => {
    const rows = await t.db.adapter.query("SELECT count(*)::int AS n FROM api.clients");
    expect(rows[0]!["n"]).toBeGreaterThan(0);
  };

  test("filter values are data, never SQL", async () => {
    for (const p of PAYLOADS) {
      for (const op of ["eq", "neq", "like", "ilike", "gt", "in", "cs", "fts", "match", "is"]) {
        const v = op === "in" ? `(${p})` : p;
        const r = await t.get(`/clients?select=id&name=${op}.${encodeURIComponent(v)}`);
        expect(r.status).toBeLessThan(500);
      }
      const r = await t.get(`/clients?select=id&name=eq.${encodeURIComponent(p)}`);
      expect(r.json()).toEqual([]);
    }
    await intact();
  });

  test("identifiers in select, order, filters and columns are quoted or rejected", async () => {
    for (const p of PAYLOADS) {
      const q = encodeURIComponent(p);
      for (const path of [
        `/clients?select=${q}`,
        `/clients?select=id::${q}`,
        `/clients?order=${q}`,
        `/clients?${q}=eq.1`,
        `/clients?select=id,orders!${q}(id)`,
        `/clients?select=id&or=(${q})`,
        `/${q}`,
        `/rpc/${q}`,
      ]) {
        const r = await t.get(path);
        expect(r.status).toBeGreaterThanOrEqual(400);
        expect(r.status).toBeLessThan(500);
      }
    }
    await intact();
  });

  test("casts only accept plain type names", async () => {
    for (const bad of ["int4 from users", "text); select 1; --", "int4,pg_sleep(10)", "int[];drop"]) {
      const r = await t.get(`/clients?select=id::${encodeURIComponent(bad)}`);
      expect(r.status).toBe(400);
    }
    expect((await t.get("/clients?select=id::text&limit=1")).status).toBe(200);
  });

  test("write payloads and conflict targets", async () => {
    for (const p of PAYLOADS) {
      const ins = await t.post("/notes", { [p]: 1 });
      expect(ins.status).toBe(400);
      const up = await t.post(`/clients?on_conflict=${encodeURIComponent(p)}`, { name: p }, { headers: { Prefer: "resolution=merge-duplicates" } });
      expect(up.status).toBe(400);
      const cols = await t.post(`/clients?columns=${encodeURIComponent(p)}`, { name: p });
      expect(cols.status).toBe(400);
    }
    await intact();
  });

  test("a string with quotes round-trips unchanged", async () => {
    const name = `O'Brien "the" \\ ; -- $$ x`;
    const created = await t.post("/clients", { name }, { headers: { Prefer: "return=representation" }, ctx: { role: "authenticated" } });
    expect(created.status).toBe(201);
    expect(created.json()[0].name).toBe(name);
    const found = await t.get(`/clients?select=name&name=eq.${encodeURIComponent(name)}`);
    expect(found.json()).toEqual([{ name }]);
    await t.db.adapter.query("DELETE FROM api.clients WHERE name = $1::text", [name]);
  });

  test("NUL bytes are rejected, not forwarded", async () => {
    const r = await t.get(`/clients?name=eq.${encodeURIComponent("a\u0000b")}`);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  test("rpc arguments and headers are data", async () => {
    for (const p of PAYLOADS) {
      const r = await t.post("/rpc/greet", { name: p });
      expect(r.json()).toBe(`hello ${p}`);
      const h = await t.get("/rpc/req_info", { headers: { "X-Test": p } });
      expect(h.json().header).toBe(p);
      const c = await t.get("/rpc/req_info", { headers: { Cookie: `sid=${encodeURIComponent(p)}` } });
      expect(c.json().cookie).toBe(p);
    }
    await intact();
  });

  test("roles and settings cannot inject SQL", async () => {
    for (const p of PAYLOADS) {
      const r = await t.get("/clients", { ctx: { role: p } });
      expect(r.status).toBeGreaterThanOrEqual(400);
      const s = await t.get("/clients", { ctx: { settings: { [`a.${p}`]: "x" } } });
      expect(s.status).toBeGreaterThanOrEqual(400);
      const v = await t.get("/rpc/whoami", { ctx: { settings: { "app.tenant": p } } });
      expect(v.json().tenant).toBe(p);
    }
    await intact();
  });

  test("profile headers only select exposed schemas", async () => {
    const r = await t.get("/clients", { headers: { "Accept-Profile": "pg_catalog" } });
    expect(r.status).toBe(406);
    expect(r.json().code).toBe("PGRST106");
  });

  test("a read cannot modify data (read-only transaction)", async () => {
    const r = await t.get("/rpc/add_note?txt=x");
    expect(r.status).toBe(405);
  });
});
