/**
 * Requests replayed against both PostgREST 16 and pg-rest on the same database.
 * `as`: who is calling (anon by default). `known`: documented, intentional difference —
 * the test then asserts the responses still differ, so stale entries get noticed.
 */
export interface Case {
  readonly name: string;
  readonly method?: string;
  readonly path: string;
  readonly headers?: Record<string, string>;
  /** Objects are JSON-encoded; strings are sent as-is. */
  readonly body?: unknown;
  readonly as?: "anon" | "alice" | "bob";
  readonly known?: string;
  /** Skip comparing the body (compare status and headers only). */
  readonly ignoreBody?: boolean;
}

const get = (path: string, extra: Partial<Case> = {}): Case => ({ name: `GET ${path}`, path, ...extra });
const post = (path: string, body: unknown, extra: Partial<Case> = {}): Case => ({ name: `POST ${path} ${JSON.stringify(body)}`, method: "POST", path, body, ...extra });
const write = (method: string, path: string, body: unknown, extra: Partial<Case> = {}): Case => ({
  name: `${method} ${path}${body === undefined ? "" : " " + JSON.stringify(body)}`,
  method,
  path,
  body,
  as: "alice",
  ...extra,
  headers: { Prefer: "tx=rollback", ...(extra.headers ?? {}) }, // leave the shared database untouched
});
const rep = { Prefer: "return=representation, tx=rollback" };
const J = { "Content-Type": "application/json" };

