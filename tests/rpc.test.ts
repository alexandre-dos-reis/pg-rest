import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { authed, makeApi, type TestApi } from "./support/api";

describe.skipIf(!hasDb)("rpc", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  test("scalar result via POST (JSON body) and GET (query string)", async () => {
    const post = await t.post("/rpc/add", { a: 2, b: 3 });
    expect(post.status).toBe(200);
    expect(post.json()).toBe(5);
    expect((await t.get("/rpc/add?a=40&b=2")).json()).toBe(42);
    expect((await t.get("/rpc/hello")).json()).toBe("hello");
    expect((await t.post("/rpc/hello", {})).json()).toBe("hello");
  });

  test("default arguments", async () => {
    expect((await t.get("/rpc/greet")).json()).toBe("hello world");
    expect((await t.get("/rpc/greet?name=Ada")).json()).toBe("hello Ada");
    expect((await t.post("/rpc/greet", { name: "Bob" })).json()).toBe("hello Bob");
  });

  test("arguments are typed from the function signature", async () => {
    expect((await t.post("/rpc/add", { a: "7", b: "8" })).json()).toBe(15);
    const bad = await t.post("/rpc/add", { a: "x", b: 1 });
    expect(bad.status).toBe(400);
  });

  test("set of composite rows supports select, filters, order and paging", async () => {
    const r = await t.get("/rpc/orders_by_status?s=paid&select=id,total&order=id.desc");
    expect(r.json()).toEqual([{ id: 3, total: 99.99 }, { id: 1, total: 250 }]);
    expect((await t.get("/rpc/orders_by_status?s=paid&total=gt.100&select=id")).json()).toEqual([{ id: 1 }]);
    expect((await t.get("/rpc/orders_by_status?s=paid&order=id&limit=1&offset=1&select=id")).json()).toEqual([{ id: 3 }]);
    const counted = await t.get("/rpc/orders_by_status?s=paid&limit=1", { headers: { Prefer: "count=exact" } });
    expect(counted.status).toBe(206);
    expect(counted.headers.get("content-range")).toBe("0-0/2");
  });

  test("results of a table type can embed", async () => {
    const r = await t.get("/rpc/orders_by_status?s=shipped&select=id,clients(name),products(name)");
    expect(r.json()[0].clients).toEqual({ name: "Grace" });
    expect(r.json()[0].products.map((p: any) => p.name).sort()).toEqual(["Keyboard", "Monitor"]);
  });

  test("RETURNS TABLE", async () => {
    const r = await t.post("/rpc/client_summary", { cid: 1 });
    expect(r.json()).toEqual([{ client_id: 1, order_count: 2, revenue: 290.5 }]);
    expect((await t.get("/rpc/client_summary?cid=1&select=revenue")).json()).toEqual([{ revenue: 290.5 }]);
  });

  test("set of scalars is an array of values", async () => {
    expect((await t.get("/rpc/nums")).json()).toEqual([1, 2, 3]);
  });

  test("a single composite row is an object", async () => {
    const r = await t.get("/rpc/first_client?select=id,name");
    expect(r.json()).toEqual({ id: 1, name: "Ada" });
  });

  test("void functions return 204", async () => {
    const r = await t.post("/rpc/nothing", {});
    expect(r.status).toBe(204);
    expect(r.text).toBe("");
  });

  test("a single unnamed json parameter receives the whole body", async () => {
    const body = [{ a: 1 }, { a: [1, 2, 3] }];
    const r = await t.post("/rpc/echo_unnamed", body);
    expect(r.json()).toEqual(body);
    // like PostgREST, the objects of an array body must agree on their keys
    const mismatch = await t.post("/rpc/echo_unnamed", [{ a: 1 }, { b: 2 }]);
    expect(mismatch.status).toBe(400);
    expect(mismatch.json().code).toBe("PGRST102");
    expect((await t.post("/rpc/echo_unnamed", "just a string", { headers: { "Content-Type": "application/json" } })).status).toBe(400);
    expect((await t.post("/rpc/echo_json", { body: { k: "v" } })).json()).toEqual({ k: "v" });
  });

  test("unknown functions and arguments are PGRST202", async () => {
    const missing = await t.post("/rpc/nope", {});
    expect(missing.status).toBe(404);
    expect(missing.json().code).toBe("PGRST202");
    const badArg = await t.post("/rpc/add", { a: 1, b: 2, c: 3 });
    expect(badArg.status).toBe(404);
    expect(badArg.json().code).toBe("PGRST202");
    expect(badArg.json().message).toBe("Could not find the function api.add(a, b, c) in the schema cache");
    expect((await t.post("/rpc/add", { a: 1 })).json().code).toBe("PGRST202");
  });

  test("overloads are resolved by argument names, ambiguity is PGRST203", async () => {
    const r = await t.post("/rpc/ovl", { a: 1 });
    expect(r.status).toBe(300);
    expect(r.json().code).toBe("PGRST203");
  });

  test("only GET and POST are allowed (PGRST101)", async () => {
    for (const m of ["PUT", "PATCH", "DELETE"]) {
      const r = await t.call(m, "/rpc/add", { body: { a: 1, b: 2 } });
      expect(r.status).toBe(405);
      expect(r.json().code).toBe("PGRST101");
    }
  });

  test("GET runs in a read-only transaction, POST may write", async () => {
    const get = await t.get("/rpc/add_note?txt=hi", { ctx: authed() });
    expect(get.status).toBe(405);
    expect(get.json().code).toBe("25006");
    const post = await t.post("/rpc/add_note", { txt: "hi" }, { ctx: authed("alice") });
    expect(post.status).toBe(200);
    expect(typeof post.json()).toBe("number");
  });

  test("RAISE ... ERRCODE 'PTxyz' sets the status, message, detail and hint", async () => {
    const r = await t.post("/rpc/boom", {});
    expect(r.status).toBe(418);
    expect(r.json()).toEqual({ code: "PT418", message: "teapot", details: "tip me over", hint: "short and stout" });
  });

  test("functions can set response headers and status", async () => {
    const r = await t.post("/rpc/with_headers", {});
    expect(r.status).toBe(202);
    expect(r.headers.get("x-custom")).toBe("yes");
    expect(r.json()).toBe("accepted");
  });

  test("max-affected needs a set-returning function (PGRST128) and is enforced for sets", async () => {
    const scalar = await t.post("/rpc/add", { a: 1, b: 2 }, { headers: { Prefer: "handling=strict, max-affected=1" } });
    expect(scalar.status).toBe(400);
    expect(scalar.json().code).toBe("PGRST128");
    const set = await t.post("/rpc/orders_by_status", { s: "paid" }, { headers: { Prefer: "handling=strict, max-affected=1" } });
    expect(set.json().code).toBe("PGRST124");
    expect((await t.post("/rpc/orders_by_status", { s: "shipped" }, { headers: { Prefer: "handling=strict, max-affected=1" } })).status).toBe(200);
  });

  test("singular object response for set-returning functions", async () => {
    const one = await t.get("/rpc/orders_by_status?s=shipped&select=id", { headers: { Accept: "application/vnd.pgrst.object+json" } });
    expect(one.json()).toEqual({ id: 4 });
    const many = await t.get("/rpc/orders_by_status?s=paid", { headers: { Accept: "application/vnd.pgrst.object+json" } });
    expect(many.status).toBe(406);
  });

  test("RPC results follow the same Accept rules (csv)", async () => {
    const r = await t.get("/rpc/orders_by_status?s=paid&select=id,status&order=id", { headers: { Accept: "text/csv" } });
    expect(r.text).toBe("id,status\n1,paid\n3,paid");
  });

  test("functions in other exposed schemas via Content-Profile / Accept-Profile", async () => {
    await t.db.adapter.query("CREATE FUNCTION v2.where_am_i() RETURNS text LANGUAGE sql AS $$ SELECT 'v2' $$");
    await t.api.reloadSchema();
    expect((await t.get("/rpc/where_am_i", { headers: { "Accept-Profile": "v2" } })).json()).toBe("v2");
    expect((await t.post("/rpc/where_am_i", {}, { headers: { "Content-Profile": "v2" } })).json()).toBe("v2");
    expect((await t.get("/rpc/where_am_i")).status).toBe(404);
  });
});
