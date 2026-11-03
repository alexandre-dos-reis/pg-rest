import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { makeApi, type TestApi } from "./support/api";

describe.skipIf(!hasDb)("reads", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  const names = async (path: string) => (await t.get(path)).json<Array<{ name: string }>>().map((r) => r.name);

  describe("select", () => {
    test("all columns by default, selected columns, alias, cast", async () => {
      const all = (await t.get("/clients?id=eq.1")).json();
      expect(Object.keys(all[0]).sort()).toEqual(["created_at", "email", "id", "meta", "name", "tags"]);
      expect((await t.get("/clients?select=name&id=eq.1")).json()).toEqual([{ name: "Ada" }]);
      expect((await t.get("/clients?select=who:name&id=eq.1")).json()).toEqual([{ who: "Ada" }]);
      expect((await t.get("/orders?select=total::text&id=eq.1")).json()).toEqual([{ total: "250.00" }]);
      expect((await t.get("/orders?select=cents:total::int&id=eq.1")).json()).toEqual([{ cents: 250 }]);
    });
    test("JSON paths", async () => {
      const r = (await t.get("/clients?select=name,tier:meta->>tier,city:meta->address->>city&order=id")).json();
      expect(r).toEqual([
        { name: "Ada", tier: "gold", city: "London" },
        { name: "Linus", tier: "silver", city: null },
        { name: "Grace", tier: null, city: null },
      ]);
    });
    test("aggregates with implicit GROUP BY", async () => {
      expect((await t.get("/orders?select=count()")).json()).toEqual([{ count: 4 }]);
      const r = (await t.get("/orders?select=status,total.sum(),n:count()&order=status")).json();
      expect(r).toEqual([
        { status: "new", sum: 40.5, n: 1 },
        { status: "paid", sum: 349.99, n: 2 },
        { status: "shipped", sum: 500, n: 1 },
      ]);
    });
  });

  describe("filters", () => {
    test("comparison operators", async () => {
      expect(await names("/clients?id=eq.2")).toEqual(["Linus"]);
      expect(await names("/clients?id=neq.2&order=id")).toEqual(["Ada", "Grace"]);
      expect(await names("/clients?id=gt.1&order=id")).toEqual(["Linus", "Grace"]);
      expect(await names("/clients?id=gte.2&order=id")).toEqual(["Linus", "Grace"]);
      expect(await names("/clients?id=lt.2")).toEqual(["Ada"]);
      expect(await names("/clients?id=lte.2&order=id")).toEqual(["Ada", "Linus"]);
      expect(await names("/clients?id=gte.2&id=lt.3")).toEqual(["Linus"]);
    });
    test("pattern matching", async () => {
      expect(await names("/clients?name=like.*a&order=id")).toEqual(["Ada"]);
      expect(await names("/clients?name=ilike.*A&order=id")).toEqual(["Ada"]);
      expect(await names("/clients?name=like.L*")).toEqual(["Linus"]);
      expect(await names("/clients?name=match.^G.*e$")).toEqual(["Grace"]);
      expect(await names("/clients?name=imatch.^g")).toEqual(["Grace"]);
    });
    test("in, is, isdistinct", async () => {
      expect(await names("/clients?id=in.(1,3)&order=id")).toEqual(["Ada", "Grace"]);
      expect(await names('/clients?name=in.("Ada","Grace")&order=id')).toEqual(["Ada", "Grace"]);
      expect(await names("/clients?id=in.()")).toEqual([]);
      expect(await names("/clients?meta=is.null")).toEqual(["Grace"]);
      expect(await names("/clients?meta=is.not_null&order=id")).toEqual(["Ada", "Linus"]);
      expect(await names("/clients?meta=not.is.null&order=id")).toEqual(["Ada", "Linus"]);
      expect(await names("/clients?name=isdistinct.Ada&order=id")).toEqual(["Linus", "Grace"]);
    });
    test("negation", async () => {
      expect(await names("/clients?name=not.eq.Ada&order=id")).toEqual(["Linus", "Grace"]);
      expect(await names("/clients?id=not.in.(1,2)")).toEqual(["Grace"]);
    });
    test("arrays and jsonb containment", async () => {
      expect(await names("/clients?tags=cs.{vip}&order=id")).toEqual(["Ada", "Grace"]);
      expect(await names("/clients?tags=cd.{vip,early,x}")).toEqual(["Ada"]);
      expect(await names("/clients?tags=ov.{oss,navy}&order=id")).toEqual(["Linus", "Grace"]);
      expect(await names('/clients?meta=cs.{"tier":"gold"}')).toEqual(["Ada"]);
      expect(await names("/clients?meta->>tier=eq.silver")).toEqual(["Linus"]);
      expect(await names("/clients?meta->address->>city=eq.London")).toEqual(["Ada"]);
    });
    test("quantifiers any / all", async () => {
      expect(await names("/clients?id=eq(any).{1,3}&order=id")).toEqual(["Ada", "Grace"]);
      expect(await names("/clients?name=like(any).{A*,L*}&order=id")).toEqual(["Ada", "Linus"]);
      expect(await names("/clients?id=gt(all).{0,1}&order=id")).toEqual(["Linus", "Grace"]);
    });
    test("full text search", async () => {
      expect(await names("/clients?name=fts.ada")).toEqual(["Ada"]);
      expect(await names("/clients?name=plfts(english).linus")).toEqual(["Linus"]);
      expect(await names("/clients?name=wfts.grace")).toEqual(["Grace"]);
    });
    test("logic trees", async () => {
      expect(await names("/clients?or=(id.eq.1,id.eq.3)&order=id")).toEqual(["Ada", "Grace"]);
      expect(await names("/clients?and=(id.gt.1,id.lt.3)")).toEqual(["Linus"]);
      expect(await names("/clients?or=(id.eq.1,and(id.gt.1,name.eq.Grace))&order=id")).toEqual(["Ada", "Grace"]);
      expect(await names("/clients?not.or=(id.eq.1,id.eq.2)")).toEqual(["Grace"]);
      expect(await names('/clients?or=(name.eq."Ada",name.in.("Linus","x,y"))&order=id')).toEqual(["Ada", "Linus"]);
    });
    test("bad filters are PGRST100", async () => {
      for (const q of ["id=foo.1", "id=eq", "id=is.maybe", "or=id.eq.1", "limit=x"]) {
        const r = await t.get(`/clients?${q}`);
        expect(r.status).toBe(400);
        expect(r.json().code).toBe("PGRST100");
      }
    });
    test("unknown column is a Postgres error", async () => {
      const r = await t.get("/clients?nope=eq.1");
      expect(r.status).toBe(400);
      expect(r.json().code).toBe("42703");
    });
  });

  describe("order and pagination", () => {
    test("order directions and nulls", async () => {
      expect(await names("/clients?order=name.desc")).toEqual(["Linus", "Grace", "Ada"]);
      expect(await names("/clients?order=meta->>tier.asc.nullsfirst")).toEqual(["Grace", "Ada", "Linus"]);
      expect(await names("/clients?order=meta->>tier.asc.nullslast")).toEqual(["Ada", "Linus", "Grace"]);
      expect(await names("/clients?order=meta->>tier.desc.nullslast")).toEqual(["Linus", "Ada", "Grace"]);
    });
    test("limit and offset", async () => {
      expect(await names("/clients?order=id&limit=2")).toEqual(["Ada", "Linus"]);
      expect(await names("/clients?order=id&limit=1&offset=1")).toEqual(["Linus"]);
    });
    test("Range header", async () => {
      const r = await t.get("/clients?order=id", { headers: { Range: "1-2", "Range-Unit": "items" } });
      expect(r.json().map((c: any) => c.name)).toEqual(["Linus", "Grace"]);
      expect(r.headers.get("content-range")).toBe("1-2/*");
    });
    test("count=exact, 206 and Content-Range", async () => {
      const r = await t.get("/clients?order=id&limit=2", { headers: { Prefer: "count=exact" } });
      expect(r.status).toBe(206);
      expect(r.headers.get("content-range")).toBe("0-1/3");
      const all = await t.get("/clients", { headers: { Prefer: "count=exact" } });
      expect(all.status).toBe(200);
      expect(all.headers.get("content-range")).toBe("0-2/3");
      expect(all.headers.get("preference-applied")).toBe("count=exact");
      const none = await t.get("/clients?id=gt.100", { headers: { Prefer: "count=exact" } });
      expect(none.headers.get("content-range")).toBe("*/0");
    });
    test("offset past the end is 416 with an exact count", async () => {
      const r = await t.get("/clients?offset=10", { headers: { Prefer: "count=exact" } });
      expect(r.status).toBe(416);
      expect(r.json().code).toBe("PGRST103");
    });
    test("count=planned and estimated", async () => {
      const p = await t.get("/clients", { headers: { Prefer: "count=planned" } });
      expect(p.headers.get("content-range")).toMatch(/^0-2\/\d+$/);
      const e = await t.get("/clients?limit=1", { headers: { Prefer: "count=estimated" } });
      expect(e.headers.get("content-range")).toBe("0-0/3");
    });
    test("maxRows caps results", async () => {
      const capped = await makeApi({ maxRows: 2 });
      try {
        expect((await capped.get("/clients?order=id")).json()).toHaveLength(2);
        const r = await capped.get("/clients?limit=10&order=id", { headers: { Prefer: "count=exact" } });
        expect(r.json()).toHaveLength(2);
        expect(r.headers.get("content-range")).toBe("0-1/3");
      } finally {
        await capped.close();
      }
    });
  });

  describe("embedding", () => {
    test("to-many and to-one", async () => {
      const r = (await t.get("/clients?select=name,orders(id,total)&order=id")).json();
      expect(r[0]).toEqual({ name: "Ada", orders: [{ id: 1, total: 250 }, { id: 2, total: 40.5 }] });
      expect(r[1]).toEqual({ name: "Linus", orders: [{ id: 3, total: 99.99 }] });
      const o = (await t.get("/orders?select=id,clients(name)&order=id")).json();
      expect(o.map((x: any) => x.clients.name)).toEqual(["Ada", "Ada", "Linus", "Grace"]);
    });
    test("an empty to-many is [], a missing to-one is null", async () => {
      const r = (await t.get("/clients?select=name,orders(id)&id=eq.3")).json();
      expect(r[0].orders).toEqual([{ id: 4 }]);
      await t.db.adapter.query(`INSERT INTO api.clients(name) VALUES ('Nobody')`);
      const n = (await t.get("/clients?select=name,orders(id),profiles(bio)&name=eq.Nobody")).json();
      expect(n).toEqual([{ name: "Nobody", orders: [], profiles: null }]);
      await t.db.adapter.query(`DELETE FROM api.clients WHERE name = 'Nobody'`);
    });
    test("one-to-one is an object, in both directions", async () => {
      const r = (await t.get("/clients?select=name,profiles(bio)&id=eq.1")).json();
      expect(r).toEqual([{ name: "Ada", profiles: { bio: "First programmer" } }]);
      const p = (await t.get("/profiles?select=bio,clients(name)&order=client_id")).json();
      expect(p[0]).toEqual({ bio: "First programmer", clients: { name: "Ada" } });
    });
    test("many-to-many through a junction table", async () => {
      const r = (await t.get("/orders?select=id,products(name)&order=id")).json();
      expect(r[0].products.map((p: any) => p.name).sort()).toEqual(["Keyboard", "Mouse"]);
      expect(r[2].products).toEqual([]);
      const back = (await t.get("/products?select=name,orders(id)&name=eq.Mouse")).json();
      expect(back[0].orders.map((o: any) => o.id).sort()).toEqual([1, 2]);
    });
    test("nested embeds", async () => {
      const r = (await t.get("/clients?select=name,orders(id,products(name))&id=eq.3")).json();
      expect(r[0].orders[0].products.map((p: any) => p.name).sort()).toEqual(["Keyboard", "Monitor"]);
    });
    test("alias and hint", async () => {
      const a = (await t.get("/orders?select=id,buyer:clients(name)&id=eq.3")).json();
      expect(a).toEqual([{ id: 3, buyer: { name: "Linus" } }]);
      const h = (await t.get("/orders?select=id,clients!orders_client_id_fkey(name)&id=eq.3")).json();
      expect(h).toEqual([{ id: 3, clients: { name: "Linus" } }]);
      const c = (await t.get("/orders?select=id,clients!client_id(name)&id=eq.3")).json();
      expect(c).toEqual([{ id: 3, clients: { name: "Linus" } }]);
    });
    test("filters, order and limit on embedded resources", async () => {
      const r = (await t.get("/clients?select=name,orders(id,status)&orders.status=eq.paid&order=id")).json();
      expect(r[0].orders).toEqual([{ id: 1, status: "paid" }]);
      expect(r[2].orders).toEqual([]);
      const o = (await t.get("/clients?select=name,orders(id)&orders.order=id.desc&orders.limit=1&id=eq.1")).json();
      expect(o[0].orders).toEqual([{ id: 2 }]);
      const al = (await t.get("/clients?select=name,o:orders(id)&o.status=eq.new&id=eq.1")).json();
      expect(al[0].o).toEqual([{ id: 2 }]);
      const legacy = (await t.get("/clients?select=name,o:orders(id)&orders.status=eq.new&id=eq.1")).json();
      expect(legacy[0].o).toEqual([{ id: 2 }]);
    });
    test("!inner filters the parent rows", async () => {
      const r = (await t.get("/clients?select=name,orders!inner(id)&orders.status=eq.shipped")).json();
      expect(r).toEqual([{ name: "Grace", orders: [{ id: 4 }] }]);
      const left = (await t.get("/clients?select=name,orders(id)&orders.status=eq.shipped&order=id")).json();
      expect(left).toHaveLength(3);
    });
    test("!inner with count", async () => {
      const r = await t.get("/clients?select=name,orders!inner(id)&orders.status=eq.shipped", { headers: { Prefer: "count=exact" } });
      expect(r.headers.get("content-range")).toBe("0-0/1");
      const lim = await t.get("/clients?select=name,orders!inner(id)&orders.status=eq.paid&limit=1&order=id", { headers: { Prefer: "count=exact" } });
      expect(lim.headers.get("content-range")).toBe("0-0/2");
    });
    test("embedding with no selected columns filters only", async () => {
      const r = (await t.get("/clients?select=name,orders!inner()&orders.status=eq.shipped")).json();
      expect(r).toEqual([{ name: "Grace" }]);
    });
    test("embed is.null / not.is.null", async () => {
      expect(await names("/clients?select=name,orders()&orders=is.null")).toEqual([]);
      expect(await names("/clients?select=name,profiles(*)&profiles=is.null")).toEqual(["Linus"]);
      expect(await names("/clients?select=name,profiles(*)&profiles=not.is.null&order=id")).toEqual(["Ada", "Grace"]);
    });
    test("spread of a to-one embed", async () => {
      const r = (await t.get("/orders?select=id,...clients(client:name)&order=id&limit=2")).json();
      expect(r).toEqual([{ id: 1, client: "Ada" }, { id: 2, client: "Ada" }]);
      const s = (await t.get("/clients?select=name,...profiles(bio)&id=eq.1")).json();
      expect(s).toEqual([{ name: "Ada", bio: "First programmer" }]);
    });
    test("ambiguous embedding is PGRST201, unknown is PGRST200", async () => {
      const amb = await t.get("/employees?select=name,employees(name)");
      expect(amb.status).toBe(300);
      expect(amb.json().code).toBe("PGRST201");
      const none = await t.get("/clients?select=name,products(name)");
      // clients → orders → products is not a direct relationship
      expect(none.status).toBe(400);
      expect(none.json().code).toBe("PGRST200");
    });
    test("filtering an embed that is not selected is PGRST108", async () => {
      const r = await t.get("/clients?select=name&orders.status=eq.paid");
      expect(r.status).toBe(400);
      expect(r.json().code).toBe("PGRST108");
    });
    test("embedding through a view", async () => {
      const r = await t.get("/big_orders?select=id&order=id");
      expect(r.json()).toEqual([{ id: 1 }, { id: 4 }]);
    });
  });

  describe("representations", () => {
    test("singular object", async () => {
      const r = await t.get("/clients?id=eq.1&select=name", { headers: { Accept: "application/vnd.pgrst.object+json" } });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("application/vnd.pgrst.object+json");
      expect(r.json()).toEqual({ name: "Ada" });
    });
    test("singular fails with 406 PGRST116 for 0 or many rows", async () => {
      for (const [q, n] of [["id=gt.0", 3], ["id=eq.99", 0]] as const) {
        const r = await t.get(`/clients?${q}`, { headers: { Accept: "application/vnd.pgrst.object+json" } });
        expect(r.status).toBe(406);
        expect(r.json().code).toBe("PGRST116");
        expect(r.json().details).toBe(`The result contains ${n} rows`);
      }
    });
    test("nulls=stripped", async () => {
      const r = await t.get("/clients?id=eq.3&select=name,email,meta", { headers: { Accept: "application/vnd.pgrst.object+json;nulls=stripped" } });
      expect(r.json()).toEqual({ name: "Grace", email: "grace@example.com" });
    });
    test("csv", async () => {
      const r = await t.get("/clients?select=id,name&order=id", { headers: { Accept: "text/csv" } });
      expect(r.headers.get("content-type")).toBe("text/csv; charset=utf-8");
      expect(r.text).toBe("id,name\n1,Ada\n2,Linus\n3,Grace");
    });
    test("unsupported Accept is 415 PGRST107", async () => {
      const r = await t.get("/clients", { headers: { Accept: "image/png" } });
      expect(r.status).toBe(415);
      expect(r.json().code).toBe("PGRST107");
    });
    test("HEAD returns headers only", async () => {
      const r = await t.call("HEAD", "/clients", { headers: { Prefer: "count=exact" } });
      expect(r.status).toBe(200);
      expect(r.text).toBe("");
      expect(r.headers.get("content-range")).toBe("0-2/3");
    });
    test("OPTIONS reports the allowed methods", async () => {
      const r = await t.call("OPTIONS", "/clients");
      expect(r.headers.get("allow")).toBe("OPTIONS,GET,HEAD,POST,PUT,PATCH,DELETE");
      expect((await t.call("OPTIONS", "/client_totals")).headers.get("allow")).toBe("OPTIONS,GET,HEAD");
    });
  });

  describe("schemas and routing", () => {
    test("default schema and Accept-Profile", async () => {
      expect((await t.get("/things")).status).toBe(404);
      const r = await t.get("/things", { headers: { "Accept-Profile": "v2" } });
      expect(r.json()).toEqual([{ id: 1, label: "one" }, { id: 2, label: "two" }]);
    });
    test("a schema that is not exposed is 406 PGRST106", async () => {
      const r = await t.get("/clients", { headers: { "Accept-Profile": "pg_catalog" } });
      expect(r.status).toBe(406);
      expect(r.json().code).toBe("PGRST106");
      expect(r.json().hint).toContain("api, v2");
    });
    test("unknown table and path", async () => {
      expect((await t.get("/clientz")).json().code).toBe("PGRST205");
      const deep = await t.get("/clients/1");
      expect(deep.status).toBe(404);
      expect(deep.json().code).toBe("PGRST125");
    });
    test("basePath is stripped", async () => {
      const mounted = await makeApi({ basePath: "/rest/v1" });
      try {
        expect((await mounted.get("/rest/v1/clients?select=id&limit=1")).json()).toEqual([{ id: 1 }]);
        expect((await mounted.get("/clients")).status).toBe(404);
      } finally {
        await mounted.close();
      }
    });
    test("OpenAPI document", async () => {
      const r = await t.get("/");
      expect(r.status).toBe(200);
      const doc = r.json();
      expect(doc.swagger).toBe("2.0");
      expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/clients", "/orders", "/rpc/add", "/rpc/whoami"]));
      expect(doc.definitions.clients.properties.id.description).toContain("Primary Key");
      expect(doc.definitions.clients.properties.name.type).toBe("string");
      expect(doc.definitions.clients.required).toContain("name");
      expect(doc.paths["/client_totals"].post).toBeUndefined();
      expect(doc.paths["/client_totals"].delete).toBeUndefined();
      expect(doc.paths["/client_totals"].patch).toBeUndefined();
      expect(doc.paths["/rpc/boom"].get).toBeUndefined();
      expect(doc.paths["/rpc/add"].get).toBeDefined();
    });
    test("OpenAPI can be disabled", async () => {
      const off = await makeApi({ openApi: false });
      try {
        const r = await off.get("/");
        expect(r.status).toBe(404);
        expect(r.json().code).toBe("PGRST126");
      } finally {
        await off.close();
      }
    });
  });
});
