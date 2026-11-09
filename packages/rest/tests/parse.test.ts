import { describe, expect, test } from "bun:test";
import { parseSelect } from "../../core/src/parse/select";
import { parseLogic, parseOperatorExpr, parseOrder, parseQuery } from "../src/parse/query-string";
import { parseField } from "../../core/src/parse/field";
import { parseAccept, parseCsv, parsePrefer, parseRange, parseTarget } from "../src/request";
import { toApiError } from "../src/errors";

const q = (qs: string) => parseQuery([...new URLSearchParams(qs)]);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return toApiError(e, undefined, undefined).body.code;
  }
  return "no error";
};

describe("field parsing", () => {
  test("plain, quoted and JSON path", () => {
    expect(parseField("name")).toEqual({ name: "name", json: [] });
    expect(parseField('"odd col"')).toEqual({ name: "odd col", json: [] });
    expect(parseField("meta->address->>city")).toEqual({
      name: "meta",
      json: [
        { arrow: "->", key: "address", isIndex: false },
        { arrow: "->>", key: "city", isIndex: false },
      ],
    });
    expect(parseField("tags->0").json[0]).toEqual({ arrow: "->", key: "0", isIndex: true });
  });
});

describe("select parsing", () => {
  test("star, columns, aliases and casts", () => {
    expect(parseSelect("")).toEqual([{ kind: "star" }]);
    const items = parseSelect("id,full:name,total::text,meta->>tier");
    expect(items.map((i) => i.kind)).toEqual(["field", "field", "field", "field"]);
    expect((items[1] as any).alias).toBe("full");
    expect((items[2] as any).cast).toBe("text");
  });
  test("rejects unsafe cast targets", () => {
    expect(code(() => parseSelect("a::text);drop table x;--"))).toBe("PGRST100");
    expect(code(() => parseSelect("a::int4 as x"))).toBe("PGRST100");
    expect(code(() => parseSelect("a::int4 from secrets"))).toBe("PGRST100");
    expect(code(() => parseSelect("a::text union select 1"))).toBe("PGRST100");
    expect(code(() => parseSelect('a::"text"'))).toBe("PGRST100");
  });
  test("accepts legitimate cast targets", () => {
    for (const t of [
      "text",
      "int4",
      "numeric(10,2)",
      "text[]",
      "double precision",
      "timestamp with time zone",
      "timestamp(3) without time zone",
      "public.my_type",
      "character varying(20)",
    ]) {
      expect((parseSelect(`a::${t}`)[0] as any).cast).toBe(t);
    }
  });
  test("embeds with hints, join type, alias and nesting", () => {
    const [e] = parseSelect("buyer:clients!orders_client_id_fkey!inner(id,name,orders(*))");
    expect(e).toMatchObject({
      kind: "embed",
      target: "clients",
      alias: "buyer",
      hint: "orders_client_id_fkey",
      join: "inner",
      spread: false,
    });
    expect((e as any).items[2].kind).toBe("embed");
  });
  test("spread and aggregates", () => {
    expect(parseSelect("...profiles(bio)")[0]).toMatchObject({ kind: "embed", spread: true });
    expect(parseSelect("count()")[0]).toMatchObject({ kind: "aggregate", fn: "count" });
    expect(parseSelect("total.sum()")[0]).toMatchObject({ kind: "aggregate", fn: "sum" });
    expect(parseSelect("revenue:total.sum()::int")[0]).toMatchObject({ alias: "revenue", cast: "int" });
    // a bare sum() is an embedded resource named "sum", as in PostgREST
    expect(parseSelect("sum()")[0]).toMatchObject({ kind: "embed", target: "sum" });
    expect(code(() => parseSelect("...name"))).toBe("PGRST100");
  });
  test("commas inside parentheses do not split items", () => {
    expect(parseSelect("a,b(c,d),e")).toHaveLength(3);
  });
});

