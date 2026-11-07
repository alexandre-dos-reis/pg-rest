import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { hasDb } from "./support/db";
import { authed, makeApi, type TestApi } from "./support/api";
import {} from "../packages/query/src/query";
import { toParams } from "./support/render";
import type { QueryInput } from "./support/pgrest";

/** The query string the object describes, as `handle()` would receive it. */
const qs = (input: QueryInput): string => new URLSearchParams(toParams(input) as Array<[string, string]>).toString();

/** The same encoding, so the expectations read as the parameter rather than as percent escapes. */
const param = (key: string, value: string): string => new URLSearchParams([[key, value]]).toString();

const ADA = { name: "Ada", home: { city: "Paris", zip: "75001" }, tags: ["music", "large"] };

describe("composite values -> query string", () => {
  test("an object without an operator is an eq against a composite value, as JSON", () => {
    expect(qs({ table: "venues", where: { owner: ADA } })).toBe(param("owner", `eq.${JSON.stringify(ADA)}`));
  });

  test("the operator forms carry one the same way", () => {
    expect(qs({ table: "venues", where: { owner: { $neq: { name: "Ada" } } } })).toBe(
      param("owner", 'neq.{"name":"Ada"}'),
    );
    expect(qs({ table: "venues", where: { owner: { $not: { $eq: { name: "Ada" } } } } })).toBe(
      param("owner", 'not.eq.{"name":"Ada"}'),
    );
  });

  test("inside a list or a logic tree it is quoted, like any value with commas", () => {
    // `in.("{""name"":""Ada""}")`: the braces and commas of the JSON would otherwise end the item
    expect(qs({ table: "venues", where: { owner: { $in: [{ name: "Ada" }] } } })).toBe(
      param("owner", 'in.("{\\"name\\":\\"Ada\\"}")'),
    );
    expect(qs({ table: "venues", where: { $or: [{ owner: { name: "Ada" } }, { label: "Back room" }] } })).toBe(
      param("or", '(owner.eq."{\\"name\\":\\"Ada\\"}",label.eq.Back room)'),
    );
  });

  test("an object whose keys all start with $ names operators", () => {
    expect(qs({ table: "venues", where: { label: { $like: "Con*" } } })).toBe("label=like.Con*");
    // ... and an unknown one is still reported rather than read as a composite value
    expect(() => qs({ table: "venues", where: { owner: { $nope: 1 } } as never })).toThrow(
      "Unknown filter operator '$nope' on 'owner'",
    );
    // a composite type with a field called `op` is a value again: only `$` marks an operator
    expect(qs({ table: "venues", where: { owner: { op: "and", name: "x" } } })).toBe(
      param("owner", `eq.${JSON.stringify({ op: "and", name: "x" })}`),
    );
  });
});

