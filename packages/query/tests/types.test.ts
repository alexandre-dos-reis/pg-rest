import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateModule, generateTypes } from "../src/types";
import {
  fromDescriptor,
  introspect,
  toDescriptor,
  type Column,
  type CompositeType,
  type Relation,
  type SchemaCache,
} from "../../core/src/schema";
import { createTestDb, hasDb, requirePostgis, type TestDb } from "../../../tests/support/db";

const column = (name: string, type: string, extra: Partial<Column> = {}): Column => ({
  name,
  type,
  nullable: false,
  hasDefault: false,
  defaultExpr: null,
  generated: false,
  comment: null,
  position: 0,
  ...extra,
});

const relation = (name: string, columns: Column[], extra: Partial<Relation> = {}): Relation => ({
  schema: "api",
  name,
  kind: "table",
  columns: columns.map((c, i) => ({ ...c, position: i + 1 })),
  pk: [],
  uniques: [],
  insertable: true,
  updatable: true,
  deletable: true,
  comment: null,
  ...extra,
});

const cacheOf = (relations: Relation[], composites: CompositeType[] = []): SchemaCache => ({
  schemas: ["api"],
  relations: new Map(relations.map((r) => [`api.${r.name}`, r])),
  foreignKeys: [],
  functions: new Map(),
  mediaHandlers: [],
  composites: new Map(composites.map((c) => [`${c.schema}.${c.name}`, c])),
});

describe("generateTypes", () => {
  test("columns: types, enums, arrays and nullability", async () => {
    const out = await generateTypes(
      cacheOf([
        relation("t", [
          column("n", "integer"),
          column("big", "bigint"),
          column("money", "numeric(10,2)"),
          column("flag", "boolean"),
          column("txt", "character varying(10)"),
          column("when", "timestamp with time zone"),
          column("blob", "json", { nullable: true }),
          column("list", "text[]", { nullable: true }),
          column("mood", "api.mood", { enumLabels: ["sad", "ok"] }),
          column("moods", "api.mood[]", { enumLabels: ["sad", "ok"], nullable: true }),
          column("geo", "geometry(Point,4326)", { nullable: true }),
        ]),
      ]),
    );
    expect(out).toContain("n: number;");
    expect(out).toContain("big: number;");
    expect(out).toContain("money: number;");
    expect(out).toContain("flag: boolean;");
    expect(out).toContain("txt: string;");
    expect(out).toContain("when: string;");
    // an unrecognised type is `unknown`, not a plausible `string`, and `unknown | null` is `unknown`
    expect(out).toContain("blob: unknown;");
    expect(out).toContain("geo: unknown;");
    expect(out).toContain("list: string[] | null;");
    expect(out).toContain('mood: "sad" | "ok";');
    expect(out).toContain('moods: ("sad" | "ok")[] | null;');
  });

  test("insert and update follow what the relation accepts", async () => {
    const out = await generateTypes(
      cacheOf([
        relation("t", [
          column("id", "integer", { hasDefault: true }),
          column("name", "text"),
          column("note", "text", { nullable: true }),
          column("computed", "text", { generated: true }),
          // an `always` identity refuses a value (428C9), so it is not writable either
          column("serial_always", "bigint", { hasDefault: true, identity: "always" }),
          column("serial_default", "bigint", { hasDefault: true, identity: "by-default" }),
        ]),
        relation("ro", [column("x", "integer")], {
          kind: "view",
          insertable: false,
          updatable: false,
          deletable: false,
        }),
      ]),
    );
    // a default or a nullable column may be left out; a generated one cannot be written at all
    expect(out).toContain(
      "insert: {\n      id?: number;\n      name: string;\n      note?: string | null;\n      serial_default?: number;\n    };",
    );
    expect(out).toContain(
      "update: {\n      id?: number;\n      name?: string;\n      note?: string | null;\n      serial_default?: number;\n    };",
    );
    // it is still a column of the row: it just cannot be written
    expect(out).toContain("serial_always: number;");
    expect(out).toContain("insert: never;");
    expect(out).toContain("update: never;");
    expect(out).toContain("insertable: false;");
  });

  test("view columns are typed from the cache, which has already resolved them", async () => {
    // `introspect` is what follows `source` back to the table column (and what refuses to, for a
    // view with an outer join); by the time the generator sees a column, `nullable` is the answer.
    const view = relation(
      "v",
      [column("total", "numeric", { nullable: false, source: { schema: "api", table: "t", column: "total" } })],
      { kind: "view" },
    );
    const cache = cacheOf([relation("t", [column("total", "numeric")]), view]);
    expect(await generateTypes(cache)).toContain("total: number;");
  });

  test("names that are not identifiers are quoted", async () => {
    const out = await generateTypes(
      cacheOf([relation("odd table", [column("odd col", "text"), column("ok", "text")])]),
    );
    expect(out).toContain('"odd table": {');
    expect(out).toContain('"odd col": string;');
    expect(out).toContain("ok: string;");
  });

  test("the header and the type name are options", async () => {
    const cache = cacheOf([relation("t", [column("x", "integer")])]);
    expect(await generateTypes(cache)).toStartWith("// Generated from the database catalog");
    expect(await generateTypes(cache, { header: false })).toStartWith("type DatabaseApiRelations");
    expect(await generateTypes(cache, { name: "MyDb" })).toContain("export type MyDb = {");
  });
});

