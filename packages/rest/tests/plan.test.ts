import { afterEach, describe, expect, test } from "bun:test";
import { hasDb } from "../../../tests/support/db";
import { makeApi, type TestApi } from "../../../tests/support/api";

describe.skipIf(!hasDb)("execution plan (Accept: application/vnd.pgrst.plan)", () => {
  let t: TestApi | undefined;
  afterEach(async () => {
    await t?.close();
    t = undefined;
  });

  test("is refused unless enabled", async () => {
    t = await makeApi();
    const r = await t.get("/clients", { headers: { Accept: "application/vnd.pgrst.plan" } });
    expect(r.status).toBe(406);
    expect(r.json().code).toBe("PGRST107");
    expect(r.json().message).toContain('application/vnd.pgrst.plan+text; for="application/json"');
  });

  test("text and json plans", async () => {
    t = await makeApi({ planEnabled: true });
    const text = await t.get("/clients?id=eq.1", { headers: { Accept: "application/vnd.pgrst.plan" } });
    expect(text.status).toBe(200);
    expect(text.headers.get("content-type")).toBe(
      'application/vnd.pgrst.plan+text; for="application/json"; charset=utf-8',
    );
    expect(text.text).toContain("clients");

    const json = await t.get("/clients?id=eq.1", {
      headers: { Accept: 'application/vnd.pgrst.plan+json; for="text/csv"; options=verbose|bogus' },
    });
    expect(json.headers.get("content-type")).toBe(
      'application/vnd.pgrst.plan+json; for="text/csv"; options=verbose; charset=utf-8',
    );
    expect(json.json()[0].Plan).toBeDefined();
  });

  test("a write is explained, not executed", async () => {
    t = await makeApi({ planEnabled: true });
    const before = (await t.get("/clients")).json().length;
    const r = await t.post(
      "/clients",
      { name: "Planned" },
      { headers: { Accept: "application/vnd.pgrst.plan+json" }, ctx: { role: "authenticated" } },
    );
    expect(r.status).toBe(200);
    expect((await t.get("/clients")).json().length).toBe(before);
  });
});
