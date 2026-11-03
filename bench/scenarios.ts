/** What gets measured. `auth: true` sends a JWT to PostgREST and `X-User` to pg-rest. */
export interface Scenario {
  readonly name: string;
  readonly what: string;
  readonly method?: "GET" | "POST" | "PATCH";
  readonly path: string;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly auth?: boolean;
  /** Don't compare bodies (writes). */
  readonly skipEquality?: boolean;
}

export const scenarios: Scenario[] = [
  { name: "pk-lookup", what: "one row by primary key", path: "/clients?id=eq.1234" },
  { name: "list-50", what: "50 rows, 3 columns, ordered", path: "/clients?select=id,name,email&order=id&limit=50" },
  { name: "filter-index", what: "two filters on an indexed pair, 20 rows", path: "/orders?select=id,total&status=eq.paid&total=gt.900&order=id&limit=20" },
  { name: "search-ilike", what: "ilike over 20k rows (seq scan), 20 rows", path: "/clients?select=id,name&name=ilike.*johnson*&order=id&limit=20" },
  { name: "embed-to-one", what: "many-to-one embed, 50 rows", path: "/orders?select=id,total,clients(name,email)&order=id&limit=50" },
  { name: "embed-to-many", what: "one-to-many embed, 20 parents", path: "/clients?select=id,name,orders(id,total,status)&order=id&limit=20" },
  { name: "embed-nested-m2m", what: "orders -> items -> products, 20 rows", path: "/orders?select=id,order_items(qty,products(name,price))&order=id&order_items.order=product_id&limit=20" },
  { name: "count-exact", what: "page of 10 + exact count over 100k rows", path: "/orders?select=id&order=id&limit=10", headers: { Prefer: "count=exact" } },
  { name: "aggregate", what: "group by + sum/count over 100k rows", path: "/orders?select=status,total.sum(),count()&order=status" },
  { name: "rpc-scalar", what: "scalar function", path: "/rpc/add?a=1&b=2" },
  { name: "rpc-set", what: "set-returning function, 20 rows", path: "/rpc/orders_by_status?s=paid&select=id,total&order=id&limit=20" },
  { name: "auth-read-rls", what: "authenticated read under RLS", path: "/notes?select=id,body&order=id&limit=20", auth: true },
  { name: "insert", what: "single-row insert, authenticated", method: "POST", path: "/products", body: { name: "bench", price: 9.5 }, headers: { Prefer: "return=minimal" }, auth: true, skipEquality: true },
  { name: "update-pk", what: "update one row by primary key, authenticated", method: "PATCH", path: "/products?id=eq.1", body: { price: 12.5 }, headers: { Prefer: "return=minimal" }, auth: true, skipEquality: true },
];