describe.skipIf(!hasDb)("generateTypes against the fixture", () => {
  let cache: SchemaCache;
  let db: TestDb;
  beforeAll(async () => {
    requirePostgis();
    db = await createTestDb();
    cache = await introspect(db.adapter, ["api", "v2"]);
  });
  afterAll(() => db.drop());

  test("the module carries the descriptor createQuery runs on", async () => {
    const mod = await generateModule(cache, { name: "DatabasePgRest" });
    expect(mod).toContain("export type DatabasePgRest = {");
    expect(mod).toContain("export const schema: SchemaDescriptor = ");
    // the descriptor is the cache as plain data, and reads back to the same cache
    const back = fromDescriptor(JSON.parse(JSON.stringify(toDescriptor(cache))));
    expect([...back.relations.keys()]).toEqual([...cache.relations.keys()]);
    expect([...back.functions.keys()]).toEqual([...cache.functions.keys()]);
    expect(back.foreignKeys).toEqual(cache.foreignKeys);
    expect(await generateTypes(cache, { header: false })).not.toStartWith("//");
  });

  test("the committed types are exactly what the generator produces", async () => {
    // tests/support/fixture.types.ts is typechecked by `bun run typecheck`, so this pins both the
    // generator's output and the fact that the output compiles
    const committed = await Bun.file(new URL("../../../tests/support/fixture.types.ts", import.meta.url)).text();
    expect(await generateTypes(cache, { name: "DatabasePgRest" })).toBe(committed);
  });

  test("relationships come from the same resolver the request path uses", async () => {
    const out = await generateTypes(cache, { name: "DatabasePgRest" });
    // many-to-one, one-to-many, the foreign key column as a name, and many-to-many through a junction
    expect(out).toContain('clients: { rel: "clients"; to: "one" };');
    expect(out).toContain('orders: { rel: "orders"; to: "many" };');
    expect(out).toContain('client_id: { rel: "clients"; to: "one" };');
    expect(out).toContain('products: { rel: "products"; to: "many" };');
    // a computed relationship is an embed, not a callable function
    expect(out).toContain('recent_orders: { rel: "orders"; to: "many" };');
    expect(out).not.toContain("recent_orders: [{ args:");
  });

  test("functions: arguments, defaults, overloads, enums and set-returning results", async () => {
    const out = await generateTypes(cache, { name: "DatabasePgRest" });
    expect(out).toContain("add: [{ args: { a: number; b: number }; returns: number; set: false }];");
    expect(out).toContain("greet: [{ args: { name?: string }; returns: string; set: false }];");
    expect(out).toContain(
      'orders_by_status: [{ args: { s: string }; returns: DatabasePgRestApiRelations["orders"]["row"]; set: true }];',
    );
    expect(out).toContain(
      'cheer_up: [{ args: { m: "sad" | "ok" | "happy" }; returns: "sad" | "ok" | "happy"; set: false }];',
    );
    expect(out).toContain(
      "ovl: [{ args: { a: number }; returns: string; set: false }, { args: { a: string }; returns: string; set: false }];",
    );
    // a single unnamed parameter is the body itself; void is null; TABLE(...) columns are unknown to
    // the catalog, and to the request path too
    expect(out).toContain("echo_unnamed: [{ args: unknown; returns: unknown; set: false; raw: true }];");
    expect(out).toContain("nothing: [{ args: {}; returns: null; set: false }];");
    expect(out).toContain("client_summary: [{ args: { cid: number }; returns: Record<string, unknown>; set: true }];");
  });

  test("every exposed schema is in the generated type", async () => {
    const out = await generateTypes(cache, { name: "DatabasePgRest" });
    expect(out).toContain('default: "api";');
    expect(out).toContain("api: { relations: DatabasePgRestApiRelations; functions: DatabasePgRestApiFunctions };");
    expect(out).toContain("v2: { relations: DatabasePgRestV2Relations; functions: DatabasePgRestV2Functions };");
    expect(out).toContain("type DatabasePgRestV2Functions = {};");
  });
});
