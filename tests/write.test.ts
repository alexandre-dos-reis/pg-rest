import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { authed, makeApi, type TestApi } from "./support/api";

describe.skipIf(!hasDb)("writes", () => {
  let t: TestApi;
  beforeEach(async () => {
    t = await makeApi();
  });
  afterEach(() => t.close());

  const REP = { Prefer: "return=representation" };
  const ctx = authed();
  const count = async (table: string) =>
    Number((await t.db.adapter.query(`SELECT count(*)::int AS n FROM api.${table}`))[0]!["n"]);

  describe("POST", () => {
    test("minimal by default: 201, no body", async () => {
      const r = await t.post("/clients", { name: "Zed" }, { ctx });
      expect(r.status).toBe(201);
      expect(r.text).toBe("");
      expect(r.headers.get("content-range")).toBe("*/*");
      expect(await count("clients")).toBe(4);
    });
    test("return=representation includes defaults", async () => {
      const r = await t.post("/clients", { name: "Zed", tags: ["x"] }, { ctx, headers: REP });
      expect(r.status).toBe(201);
      expect(r.headers.get("preference-applied")).toBe("return=representation");
      const [row] = r.json();
      expect(row).toMatchObject({ id: 4, name: "Zed", email: null, tags: ["x"] });
      expect(row.created_at).toBeTruthy();
    });
    test("bulk insert", async () => {
      const r = await t.post("/clients?select=name", [{ name: "A" }, { name: "B" }, { name: "C" }], {
        ctx,
        headers: REP,
      });
      expect(r.json()).toEqual([{ name: "A" }, { name: "B" }, { name: "C" }]);
      expect(await count("clients")).toBe(6);
    });
    test("return=headers-only sets Location", async () => {
      const r = await t.post("/clients", { name: "Zed" }, { ctx, headers: { Prefer: "return=headers-only" } });
      expect(r.status).toBe(201);
      expect(r.text).toBe("");
      expect(r.headers.get("location")).toBe("/clients?id=eq.4");
    });
    test("Location uses every primary key column", async () => {
      const r = await t.post(
        "/order_items",
        { order_id: 2, product_id: 1, qty: 3 },
        { ctx, headers: { Prefer: "return=headers-only" } },
      );
      expect(r.headers.get("location")).toBe("/order_items?order_id=eq.2&product_id=eq.1");
    });
    test("representation can embed", async () => {
      const r = await t.post("/orders?select=id,clients(name)", { client_id: 2, total: 5 }, { ctx, headers: REP });
      expect(r.json()).toEqual([{ id: 5, clients: { name: "Linus" } }]);
    });
    test("columns= restricts the keys that are used", async () => {
      const r = await t.post("/clients?columns=name", { name: "Zed", email: "ignored@x" }, { ctx, headers: REP });
      expect(r.json()[0]).toMatchObject({ name: "Zed", email: null });
    });
    test("unknown columns are PGRST204", async () => {
      const r = await t.post("/clients", { name: "Zed", nope: 1 }, { ctx });
      expect(r.status).toBe(400);
      expect(r.json().code).toBe("PGRST204");
      expect(r.json().message).toBe("Could not find the 'nope' column of 'clients' in the schema cache");
    });
    test("missing keys are NULL by default and DEFAULT with missing=default", async () => {
      const rows = [{ client_id: 1, status: "paid" }, { client_id: 1 }];
      const mismatch = await t.post("/orders", rows, { ctx });
      expect(mismatch.status).toBe(400);
      expect(mismatch.json().code).toBe("PGRST102");
      const nulls = await t.post("/orders?columns=client_id,status", rows, { ctx });
      expect(nulls.status).toBe(400);
      expect(nulls.json().code).toBe("23502");
      const ok = await t.post("/orders?columns=client_id,status&select=status&order=id", rows, {
        ctx,
        headers: { Prefer: "return=representation, missing=default" },
      });
      expect(ok.status).toBe(201);
      expect(ok.json()).toEqual([{ status: "paid" }, { status: "new" }]);
    });
    test("single objects only touch the keys they contain", async () => {
      const r = await t.post("/orders?select=status,total", { client_id: 1 }, { ctx, headers: REP });
      expect(r.json()).toEqual([{ status: "new", total: 0 }]);
    });
    test("empty object inserts a row of defaults", async () => {
      const r = await t.post("/products", {}, { ctx });
      expect(r.status).toBe(400); // name is NOT NULL, so the defaults are not enough
      expect(r.json().code).toBe("23502");
    });
    test("x-www-form-urlencoded and CSV bodies", async () => {
      const form = await t.post("/clients?select=name", "name=Form+User", {
        ctx,
        headers: { ...REP, "Content-Type": "application/x-www-form-urlencoded" },
      });
      expect(form.json()).toEqual([{ name: "Form User" }]);
      const csv = await t.post("/clients?select=name,email&order=id", 'name,email\nCsv One,one@x\n"Csv, Two",', {
        ctx,
        headers: { ...REP, "Content-Type": "text/csv" },
      });
      expect(csv.json()).toEqual([
        { name: "Csv One", email: "one@x" },
        { name: "Csv, Two", email: null },
      ]);
    });
    test("invalid or empty bodies are PGRST102", async () => {
      expect(
        (await t.post("/clients", "{nope", { ctx, headers: { "Content-Type": "application/json" } })).json().code,
      ).toBe("PGRST102");
      expect((await t.call("POST", "/clients", { ctx })).json().code).toBe("PGRST102");
      expect(
        (await t.post("/clients", "just a string", { ctx, headers: { "Content-Type": "application/json" } })).status,
      ).toBe(400);
      expect((await t.post("/clients", [1, 2], { ctx })).json().code).toBe("PGRST102");
    });
    test("unsupported Content-Type is 415", async () => {
      const r = await t.post("/clients", "x", { ctx, headers: { "Content-Type": "application/xml" } });
      expect(r.status).toBe(415);
      expect(r.json().code).toBe("PGRST107");
    });
    test("constraint violations map to HTTP statuses", async () => {
      const dup = await t.post("/clients", { name: "Ada2", email: "ada@example.com" }, { ctx });
      expect(dup.status).toBe(409);
      expect(dup.json().code).toBe("23505");
      expect(dup.json().details).toContain("already exists");
      const fk = await t.post("/orders", { client_id: 999 }, { ctx });
      expect(fk.status).toBe(409);
      expect(fk.json().code).toBe("23503");
      const nn = await t.post("/clients", { email: "x@x" }, { ctx });
      expect(nn.status).toBe(400);
      expect(nn.json().code).toBe("23502");
    });
    test("anonymous role is rejected with 401, authenticated lacking privilege with 403", async () => {
      expect((await t.post("/clients", { name: "x" })).status).toBe(401);
      expect((await t.post("/clients", { name: "x" })).json().code).toBe("42501");
      await t.db.adapter.query("REVOKE INSERT ON api.clients FROM authenticated");
      expect((await t.post("/clients", { name: "x" }, { ctx })).status).toBe(403);
    });
    test("a failing statement rolls back the whole request", async () => {
      const r = await t.post(
        "/clients",
        [
          { name: "Fine", email: "fine@example.com" },
          { name: "Dup", email: "ada@example.com" },
        ],
        { ctx },
      );
      expect(r.status).toBe(409);
      expect(await count("clients")).toBe(3);
    });
  });

  describe("upsert", () => {
    test("resolution=merge-duplicates on the primary key", async () => {
      const r = await t.post(
        "/clients?select=id,name",
        { id: 1, name: "Ada Lovelace" },
        { ctx, headers: { Prefer: "return=representation, resolution=merge-duplicates" } },
      );
      expect(r.status).toBe(201);
      expect(r.json()).toEqual([{ id: 1, name: "Ada Lovelace" }]);
      expect(await count("clients")).toBe(3);
    });
    test("on_conflict picks another unique column", async () => {
      const r = await t.post(
        "/clients?on_conflict=email&select=id,name",
        [
          { name: "Ada!", email: "ada@example.com" },
          { name: "New", email: "new@example.com" },
        ],
        {
          ctx,
          headers: { Prefer: "return=representation, resolution=merge-duplicates" },
        },
      );
      // (the serial advances even for the row that conflicted, so only check ids loosely)
      expect(r.json().map((x: any) => x.name)).toEqual(["Ada!", "New"]);
      expect(r.json()[0].id).toBe(1);
      expect(await count("clients")).toBe(4);
    });
    test("resolution=ignore-duplicates", async () => {
      const r = await t.post(
        "/clients?on_conflict=email&select=name",
        [
          { name: "Changed", email: "ada@example.com" },
          { name: "Fresh", email: "fresh@example.com" },
        ],
        {
          ctx,
          headers: { Prefer: "return=representation, resolution=ignore-duplicates" },
        },
      );
      expect(r.json()).toEqual([{ name: "Fresh" }]);
      expect((await t.get("/clients?id=eq.1&select=name")).json()).toEqual([{ name: "Ada" }]);
    });
    test("merging without a conflict target on a table with no key is PGRST100", async () => {
      await t.db.adapter.query("CREATE TABLE api.nokey (a int, b int); GRANT ALL ON api.nokey TO authenticated");
      await t.api.reloadSchema();
      const r = await t.post("/nokey", { a: 1 }, { ctx, headers: { Prefer: "resolution=merge-duplicates" } });
      expect(r.status).toBe(400);
      expect(r.json().code).toBe("PGRST100");
    });
  });

  describe("PATCH", () => {
    test("updates the matching rows and returns them", async () => {
      const r = await t.patch("/orders?status=eq.paid&select=id,status", { status: "shipped" }, { ctx, headers: REP });
      expect(r.status).toBe(200);
      expect(r.json()).toEqual([
        { id: 1, status: "shipped" },
        { id: 3, status: "shipped" },
      ]);
      expect(r.headers.get("content-range")).toBe("0-1/*");
    });
    test("minimal is 204 and only the named columns change", async () => {
      const r = await t.patch("/clients?id=eq.1", { email: "new@example.com" }, { ctx });
      expect(r.status).toBe(204);
      expect(r.text).toBe("");
      expect((await t.get("/clients?id=eq.1&select=name,email")).json()).toEqual([
        { name: "Ada", email: "new@example.com" },
      ]);
    });
    test("null clears a column", async () => {
      await t.patch("/clients?id=eq.1", { email: null }, { ctx });
      expect((await t.get("/clients?id=eq.1&select=email")).json()).toEqual([{ email: null }]);
    });
    test("count=exact reports the affected rows", async () => {
      const r = await t.patch("/orders?status=eq.paid", { status: "x" }, { ctx, headers: { Prefer: "count=exact" } });
      expect(r.headers.get("content-range")).toBe("0-1/2");
    });
    test("logic filters and embedded select on the result", async () => {
      const r = await t.patch(
        "/orders?or=(id.eq.1,id.eq.2)&select=id,clients(name)&order=id",
        { status: "x" },
        { ctx, headers: REP },
      );
      expect(r.json()).toEqual([
        { id: 1, clients: { name: "Ada" } },
        { id: 2, clients: { name: "Ada" } },
      ]);
    });
    test("no matching rows", async () => {
      expect((await t.patch("/orders?id=eq.99", { status: "x" }, { ctx })).status).toBe(204);
      const r = await t.patch("/orders?id=eq.99", { status: "x" }, { ctx, headers: REP });
      expect(r.status).toBe(200);
      expect(r.json()).toEqual([]);
    });
    test("an empty object changes nothing", async () => {
      expect((await t.patch("/orders?id=eq.1", {}, { ctx })).status).toBe(204);
      const r = await t.patch("/orders?id=eq.1", {}, { ctx, headers: REP });
      expect(r.json()).toEqual([]);
    });
    test("bad payloads", async () => {
      expect((await t.patch("/orders", [{ status: "x" }], { ctx })).json().code).toBe("PGRST102");
      expect((await t.patch("/orders", { nope: 1 }, { ctx })).json().code).toBe("PGRST204");
      expect((await t.call("PATCH", "/orders", { ctx })).json().code).toBe("PGRST102");
    });
    test("limit and offset are not supported on writes", async () => {
      const r = await t.patch("/orders?limit=1", { status: "x" }, { ctx });
      expect(r.status).toBe(400);
      expect(r.json().code).toBe("PGRST100");
    });
    test("views that are not updatable fail in the database (class 55 is a 500, like PostgREST)", async () => {
      const r = await t.patch("/client_totals", { revenue: 1 }, { ctx });
      expect(r.status).toBe(500);
      expect(r.json().code).toBe("55000");
    });
  });

  describe("DELETE", () => {
    test("deletes matching rows", async () => {
      const r = await t.del("/order_items?order_id=eq.1", { ctx });
      expect(r.status).toBe(204);
      expect(await count("order_items")).toBe(3);
    });
    test("return=representation", async () => {
      const r = await t.del("/order_items?order_id=eq.1&select=product_id&order=product_id", { ctx, headers: REP });
      expect(r.status).toBe(200);
      expect(r.json()).toEqual([{ product_id: 1 }, { product_id: 2 }]);
    });
    test("foreign keys still apply", async () => {
      const r = await t.del("/clients?id=eq.1", { ctx });
      expect(r.status).toBe(409);
      expect(r.json().code).toBe("23503");
    });
    test("anon cannot delete", async () => {
      expect((await t.del("/order_items?order_id=eq.1")).status).toBe(401);
    });
  });

  describe("PUT", () => {
    test("creates, then replaces, the row addressed by its primary key", async () => {
      const created = await t.put("/products?id=eq.10", { name: "Cable", price: 5 }, { ctx, headers: REP });
      expect(created.status).toBe(200);
      expect(created.json()).toEqual([{ id: 10, name: "Cable", price: 5 }]);
      const replaced = await t.put("/products?id=eq.10", { id: 10, name: "Long cable", price: 9 }, { ctx });
      expect(replaced.status).toBe(204);
      expect((await t.get("/products?id=eq.10")).json()).toEqual([{ id: 10, name: "Long cable", price: 9 }]);
    });
    test("composite primary keys", async () => {
      const r = await t.put("/order_items?order_id=eq.2&product_id=eq.3", { qty: 7 }, { ctx, headers: REP });
      expect(r.json()).toEqual([{ order_id: 2, product_id: 3, qty: 7 }]);
    });
    test("the body and query string must agree (PGRST115)", async () => {
      const r = await t.put("/products?id=eq.10", { id: 11, name: "x", price: 1 }, { ctx });
      expect(r.status).toBe(400);
      expect(r.json().code).toBe("PGRST115");
    });
    test("needs an equality filter on every key column (PGRST105)", async () => {
      for (const path of ["/products", "/products?id=gt.1", "/products?name=eq.x", "/order_items?order_id=eq.1"]) {
        const r = await t.put(path, { name: "x", price: 1 }, { ctx });
        expect(r.status).toBe(405);
        expect(r.json().code).toBe("PGRST105");
      }
    });
    test("limit / offset are PGRST114", async () => {
      expect((await t.put("/products?id=eq.10&limit=1", { name: "x", price: 1 }, { ctx })).json().code).toBe(
        "PGRST114",
      );
    });
  });

  describe("preferences", () => {
    test("max-affected is enforced with handling=strict and rolls back", async () => {
      const r = await t.patch(
        "/orders?status=in.(paid,new)",
        { status: "x" },
        { ctx, headers: { Prefer: "handling=strict, max-affected=1" } },
      );
      expect(r.status).toBe(400);
      expect(r.json().code).toBe("PGRST124");
      expect(r.json().details).toBe("The query affects 3 rows");
      expect((await t.get("/orders?status=eq.x")).json()).toEqual([]);
      const ok = await t.patch(
        "/orders?id=eq.1",
        { status: "x" },
        { ctx, headers: { Prefer: "handling=strict, max-affected=1" } },
      );
      expect(ok.status).toBe(204);
      expect(ok.headers.get("preference-applied")).toBe("handling=strict, max-affected=1");
    });
    test("max-affected is ignored with lenient handling", async () => {
      const r = await t.del("/order_items", { ctx, headers: { Prefer: "max-affected=1" } });
      expect(r.status).toBe(204);
      expect(await count("order_items")).toBe(0);
    });
    test("invalid preferences are PGRST122 when strict, ignored otherwise", async () => {
      const strict = await t.get("/clients", { headers: { Prefer: "handling=strict, return=wat" } });
      expect(strict.status).toBe(400);
      expect(strict.json().code).toBe("PGRST122");
      expect(strict.json().details).toBe("Invalid preferences: return=wat");
      expect((await t.get("/clients", { headers: { Prefer: "return=wat" } })).status).toBe(200);
    });
    test("tx=rollback needs allowTxOverride", async () => {
      const off = await t.post("/clients", { name: "Stays" }, { ctx, headers: { Prefer: "tx=rollback" } });
      expect(off.status).toBe(201);
      expect(off.headers.get("preference-applied")).toBeNull();
      expect(await count("clients")).toBe(4);
      const strict = await t.post(
        "/clients",
        { name: "x" },
        { ctx, headers: { Prefer: "handling=strict, tx=rollback" } },
      );
      expect(strict.json().code).toBe("PGRST122");

      const on = await makeApi({ allowTxOverride: true });
      try {
        const r = await on.post(
          "/clients",
          { name: "Gone" },
          { ctx, headers: { Prefer: "return=representation, tx=rollback" } },
        );
        expect(r.status).toBe(201);
        expect(r.json()[0].name).toBe("Gone");
        expect(r.headers.get("preference-applied")).toBe("tx=rollback, return=representation");
        expect((await on.get("/clients?name=eq.Gone")).json()).toEqual([]);
        const commit = await on.post("/clients", { name: "Kept" }, { ctx, headers: { Prefer: "tx=commit" } });
        expect(commit.status).toBe(201);
        expect((await on.get("/clients?name=eq.Kept")).json()).toHaveLength(1);
      } finally {
        await on.close();
      }
    });
    test("a singular response that is not exactly one row rolls the write back", async () => {
      const r = await t.post("/clients", [{ name: "P" }, { name: "Q" }], {
        ctx,
        headers: { ...REP, Accept: "application/vnd.pgrst.object+json" },
      });
      expect(r.status).toBe(406);
      expect(r.json().code).toBe("PGRST116");
      expect(await count("clients")).toBe(3);
      const one = await t.post(
        "/clients",
        { name: "Solo" },
        { ctx, headers: { ...REP, Accept: "application/vnd.pgrst.object+json" } },
      );
      expect(one.status).toBe(201);
      expect(one.json().name).toBe("Solo");
    });
    test("timezone", async () => {
      const r = await t.get("/rpc/req_info", { headers: { Prefer: "timezone=America/New_York" } });
      expect(r.json().tz).toBe("America/New_York");
      expect(r.headers.get("preference-applied")).toBe("timezone=America/New_York");
      const bad = await t.get("/rpc/req_info", { headers: { Prefer: "timezone=Not/AZone" } });
      expect(bad.status).toBe(400);
    });
  });

  describe("row level security", () => {
    test("users only see and change their own rows", async () => {
      const alice = authed("alice");
      const bob = authed("bob");
      await t.post("/notes", { body: "alice's note" }, { ctx: alice });
      await t.post("/notes", { body: "bob's note" }, { ctx: bob });
      expect((await t.get("/notes?select=owner,body", { ctx: alice })).json()).toEqual([
        { owner: "alice", body: "alice's note" },
      ]);
      expect((await t.get("/notes?select=owner", { ctx: bob })).json()).toEqual([{ owner: "bob" }]);

      // bob cannot update or delete alice's note: it is invisible to him
      const upd = await t.patch("/notes?owner=eq.alice", { body: "hacked" }, { ctx: bob, headers: REP });
      expect(upd.json()).toEqual([]);
      const del = await t.del("/notes?owner=eq.alice", { ctx: bob, headers: REP });
      expect(del.json()).toEqual([]);
      expect((await t.get("/notes?select=body&owner=eq.alice", { ctx: alice })).json()).toEqual([
        { body: "alice's note" },
      ]);
    });
    test("WITH CHECK stops a user writing rows for someone else", async () => {
      const r = await t.post("/notes", { owner: "alice", body: "forged" }, { ctx: authed("bob") });
      expect(r.status).toBe(403);
      expect(r.json().code).toBe("42501");
    });
    test("the anonymous role can read the table but RLS shows it nothing", async () => {
      await t.post("/notes", { body: "private" }, { ctx: authed("alice") });
      const r = await t.get("/notes");
      expect(r.status).toBe(200);
      expect(r.json()).toEqual([]);
      await t.db.adapter.query("REVOKE SELECT ON api.notes FROM anon");
      expect((await t.get("/notes")).status).toBe(401);
    });
  });
});