const allCases: Case[] = [
  // ── reading ──────────────────────────────────────────────
  get("/clients?order=id"),
  get("/clients?select=id,name&order=id"),
  get("/clients?select=id,name&id=eq.2"),
  get("/clients?select=name&order=name.desc"),
  get("/clients?select=id&order=name.asc.nullsfirst,id"),
  get("/clients?select=who:name,id&order=id"),
  get("/clients?select=id::text&order=id"),
  get("/clients?select=meta->tier,meta->>tier,meta->address->>city&order=id"),
  get("/clients?select=id&meta->>tier=eq.gold"),
  get("/clients?select=id&name=like.*a*&order=id"),
  get("/clients?select=id&name=ilike.*A*&order=id"),
  get("/clients?select=id&name=in.(Ada,Grace)&order=id"),
  get('/clients?select=id&name=in.("Ada","Linus")&order=id'),
  get("/clients?select=id&id=not.in.(1,2)"),
  get("/clients?select=id&id=gt.1&id=lte.3&order=id"),
  get("/clients?select=id&email=is.null"),
  get("/clients?select=id&meta=is.null"),
  get("/clients?select=id&meta=not.is.null&order=id"),
  get("/clients?select=id&tags=cs.{vip}&order=id"),
  get("/clients?select=id&tags=cd.{vip,early,x}&order=id"),
  get("/clients?select=id&tags=ov.{oss,navy}&order=id"),
  get("/clients?select=id&meta=cs.{\"tier\":\"gold\"}"),
  get("/clients?select=id&or=(id.eq.1,id.eq.3)&order=id"),
  get("/clients?select=id&and=(id.gt.1,or(name.eq.Grace,name.eq.Linus))&order=id"),
  get("/clients?select=id&not.or=(id.eq.1,id.eq.2)"),
  get("/clients?select=id&name=eq.Ada&name=eq.Linus"),
  get("/clients?select=id&id=eq.1,2"),
  get("/clients?select=id&name=match.^A"),
  get("/clients?select=id&name=imatch.^a"),
  get("/clients?select=id&id=eq.any.{1,2}&order=id", { name: "quantifier eq.any" }),
  get("/clients?select=id&name=like(any).{A*,G*}&order=id"),
  get("/clients?select=id&name=isdistinct.Ada&order=id"),
  get("/clients?select=name&name=fts.ada"),
  get("/clients?select=id&limit=2&order=id"),
  get("/clients?select=id&limit=2&offset=1&order=id"),
  get("/clients?select=id&offset=10"),
  get("/clients?select=id&order=id", { headers: { Range: "0-1", "Range-Unit": "items" } }),
  get("/clients?select=id&order=id", { headers: { Range: "5-9" }, name: "range out of bounds" }),
  get("/clients?select=id&order=id", { headers: { Prefer: "count=exact" } }),
  get("/clients?select=id&order=id&limit=1", { headers: { Prefer: "count=exact" } }),
  get("/clients?select=id&order=id&limit=1&offset=5", { headers: { Prefer: "count=exact" } }),
  get("/clients?select=id&order=id", { headers: { Prefer: "count=none" } }),
  get("/clients?select=id,name&order=id", { headers: { Accept: "text/csv" } }),
  get("/clients?select=id,name,tags&order=id", { headers: { Accept: "text/csv" }, name: "csv with array" }),
  get("/clients?select=id,name&id=eq.1", { headers: { Accept: "application/vnd.pgrst.object+json" } }),
  get("/clients?select=id,name", { headers: { Accept: "application/vnd.pgrst.object+json" }, name: "singular with many rows" }),
  get("/clients?select=id,name&id=eq.99", { headers: { Accept: "application/vnd.pgrst.object+json" }, name: "singular with no row" }),
  get("/clients?select=id,meta&order=id", { headers: { Accept: "application/vnd.pgrst.array+json;nulls=stripped" } }),
  get("/clients?select=id,meta&id=eq.3", { headers: { Accept: "application/vnd.pgrst.object+json;nulls=stripped" } }),
  get("/clients?select=id", { headers: { Accept: "application/xml" } }),
  get("/orders?select=id,total,placed_at&order=id"),
  get("/orders?select=id&total=gte.99.99&order=id"),
  get("/orders?select=status,total.sum()&order=status", { name: "aggregate sum group by" }),
  get("/orders?select=count()"),
  get("/orders?select=status,count()&order=status"),
  get("/orders?select=total.max(),total.min(),total.avg()"),
  get("/orders?select=cnt:id.count(),status&order=status"),
  get("/big_orders?select=id&order=id"),
  get("/client_totals?select=client_id,revenue&order=client_id"),
  get("/things?select=id", { headers: { "Accept-Profile": "v2" }, name: "other schema via Accept-Profile" }),
  get("/things?select=id", { name: "other schema without profile" }),
  get("/clients?select=id", { headers: { "Accept-Profile": "nope" }, name: "unknown schema" }),
  get("/nope"),
  get("/client", { name: "near-miss table name hint" }),
  get("/orderz", { name: "near-miss table name hint 2" }),
  get("/clients?select=nope"),
  get("/clients?nope=eq.1"),
  get("/clients?order=nope"),
  get("/clients?id=eq.abc", { name: "type error in filter" }),
  get("/clients?select=id&limit=abc"),
  get("/clients?select=id&id=bogus.1"),
  get("/clients?select=id,,name"),
  get("/clients?select=id::int4%20from%20x"),

  // ── embedding ────────────────────────────────────────────
  get("/orders?select=id,clients(name)&order=id"),
  get("/clients?select=id,orders(id,status)&order=id&orders.order=id"),
  get("/clients?select=id,orders(id)&order=id&orders.order=id.desc"),
  get("/clients?select=id,orders(id,status)&order=id&orders.status=eq.paid&orders.order=id"),
  get("/clients?select=id,orders(id)&order=id&orders.limit=1&orders.order=id"),
  get("/clients?select=id,profiles(bio)&order=id", { name: "embed one-to-one" }),
  get("/clients?select=id,profiles!inner(bio)&order=id"),
  get("/clients?select=id,orders!inner(id)&order=id&orders.status=eq.shipped"),
  get("/clients?select=id,profiles(bio)&profiles=is.null&order=id", { name: "embed presence filter is.null" }),
  get("/clients?select=id,profiles(bio)&profiles=not.is.null&order=id"),
  get("/orders?select=id,products(name)&order=id&products.order=name", { name: "many-to-many" }),
  get("/orders?select=id,order_items(qty,products(name))&order=id&id=eq.1", { name: "nested" }),
  get("/clients?select=id,orders(id,order_items(qty))&order=id&id=eq.1"),
  get("/orders?select=id,client:clients(name)&order=id", { name: "alias" }),
  get("/orders?select=id,c:client_id(name)&order=id", { name: "hint by fk column" }),
  get("/orders?select=id,clients!orders_client_id_fkey(name)&order=id", { name: "hint by constraint" }),
  get("/orders?select=id,...clients(name)&order=id", { name: "spread to-one" }),
  get("/employees?select=id,employees(id)", { name: "self reference is ambiguous" }),
  get("/employees?select=id,employees!manager_id(name)&order=id", { name: "self reference with hint" }),
  get("/clients?select=id,nope(id)", { name: "unknown embed" }),
  get("/clients?select=id,orders(count)&order=id", { name: "embedded count" }),
  get("/orders?select=id&order=clients(name)", { name: "order by related column" }),
  get("/clients?select=id,orders(id)&order=id&limit=1", { name: "limit on root with embed" }),
  get("/clients?select=id,orders(id)&id=eq.1", { headers: { Accept: "application/vnd.pgrst.object+json" } }),

  // ── RLS / identity ───────────────────────────────────────
  get("/notes?select=body&order=id", { as: "alice", name: "notes as alice (RLS)" }),
  get("/notes?select=body&order=id", { name: "notes as anon" }),
  write("POST", "/notes", { body: "hello" }, { headers: { ...rep, ...J }, as: "alice" }),
  write("POST", "/notes", { body: "hello" }, { headers: { ...rep, ...J }, as: "anon" , name: "anon insert is denied" }),
  get("/rpc/whoami", { as: "alice" }),
  get("/rpc/whoami", { as: "anon" }),

  // ── writes (always rolled back) ──────────────────────────
  write("POST", "/clients", { name: "Zed", email: "zed@example.com" }, { headers: { ...rep, ...J } }),
  write("POST", "/clients", { name: "Zed" }, { headers: { Prefer: "tx=rollback", ...J }, name: "insert minimal" }),
  write("POST", "/clients", { name: "Zed" }, { headers: { Prefer: "return=headers-only, tx=rollback", ...J }, name: "insert headers-only" }),
  write("POST", "/clients?select=id,name", [{ name: "A" }, { name: "B" }], { headers: { ...rep, ...J }, name: "bulk insert with select" }),
  write("POST", "/clients", [{ name: "A", email: "a@x" }, { name: "B" }], { headers: { ...rep, ...J }, name: "bulk insert with missing keys" }),
  write("POST", "/clients", [{ name: "A", email: "a@x" }, { name: "B" }], { headers: { Prefer: "return=representation, missing=default, tx=rollback", ...J } }),
  write("POST", "/clients?columns=name", { name: "C", email: "ignored@x" }, { headers: { ...rep, ...J } }),
  write("POST", "/clients?on_conflict=email", { name: "New", email: "new@example.com" }, { headers: { Prefer: "resolution=merge-duplicates, return=representation, tx=rollback", ...J }, name: "merge-duplicates inserting a new row" }),
  write("POST", "/clients?columns=name,email&select=name,email", [{ name: "A", email: "a@x" }, { name: "B" }], { headers: { Prefer: "return=representation, missing=default, tx=rollback", ...J }, name: "bulk insert with columns + missing=default" }),
  write("POST", "/clients?columns=nope", { name: "C" }, { headers: { ...rep, ...J } }),
  write("POST", "/clients", { nope: 1 }, { headers: { ...rep, ...J }, name: "unknown column in body" }),
  write("POST", "/clients", { email: "x@x" }, { headers: { ...rep, ...J }, name: "not-null violation" }),
  write("POST", "/clients", { name: "dup", email: "ada@example.com" }, { headers: { ...rep, ...J }, name: "unique violation" }),
  write("POST", "/orders", { client_id: 999 }, { headers: { ...rep, ...J }, name: "foreign key violation" }),
  write("POST", "/clients?on_conflict=email", { name: "Ada2", email: "ada@example.com" }, { headers: { Prefer: "resolution=merge-duplicates, return=representation, tx=rollback", ...J } , name: "upsert merge-duplicates on an existing row" }),
  write("POST", "/clients?on_conflict=email", { name: "Ada2", email: "ada@example.com" }, { headers: { Prefer: "resolution=ignore-duplicates, return=representation, tx=rollback", ...J } , name: "upsert ignore-duplicates on an existing row" }),
  write("POST", "/clients", "name,email\nCsv,csv@x\n", { headers: { ...rep, "Content-Type": "text/csv" }, name: "csv body" }),
  write("POST", "/clients", "name=Form&email=form%40x", { headers: { ...rep, "Content-Type": "application/x-www-form-urlencoded" }, name: "urlencoded body" }),
  write("POST", "/clients", "{not json", { headers: { ...rep, ...J }, name: "invalid json body" }),
  write("PATCH", "/clients?id=eq.1", { name: "Renamed" }, { headers: { ...rep, ...J } }),
  write("PATCH", "/clients?id=eq.1", { name: "Renamed" }, { headers: { Prefer: "tx=rollback", ...J }, name: "patch minimal" }),
  write("PATCH", "/clients?id=eq.99", { name: "x" }, { headers: { ...rep, ...J }, name: "patch no match" }),
  write("PATCH", "/clients?id=eq.1&select=id,name", { name: "x" }, { headers: { ...rep, ...J } }),
  write("PATCH", "/clients", { name: "all" }, { headers: { ...rep, ...J }, name: "patch without filter" }),
  write("PATCH", "/clients?id=lt.3&order=id", { name: "two" }, { headers: { ...rep, ...J, Prefer: "return=representation, handling=strict, max-affected=1, tx=rollback" }, name: "max-affected exceeded" }),
  write("PATCH", "/clients?id=eq.1", {}, { headers: { ...rep, ...J }, name: "patch empty body" }),
  write("DELETE", "/order_items?order_id=eq.1", undefined, { headers: { ...rep } }),
  write("DELETE", "/order_items?order_id=eq.1", undefined, { name: "delete minimal" }),
  write("DELETE", "/order_items", undefined, { headers: { ...rep }, name: "delete without filter" }),
  write("DELETE", "/orders?id=eq.1", undefined, { headers: { ...rep }, name: "delete cascade children (fk restrict)" }),
  write("POST", "/client_totals", { client_id: 1 }, { headers: { ...rep, ...J }, name: "insert into non-updatable view" }),
  write("POST", "/big_orders", { client_id: 1, status: "x", total: 500 }, { headers: { ...rep, ...J }, name: "insert through view" }),
  write("PUT", "/clients?id=eq.1", { id: 1, name: "Put", email: "ada@example.com" }, { headers: { ...rep, ...J } }),
  write("PUT", "/clients?id=eq.1", { id: 2, name: "Put" }, { headers: { ...rep, ...J }, name: "put pk mismatch" }),
  write("PUT", "/clients", { id: 1, name: "Put" }, { headers: { ...rep, ...J }, name: "put without pk filter" }),
  write("PUT", "/clients?id=eq.1&limit=1", { id: 1, name: "Put" }, { headers: { ...rep, ...J }, name: "put with limit" }),

  // ── RPC ──────────────────────────────────────────────────
  get("/rpc/add?a=1&b=2"),
  post("/rpc/add", { a: 1, b: 2 }),
  post("/rpc/add", { a: "x", b: 2 }, { name: "rpc bad arg type" }),
  post("/rpc/add", { a: 1 }, { name: "rpc missing arg" }),
  post("/rpc/add", { a: 1, b: 2, c: 3 }, { name: "rpc extra arg" }),
  get("/rpc/hello"),
  get("/rpc/greet"),
  get("/rpc/greet?name=Ada"),
  get("/rpc/nums"),
  get("/rpc/first_client"),
  get("/rpc/first_client?select=id,name"),
  get("/rpc/orders_by_status?s=paid&select=id,total&order=id"),
  get("/rpc/orders_by_status?s=paid&total=gt.100&select=id"),
  get("/rpc/orders_by_status?s=paid&select=id,clients(name)&order=id", { name: "rpc with embed" }),
  get("/rpc/orders_by_status?s=paid&order=id&limit=1", { headers: { Prefer: "count=exact" } }),
  get("/rpc/orders_by_status?s=shipped", { headers: { Accept: "application/vnd.pgrst.object+json" } }),
  get("/rpc/orders_by_status?s=paid", { headers: { Accept: "application/vnd.pgrst.object+json" }, name: "rpc singular many rows" }),
  post("/rpc/client_summary", { cid: 1 }),
  post("/rpc/echo_unnamed", [{ a: 1 }, { b: [1, 2] }], { name: "rpc unnamed json param" }),
  post("/rpc/echo_json", { body: { k: "v" } }),
  post("/rpc/nothing", {}, { as: "alice" }),
  post("/rpc/boom", {}),
  post("/rpc/with_headers", {}),
  post("/rpc/ovl", { a: 1 }, { name: "rpc ambiguous overload" }),
  post("/rpc/nope", {}),
  { name: "rpc DELETE not allowed", method: "DELETE", path: "/rpc/add" },
  get("/rpc/add_note?txt=x", { as: "alice", name: "GET on volatile function" }),
  post("/rpc/add_note", { txt: "x" }, { as: "alice", headers: { Prefer: "tx=rollback" } }),
  get("/rpc/req_info", { headers: { "X-Test": "hello", Cookie: "sid=abc" }, name: "request GUCs" }),
  get("/rpc/add?a=1&b=2", { headers: { Accept: "text/csv" }, name: "scalar as csv" }),

  // ── misc ─────────────────────────────────────────────────
  { name: "OPTIONS /clients", method: "OPTIONS", path: "/clients", ignoreBody: true },
  { name: "HEAD /clients", method: "HEAD", path: "/clients?select=id" },
  { name: "HEAD with count", method: "HEAD", path: "/clients?select=id", headers: { Prefer: "count=exact" } },
  { name: "PATCH unknown table", method: "PATCH", path: "/nope", body: {}, headers: J },
  { name: "TRACE not supported", method: "TRACE", path: "/clients" },
  get("/", { name: "OpenAPI root status", ignoreBody: true }),
];