describe("filters", () => {
  const f = (expr: string, unq = false) => parseOperatorExpr(parseField("x"), expr, unq);
  test("simple operators", () => {
    expect(f("eq.5")).toMatchObject({ op: "eq", value: "5", negate: false });
    expect(f("not.gt.5")).toMatchObject({ op: "gt", negate: true });
    expect(f("like.a*b")).toMatchObject({ op: "like", value: "a*b" });
    expect(f("cs.{a,b}")).toMatchObject({ op: "cs", value: "{a,b}" });
    expect(f("eq.a.b.c")).toMatchObject({ value: "a.b.c" });
  });
  test("in lists with quotes", () => {
    expect(f('in.(1,"a,b",c)')).toMatchObject({ op: "in", value: ["1", "a,b", "c"] });
    expect(f("in.()")).toMatchObject({ value: [] });
    expect(code(() => f("in.1,2"))).toBe("PGRST100");
  });
  test("is values", () => {
    expect(f("is.null")).toMatchObject({ op: "is", value: "null" });
    expect(f("is.not_null")).toMatchObject({ op: "is", value: "not_null" });
    expect(code(() => f("is.maybe"))).toBe("PGRST100");
  });
  test("quantifiers and fts language", () => {
    expect(f("eq(any).{1,2}")).toMatchObject({ quantifier: "any" });
    expect(f("like(all).{a*,b*}")).toMatchObject({ quantifier: "all" });
    expect(f("fts(english).cat")).toMatchObject({ op: "fts", lang: "english", value: "cat" });
    expect(code(() => f("eq(some).1"))).toBe("PGRST100");
    expect(code(() => f("is(any).null"))).toBe("PGRST100");
    expect(code(() => f("fts(en;glish).cat"))).toBe("PGRST100");
  });
  test("unknown operator", () => {
    expect(code(() => f("foo.1"))).toBe("PGRST100");
    expect(code(() => f("eq"))).toBe("PGRST100");
  });
  test("logic trees", () => {
    const t = parseLogic("or", false, '(a.eq.1,and(b.gt.2,c.lt.3),not.or(d.is.null,e.eq."x,y"))');
    expect(t.children).toHaveLength(3);
    expect((t.children[1] as any).op).toBe("and");
    const not = t.children[2] as any;
    expect(not.negate).toBe(true);
    expect(not.children[1].value).toBe("x,y");
    expect(code(() => parseLogic("and", false, "a.eq.1"))).toBe("PGRST100");
  });
});

describe("order", () => {
  test("directions, nulls and related", () => {
    expect(parseOrder("a,b.desc,c.asc.nullsfirst,meta->x.desc.nullslast")).toMatchObject([
      { field: { name: "a" }, dir: "asc" },
      { field: { name: "b" }, dir: "desc" },
      { field: { name: "c" }, dir: "asc", nulls: "first" },
      { field: { name: "meta" }, dir: "desc", nulls: "last" },
    ]);
    expect(parseOrder("clients(name).desc")[0]).toMatchObject({
      relation: "clients",
      field: { name: "name" },
      dir: "desc",
    });
  });
});