describe.skipIf(!hasDb)("composite types", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  describe("reading", () => {
    test("a composite column comes back as an object, an array of them as a list", async () => {
      const { data } = await t.api.query({
        table: "venues",
        select: ["label", "owner", "branches"],
        single: true,
        where: { label: "Back room" },
      });
      expect(data).toEqual({
        label: "Back room",
        owner: { name: "Grace", home: { city: "Lyon", zip: "69002" }, tags: ["small"] },
        branches: [{ city: "Paris", zip: "75002" }],
      });
    });

    test("arrow paths reach the fields, nested and through an array", async () => {
      const { data } = await t.api.query({
        table: "venues",
        select: ["id", "owner->>name", "owner->home->>city", "owner->home", "first_branch:branches->0->>city"],
        order: ["id"],
      });
      expect(data).toEqual([
        { id: 1, name: "Ada", city: "Paris", home: { city: "Paris", zip: "75001" }, first_branch: "Lyon" },
        { id: 2, name: "Grace", city: "Lyon", home: { city: "Lyon", zip: "69002" }, first_branch: "Paris" },
      ]);
    });

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
    test("the fields may come in any order, and the ones left out are NULL", async () => {
      const found = await t.api.query({ table: "venues", select: ["id"], where: { owner: ADA } });
      expect(found.data).toEqual([{ id: 1 }]);
      const reordered = await t.api.query({
        table: "venues",
        select: ["id"],
        where: { owner: { tags: ["music", "large"], home: { zip: "75001", city: "Paris" }, name: "Ada" } },
      });
      expect(reordered.data).toEqual([{ id: 1 }]);
      // a partial value compares against a row whose other fields are NULL, so it matches nothing
      expect((await t.api.query({ table: "venues", select: ["id"], where: { owner: { name: "Ada" } } })).data).toEqual(
        [],
      );
    });

    test("neq, in and isdistinct take one too", async () => {
      expect((await t.api.query({ table: "venues", select: ["id"], where: { owner: { $neq: ADA } } })).data).toEqual([
        { id: 2 },
      ]);
      expect((await t.api.query({ table: "venues", select: ["id"], where: { owner: { $in: [ADA] } } })).data).toEqual([
        { id: 1 },
      ]);
      expect(
        (await t.api.query({ table: "venues", select: ["id"], where: { owner: { $isdistinct: ADA } } })).data,
      ).toEqual([{ id: 2 }]);
    });

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

    test("is.null still tests the column, not its fields", async () => {
      expect((await t.api.query({ table: "venues", select: ["id"], where: { owner: { $is: "null" } } })).data).toEqual(
        [],
      );
    });
  });

  describe("writing", () => {
    test("a nested object is the composite value, and a missing field is NULL", async () => {
      const { data, error } = await t.api.query(
        {
          table: "venues",
          action: "insert",
          rows: { label: "New", owner: { name: "Edsger", home: { city: "Rotterdam" } }, branches: [{ city: "Delft" }] },
          select: ["label", "owner", "branches"],
          single: true,
        },
        authed(),
      );
      expect(error).toBeNull();
      expect(data).toEqual({
        label: "New",
        owner: { name: "Edsger", home: { city: "Rotterdam", zip: null }, tags: null },
        branches: [{ city: "Delft", zip: null }],
      });
      await t.api.query({ table: "venues", action: "delete", where: { label: "New" } }, authed());
    });

    test("an update replaces the whole value", async () => {
      const { data } = await t.api.query(
        {
          table: "venues",
          action: "update",
          set: { owner: { name: "Ada Lovelace" } },
          where: { label: "Concert hall" },
          select: ["owner"],
          single: true,
        },
        authed(),
      );
      expect(data).toEqual({ owner: { name: "Ada Lovelace", home: null, tags: null } });
      await t.api.query(
        { table: "venues", action: "update", set: { owner: ADA }, where: { label: "Concert hall" } },
        authed(),
      );
    });
  });

  describe("functions", () => {
    test("a composite argument travels as JSON", async () => {
      expect((await t.api.query({ rpc: "city_of", args: { who: ADA } })).data).toBe("Paris");
    });

    test("a function returning a composite type answers with the object", async () => {
      expect((await t.api.query({ rpc: "make_address", args: { city: "Lyon", zip: "69001" } })).data).toEqual({
        city: "Lyon",
        zip: "69001",
      });
    });
  });

  describe("the schema cache", () => {
    test("carries the fields of every composite type it reaches, nesting included", async () => {
      const cache = await t.api.schemaCache();
      expect(cache.composites.get("api.address")?.attributes.map((a) => [a.name, a.type])).toEqual([
        ["city", "text"],
        ["zip", "text"],
      ]);
      const contact = cache.composites.get("api.contact");
      expect(contact?.attributes.map((a) => a.name)).toEqual(["name", "home", "tags"]);
      // the nested one is a reference, so a generator can name it rather than inline it
      expect(contact?.attributes.find((a) => a.name === "home")?.composite).toEqual({ schema: "api", name: "address" });
      // a column points at its type -- through the array, for `api.address[]`
      const venues = cache.relations.get("api.venues");
      expect(venues?.columns.find((c) => c.name === "owner")?.composite).toEqual({ schema: "api", name: "contact" });
      expect(venues?.columns.find((c) => c.name === "branches")?.composite).toEqual({ schema: "api", name: "address" });
      expect(venues?.columns.find((c) => c.name === "meta")?.composite).toBeUndefined();
    });
  });
});
