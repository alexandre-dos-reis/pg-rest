import { afterEach, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { makeApi, type TestApi } from "./support/api";

// Custom media type handlers that would change every other test's default (the catch-all) or need binary output.
// The plain `text/plain`, `text/xml` and `application/octet-stream` handlers are covered by the comparison tests.
describe.skipIf(!hasDb)("custom media type handlers", () => {
  let t: TestApi | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  const setup = async () => {
    t = await makeApi();
    await t.db.adapter.query(`
      CREATE DOMAIN api."*/*" AS text;
      CREATE DOMAIN api."image/png" AS bytea;
      CREATE FUNCTION api.any_t(state text, c anyelement) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT coalesce(state, '') || to_jsonb(c)::text || '|' $$;
      CREATE FUNCTION api.any_fin(state text) RETURNS api."*/*" LANGUAGE sql IMMUTABLE AS $$ SELECT state $$;
      CREATE AGGREGATE api."*/*"(anyelement) (sfunc = api.any_t, stype = text, finalfunc = api.any_fin);
      CREATE FUNCTION api.png() RETURNS api."image/png" LANGUAGE sql IMMUTABLE AS $$ SELECT '\\x89504e47'::bytea $$;
    `);
    await t.api.reloadSchema();
    return t;
  };

  test("the catch-all handler answers when Accept is absent or */*, and json stays available", async () => {
    const api = await setup();
    for (const accept of [undefined, "*/*"]) {
      const r = await api.get("/clients?id=eq.1&select=id", accept ? { headers: { Accept: accept } } : {});
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("application/octet-stream");
      expect(r.text).toBe('{"id": 1}|');
    }
    const json = await api.get("/clients?id=eq.1&select=id", { headers: { Accept: "application/json" } });
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(json.json()).toEqual([{ id: 1 }]);
  });

  test("the catch-all handler returns scalar results raw", async () => {
    const api = await setup();
    const r = await api.get("/rpc/add?a=1&b=2");
    expect(r.headers.get("content-type")).toBe("application/octet-stream");
    expect(r.text).toBe("3");
  });

  test("binary domains are returned as bytes", async () => {
    const api = await setup();
    const res = await api.api.handle(new Request("http://localhost/rpc/png", { headers: { Accept: "image/png" } }));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });
});