describe("query strings", () => {
  test("root filters, order and paging", () => {
    const p = q(
      "select=id,name&id=gt.1&id=lt.10&order=name.desc&limit=5&offset=2&or=(a.eq.1,b.eq.2)&not.and=(c.eq.1,d.eq.2)",
    );
    expect(p.root.filters).toHaveLength(4);
    expect(p.root.order).toHaveLength(1);
    expect(p.root.limit).toBe(5);
    expect(p.root.offset).toBe(2);
    expect((p.root.filters[3] as any).negate).toBe(true);
  });
  test("embedded resource params, by alias and legacy table name", () => {
    const p = q(
      "select=id,o:orders(id,items(*))&o.status=eq.paid&o.order=id.desc&o.limit=2&o.items.qty=gt.1&orders.total=gt.5",
    );
    expect(p.embeds.get("o")!.filters).toHaveLength(2);
    expect(p.embeds.get("o")!.limit).toBe(2);
    expect(p.embeds.get("o.items")!.filters).toHaveLength(1);
  });
  test("filtering an embed that is not selected is PGRST108", () => {
    expect(code(() => q("select=id&orders.status=eq.paid"))).toBe("PGRST108");
  });
  test("embed presence filters", () => {
    const p = q("select=id,orders(*)&orders=is.null");
    expect(p.root.presence).toEqual([{ embed: "orders", present: false }]);
    expect(q("select=id,orders(*)&orders=not.is.null").root.presence[0]!.present).toBe(true);
    expect(code(() => q("select=id,orders(*)&orders=eq.1"))).toBe("PGRST120");
  });
  test("conflict / columns params", () => {
    const p = q("on_conflict=email,id&columns=a,b");
    expect(p.onConflict).toEqual(["email", "id"]);
    expect(p.columns).toEqual(["a", "b"]);
    expect(p.root.filters).toHaveLength(0);
  });
  test("bad limit", () => {
    // PostgREST ignores values that are not non-negative integers.
    expect(code(() => q("limit=abc"))).toBe("no error");
    expect(code(() => q("offset=-1"))).toBe("no error");
  });
});

describe("headers and routing", () => {
  test("Prefer", () => {
    expect(parsePrefer("return=representation, count=exact")).toMatchObject({
      return: "representation",
      count: "exact",
      invalid: [],
    });
    expect(parsePrefer("resolution=merge-duplicates,max-affected=3,tx=rollback,timezone=Europe/Paris")).toMatchObject({
      resolution: "merge-duplicates",
      maxAffected: 3,
      tx: "rollback",
      timezone: "Europe/Paris",
    });
    expect(parsePrefer("return=nope,foo").invalid).toEqual(["return=nope", "foo"]);
  });
  test("Range", () => {
    expect(parseRange("0-9", "items")).toEqual({ offset: 0, limit: 10 });
    expect(parseRange("5-", null)).toEqual({ offset: 5 });
    expect(parseRange(null, null)).toBeUndefined();
    expect(code(() => parseRange("9-1", "items"))).toBe("PGRST103");
  });
  test("Accept", () => {
    expect(parseAccept(null, false)).toEqual({ kind: "json", stripNulls: false });
    expect(parseAccept("text/csv", false)).toEqual({ kind: "csv" });
    expect(parseAccept("application/vnd.pgrst.object+json;nulls=stripped", false)).toEqual({
      kind: "object",
      stripNulls: true,
    });
    expect(parseAccept("text/html;q=0.5, application/json", false)).toEqual({ kind: "json", stripNulls: false });
    expect(parseAccept("*/*", true)).toEqual({ kind: "openapi" });
    expect(code(() => parseAccept("image/png", false))).toBe("PGRST107");
  });
  test("paths", () => {
    expect(parseTarget("/")).toEqual({ type: "root" });
    expect(parseTarget("/clients")).toEqual({ type: "table", name: "clients" });
    expect(parseTarget("/rpc/add")).toEqual({ type: "rpc", name: "add" });
    expect(parseTarget("/api/clients", "/api")).toEqual({ type: "table", name: "clients" });
    expect(parseTarget("/api", "/api")).toEqual({ type: "root" });
    expect(code(() => parseTarget("/a/b"))).toBe("PGRST125");
    expect(code(() => parseTarget("/other/x", "/api"))).toBe("PGRST125");
    expect(parseTarget("/odd%20name")).toEqual({ type: "table", name: "odd name" });
  });
  test("csv", () => {
    expect(parseCsv('a,b\n1,"x,y"\n2,\n')).toEqual([
      { a: "1", b: "x,y" },
      { a: "2", b: null },
    ]);
    expect(parseCsv('a\n"he said ""hi"""')).toEqual([{ a: 'he said "hi"' }]);
  });
});
