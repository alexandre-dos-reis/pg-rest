import { afterEach, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { authed, makeApi, type TestApi } from "./support/api";
import { PgRestError } from "../src/index";

describe.skipIf(!hasDb)("request context (the library's replacement for JWT)", () => {
  let t: TestApi | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  test("anonymous by default", async () => {
    t = await makeApi();
    const who = (await t.get("/rpc/whoami")).json();
    expect(who.role).toBe("anon");
    expect(who.claims).toEqual({ role: "anon" });
  });

  test("role, claims and custom settings reach SQL", async () => {
    t = await makeApi();
    const r = await t.get("/rpc/whoami", {
      ctx: { role: "authenticated", claims: { sub: "u-9", email: "u@x.com" }, settings: { "app.tenant": "acme" } },
    });
    expect(r.json()).toEqual({
      role: "authenticated",
      claims: { role: "authenticated", sub: "u-9", email: "u@x.com" },
      tenant: "acme",
    });
  });

  test("an explicit role claim is not overwritten", async () => {
    t = await makeApi();
    const r = await t.get("/rpc/whoami", { ctx: { role: "authenticated", claims: { role: "custom" } } });
    expect(r.json().claims.role).toBe("custom");
  });

  test("settings must have a dotted name", async () => {
    t = await makeApi();
    const r = await t.get("/rpc/whoami", { ctx: { settings: { tenant: "x" } } });
    expect(r.status).toBe(500);
    expect(r.json().hint).toContain("prefix");
    const evil = await t.get("/rpc/whoami", { ctx: { settings: { "a.b'); DROP TABLE api.clients;--": "x" } } });
    expect(evil.status).toBe(500);
    expect((await t.get("/clients?select=id")).status).toBe(200);
  });

  test("an unknown role is a database error", async () => {
    t = await makeApi();
    const r = await t.get("/clients", { ctx: { role: "does_not_exist" } });
    expect(r.status).toBe(400);
    expect(r.json().code).toBe("22023");
  });

  test("resolveContext decides who the user is, per request", async () => {
    t = await makeApi({
      resolveContext: (req) => {
        const key = req.headers.get("x-api-key");
        if (!key) return undefined;
        if (key === "bad") throw new PgRestError(401, "unauthorized", "Invalid API key");
        return { role: "authenticated", claims: { sub: key } };
      },
    });
    expect((await t.get("/rpc/whoami")).json().role).toBe("anon");
    const ok = await t.get("/rpc/whoami", { headers: { "x-api-key": "alice" } });
    expect(ok.json().claims.sub).toBe("alice");
    const bad = await t.get("/rpc/whoami", { headers: { "x-api-key": "bad" } });
    expect(bad.status).toBe(401);
    expect(bad.json()).toEqual({ code: "unauthorized", message: "Invalid API key", details: null, hint: null });
  });

  test("an explicit context wins over resolveContext", async () => {
    t = await makeApi({ resolveContext: () => ({ role: "authenticated", claims: { sub: "from-resolver" } }) });
    expect((await t.get("/rpc/whoami", { ctx: authed("explicit") })).json().claims.sub).toBe("explicit");
    expect((await t.get("/rpc/whoami")).json().claims.sub).toBe("from-resolver");
  });

  test("a custom anonymous role", async () => {
    t = await makeApi({ anonymousRole: "authenticated" });
    expect((await t.get("/rpc/whoami")).json().role).toBe("authenticated");
  });

  test("request details are visible in SQL, and can be turned off", async () => {
    t = await makeApi();
    const r = await t.get("/rpc/req_info", { headers: { "X-Test": "hello", Cookie: "sid=abc%20123; other=1" } });
    const info = r.json();
    expect(info).toMatchObject({ method: "GET", path: "/rpc/req_info", header: "hello", cookie: "abc 123" });
    expect(info.search_path).toBe('"api", "public"');
    await t.close();
    t = await makeApi({ requestSettings: false });
    expect((await t.get("/rpc/req_info", { headers: { "X-Test": "hello" } })).json()).toMatchObject({
      method: null,
      header: null,
    });
  });

  test("extraSearchPath", async () => {
    t = await makeApi({ extraSearchPath: ["public", "v2"] });
    expect((await t.get("/rpc/req_info")).json().search_path).toBe('"api", "public", "v2"');
  });

  test("preRequest as a SQL function can reject the request", async () => {
    t = await makeApi({ preRequest: "api.pre_check" });
    expect((await t.get("/clients?select=id&limit=1")).status).toBe(200);
    const r = await t.get("/clients", { headers: { "x-block": "1" } });
    expect(r.status).toBe(403);
    expect(r.json().message).toBe("blocked by pre-request");
  });

  test("preRequest as a callback runs inside the request transaction", async () => {
    const seen: string[] = [];
    t = await makeApi({
      preRequest: async (session, info) => {
        seen.push(`${info.method} ${info.path} as ${info.role}`);
        const [row] = await session.query("SELECT current_user AS u");
        seen.push(String(row!["u"]));
      },
    });
    await t.get("/clients?select=id&limit=1", { ctx: authed() });
    expect(seen).toEqual(["GET /clients as authenticated", "authenticated"]);
  });

  test("the schema cache can be reloaded after a migration", async () => {
    t = await makeApi();
    expect((await t.get("/late")).status).toBe(404);
    await t.db.adapter.query(
      "CREATE TABLE api.late (id int PRIMARY KEY); INSERT INTO api.late VALUES (1); GRANT SELECT ON api.late TO anon",
    );
    expect((await t.get("/late")).status).toBe(404);
    await t.api.reloadSchema();
    expect((await t.get("/late")).json()).toEqual([{ id: 1 }]);
    expect((await t.api.schemaCache()).relations.has("api.late")).toBe(true);
  });

  test("schemas that cannot be exposed are refused at startup", async () => {
    const { createPgRest } = await import("../src/index");
    const probe = await makeApi();
    try {
      await expect(createPgRest({ db: probe.db.adapter, schemas: ["pg_catalog"] })).rejects.toThrow(
        /cannot be exposed/,
      );
    } finally {
      await probe.close();
    }
  });

  test("database connection problems are 503 PGRST001", async () => {
    const down = {
      async query() {
        throw Object.assign(new Error("connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" });
      },
      async transaction() {
        throw Object.assign(new Error("connection closed"), { code: "ERR_POSTGRES_CONNECTION_CLOSED" });
      },
    };
    t = await makeApi();
    const { createPgRest } = await import("../src/index");
    // Start with a working adapter so the schema loads, then break it.
    let broken = false;
    const flaky = {
      query: (s: string, p?: any) => (broken ? down.query() : t!.db.adapter.query(s, p)),
      transaction: (fn: any) => (broken ? down.transaction() : t!.db.adapter.transaction(fn)),
    };
    const api = await createPgRest({ db: flaky as any, schemas: ["api"] });
    broken = true;
    const res = await api.handle(new Request("http://x/clients"));
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe("PGRST001");
    await api.close();
  });
});
