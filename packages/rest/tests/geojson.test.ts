import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb, requirePostgis } from "../../../tests/support/db";
import { makeApi, type TestApi } from "./support/api";

describe.skipIf(!hasDb)("application/geo+json", () => {
  let t: TestApi;
  beforeAll(async () => {
    requirePostgis();
    t = await makeApi();
  });
  afterAll(async () => {
    await t?.close();
  });
  const geo = { headers: { Accept: "application/geo+json" } };

  test("returns a FeatureCollection with the first geometry column as geometry", async () => {
    const r = await t.get("/places?select=id,name,geom&order=id", geo);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/geo+json; charset=utf-8");
    const body = r.json();
    expect(body.type).toBe("FeatureCollection");
    expect(body.features[0]).toEqual({
      type: "Feature",
      geometry: { type: "Point", coordinates: [1, 2] },
      properties: { id: 1, name: "a" },
    });
    // places.geom is NULL on this row, and PostGIS renders that itself: 3.4 emits {"type": null},
    // 3.6 emits null. pg-rest forwards whatever ST_AsGeoJSON produced, and packages/rest/tests/compare asserts
    // PostgREST agrees on the same server, so either is right here.
    expect([null, { type: null }]).toContainEqual(body.features[2].geometry);
  });

  test("no rows is an empty collection", async () => {
    const r = await t.get("/places?id=eq.99", geo);
    expect(r.json()).toEqual({ type: "FeatureCollection", features: [] });
  });

  test("a result without a geometry column is an error from PostGIS", async () => {
    const r = await t.get("/places?select=id,name", geo);
    expect(r.status).toBe(400);
    expect(r.json().message).toBe("geometry column is missing");
  });
});
