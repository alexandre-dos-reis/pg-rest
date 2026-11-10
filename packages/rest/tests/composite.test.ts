import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb } from "../../../tests/support/db";
import { makeApi, type TestApi } from "./support/api";

/**
 * Composite and JSON types through `handle()`: what PostgREST's query string can say about them.
 * The object API's own handling of the same types is `@tspg/query`'s suite -- both read the one
 * engine in `@tspg/core`, so neither has to be checked against the other.
 */
describe.skipIf(!hasDb)("composite values over HTTP", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  const ADA = { name: "Ada", home: { city: "Paris", zip: "75001" }, tags: ["music", "large"] };

  describe("reading", () => {
    test("a path ending on an index is named after the last key before it", async () => {
      // PostgREST's own rule (`lastJsonKey`): `owner->tags->>0` is `tags`, `branches->0` is `branches`
      expect((await t.get("/venues?select=owner->tags->>0&id=eq.1")).json()).toEqual([{ tags: "music" }]);
      expect((await t.get("/venues?select=branches->0&id=eq.2")).json()).toEqual([
        { branches: { city: "Paris", zip: "75002" } },
      ]);
    });

    test("a jsonb column keeps its arrows, so its indexes still apply", async () => {
      expect((await t.get("/venues?select=meta->>seats&id=eq.1")).json()).toEqual([{ seats: "900" }]);
    });

    test("filtering and ordering by a field", async () => {
      expect((await t.get("/venues?select=id&owner->>name=eq.Ada")).json()).toEqual([{ id: 1 }]);
      expect((await t.get("/venues?select=id&owner->home->>city=eq.Lyon")).json()).toEqual([{ id: 2 }]);
      expect((await t.get("/venues?select=label&order=owner->>name.desc")).json()).toEqual([
        { label: "Back room" },
        { label: "Concert hall" },
      ]);
    });
  });

  describe("filtering by a whole composite value", () => {
    test("the same request over HTTP answers identically", async () => {
      const reply = await t.get(`/venues?select=id&owner=eq.${encodeURIComponent(JSON.stringify(ADA))}`);
      expect(reply.status).toBe(200);
      expect(reply.json()).toEqual([{ id: 1 }]);
    });

    test("a bare Postgres row literal is refused, as PostgREST refuses it", async () => {
      // `'(Ada,...)'` has no type to be read as: both answer 0A000 rather than guessing one
      const reply = await t.get("/venues?select=id&owner=eq.(Ada,,)");
      expect(reply.status).toBe(400);
      expect(reply.json().code).toBe("0A000");
    });
  });
});