/**
 * Differences that are understood and accepted (or not implemented yet), keyed by case name.
 * The test asserts the responses still differ, so an entry that starts matching must be removed.
 */
const KNOWN: Record<string, string> = {
  "csv with array": "PostgREST renders array columns in PostgreSQL text syntax ({a,b}); pg-rest renders JSON",
  "GET /clients?select=id&limit=abc": "PostgREST ignores a non-numeric limit; pg-rest rejects it with PGRST100",
  "GET /clients?select=id&id=bogus.1": "parser error texts (details) differ: PostgREST quotes its parsec output",
  "GET /clients?select=id,,name": "parser error texts (message/details) differ: PostgREST quotes its parsec output",
  "GET /clients?select=id::int4%20from%20x": "pg-rest rejects cast targets that are not plain type names (PGRST100); PostgREST forwards them to PostgreSQL (42601)",
  "order by related column": "ordering by a related column is not implemented (PGRST127); PostgREST supports it for embedded to-one relations",
  "upsert merge-duplicates on an existing row": "PostgREST answers 200 when a merge-duplicates upsert only updated rows; pg-rest always answers 201",
  "invalid json body": "details of the JSON parse error come from different parsers",
  "rpc unnamed json param": "PostgREST rejects an array body with differing keys even for a single unnamed json parameter",
  "scalar as csv": "text/csv for a scalar function result is not supported",
  "TRACE not supported": "PostgREST answers unsupported methods with an empty body; pg-rest with a PGRST117 JSON error",
};

export const cases: Case[] = allCases.map((c) => {
  const key = c.name + (c.as && c.as !== "anon" ? "" : "");
  const reason = KNOWN[key];
  return reason ? { ...c, known: reason } : c;
});
