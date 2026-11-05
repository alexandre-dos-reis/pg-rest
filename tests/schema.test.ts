import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, hasDb, type TestDb } from "./support/db";
import { findRelationships, getRelation, introspect, resolveRelationship, type SchemaCache } from "../src/schema";
import { PgRestError } from "../src/errors";

describe.skipIf(!hasDb)("schema introspection", () => {
  let db: TestDb;
  let cache: SchemaCache;
  beforeAll(async () => {
    db = await createTestDb();
    cache = await introspect(db.adapter, ["api", "v2"]);
  });
  afterAll(() => db.drop());

  test("loads relations, kinds and privileges", () => {
    const clients = getRelation(cache, "api", "clients");
    expect(clients.kind).toBe("table");
    expect(clients.pk).toEqual(["id"]);
    expect(clients.uniques).toEqual([["email"]]);
    expect(clients.insertable && clients.updatable && clients.deletable).toBe(true);
    expect(clients.comment).toBe("Our customers");
    expect(getRelation(cache, "api", "big_orders").kind).toBe("view");
    expect(getRelation(cache, "v2", "things").schema).toBe("v2");
  });

  test("loads enum labels, on columns and on functions", () => {
    const moods = getRelation(cache, "api", "moods");
    const col = (n: string) => moods.columns.find((c) => c.name === n)!;
    // format_type qualifies a type that is not in the search_path, which is why the labels are
    // attached to the column instead of being keyed by type name
    expect(col("mood").type).toBe("api.mood");
    expect(col("mood").enumLabels).toEqual(["sad", "ok", "happy"]);
    // an array of an enum carries the labels of its element type
    expect(col("seen").type).toBe("api.mood[]");
    expect(col("seen").enumLabels).toEqual(["sad", "ok", "happy"]);
    expect(col("note").enumLabels).toBeUndefined();

    const fn = cache.functions.get("api.cheer_up")![0]!;
    expect(fn.args[0]!.enumLabels).toEqual(["sad", "ok", "happy"]);
    expect(fn.returnEnumLabels).toEqual(["sad", "ok", "happy"]);
    expect(cache.functions.get("api.hello")![0]!.returnEnumLabels).toBeUndefined();
  });

  test("a view column knows the table column it is read from", () => {
    const total = getRelation(cache, "api", "big_orders").columns.find((c) => c.name === "total")!;
    expect(total.source).toEqual({ schema: "api", table: "orders", column: "total" });
    // the catalog always reports a view column as nullable, whatever the source says
    expect(total.nullable).toBe(true);
    // an aggregate is not read from a column, so it has no source
    expect(
      getRelation(cache, "api", "client_totals").columns.find((c) => c.name === "revenue")!.source,
    ).toBeUndefined();
    expect(getRelation(cache, "api", "orders").columns[0]!.source).toBeUndefined();
  });

  test("loads columns with types and defaults", () => {
    const orders = getRelation(cache, "api", "orders");
    const names = orders.columns.map((c) => c.name);
    expect(names).toEqual(["id", "client_id", "status", "total", "placed_at"]);
    const total = orders.columns.find((c) => c.name === "total")!;
    expect(total.type).toBe("numeric(10,2)");
    expect(total.nullable).toBe(false);
    expect(total.hasDefault).toBe(true);
    const email = getRelation(cache, "api", "clients").columns.find((c) => c.name === "email")!;
    expect(email.comment).toBe("Contact email");
  });

  test("a missing table gives PGRST205 with a suggestion", () => {
    try {
      getRelation(cache, "api", "client");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(PgRestError);
      const err = e as PgRestError;
      expect(err.status).toBe(404);
      expect(err.code).toBe("PGRST205");
      expect(err.hint).toContain("api.clients");
    }
  });

  test("resolves many-to-one, one-to-many and one-to-one", () => {
    const orders = getRelation(cache, "api", "orders");
    const clients = getRelation(cache, "api", "clients");
    expect(resolveRelationship(cache, orders, "clients").kind).toBe("m2o");
    expect(resolveRelationship(cache, clients, "orders").kind).toBe("o2m");
    const o2o = resolveRelationship(cache, clients, "profiles");
    expect(o2o.kind).toBe("o2o");
    expect(o2o.fromCols).toEqual(["id"]);
    expect(o2o.toCols).toEqual(["client_id"]);
  });

  test("resolves many-to-many through a junction table", () => {
    const orders = getRelation(cache, "api", "orders");
    const rel = resolveRelationship(cache, orders, "products");
    expect(rel.kind).toBe("m2m");
    expect(rel.junction?.relation.name).toBe("order_items");
  });

  test("self references: the table name means the children, the fk column means the parent", () => {
    const emp = getRelation(cache, "api", "employees");
    expect(findRelationships(cache, emp, "employees").map((r) => r.kind)).toEqual(["o2m"]);
    expect(findRelationships(cache, emp, "manager_id").map((r) => r.kind)).toEqual(["m2o"]);
    expect(resolveRelationship(cache, emp, "employees", "manager_id").kind).toBe("o2m");
  });

  test("a hint picks one of several foreign keys", () => {
    const rels = findRelationships(cache, getRelation(cache, "api", "orders"), "clients");
    expect(rels).toHaveLength(1);
    const hinted = resolveRelationship(cache, getRelation(cache, "api", "orders"), "clients", "orders_client_id_fkey");
    expect(hinted.kind).toBe("m2o");
    expect(() => resolveRelationship(cache, getRelation(cache, "api", "orders"), "clients", "nope")).toThrow(
      /Could not find a relationship/,
    );
  });

  test("unrelated tables give PGRST200", () => {
    const things = getRelation(cache, "v2", "things");
    expect(() => resolveRelationship(cache, things, "clients")).toThrow(/Could not find a relationship/);
  });

  test("loads functions with args, defaults and return shapes", () => {
    const fns = cache.functions;
    const add = fns.get("api.add")![0]!;
    expect(add.args.map((a) => [a.name, a.type])).toEqual([
      ["a", "integer"],
      ["b", "integer"],
    ]);
    expect(add.returnsSet).toBe(false);
    expect(add.returnsComposite).toBe(false);
    const greet = fns.get("api.greet")![0]!;
    expect(greet.args[0]!.hasDefault).toBe(true);
    const byStatus = fns.get("api.orders_by_status")![0]!;
    expect(byStatus.returnsSet && byStatus.returnsComposite).toBe(true);
    const summary = fns.get("api.client_summary")![0]!;
    expect(summary.returnsSet && summary.returnsComposite).toBe(true);
    expect(summary.args.map((a) => a.name)).toEqual(["cid"]);
    expect(fns.get("api.nothing")![0]!.returnsVoid).toBe(true);
    expect(add.volatility).toBe("immutable");
  });
});
