# `query()` — asking in-process

pg-rest is a library, so the HTTP envelope is optional: `query()` takes a plain object, runs in the calling process, and
goes through the same parser, the same SQL and the same errors as `handle(request)`. One example per field below; the
options of the instance itself are in [`options.md`](options.md), and the types the examples rely on in
[`types.md`](types.md).

Every TypeScript block below is compiled by `tests/docs.test.ts` against the schema it describes, so an example that
drifts fails the build. The ones that are meant to be refused carry `@ts-expect-error`, which is how the check knows.

<!-- toc -->

- [The schema these examples use](#the-schema-these-examples-use)
- [Getting an instance](#getting-an-instance)
- [Reading](#reading)
  - [Columns](#columns)
  - [Embedded resources](#embedded-resources)
  - [Filters](#filters)
  - [Order, paging, and one row](#order-paging-and-one-row)
- [Writing](#writing)
- [Calling a function](#calling-a-function)
- [Who is asking](#who-is-asking)
  - [Binding it once](#binding-it-once)
- [Transactions](#transactions)
  - [What rolls a scope back](#what-rolls-a-scope-back)
  - [Letting one query fail: a nested scope](#letting-one-query-fail-a-nested-scope)
  - [What the scope decides, and not the query](#what-the-scope-decides-and-not-the-query)
- [Errors](#errors)
  - [`kind`: the error to switch on](#kind-the-error-to-switch-on)
- [What the typed path does not describe](#what-the-typed-path-does-not-describe)
- [Every field](#every-field)
  - [What comes back](#what-comes-back)

## The schema these examples use

```sql
CREATE TABLE api.clients (
  id serial PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  meta jsonb,
  tags text[],
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api.profiles (
  client_id int PRIMARY KEY REFERENCES api.clients(id),
  bio text
);

CREATE TABLE api.orders (
  id serial PRIMARY KEY,
  client_id int NOT NULL REFERENCES api.clients(id),
  status text NOT NULL DEFAULT 'new',
  total numeric(10,2) NOT NULL DEFAULT 0,
  placed_at date DEFAULT current_date
);

CREATE TABLE api.products (
  id serial PRIMARY KEY,
  name text NOT NULL,
  price numeric(10,2) NOT NULL
);

-- composite types, one nested in the other
CREATE TYPE api.address AS (city text, zip text);
CREATE TYPE api.contact AS (name text, home api.address, tags text[]);

CREATE TABLE api.venues (
  id serial PRIMARY KEY,
  label text NOT NULL,
  owner api.contact,
  branches api.address[],
  meta jsonb
);

CREATE TABLE api.order_items (
  order_id int REFERENCES api.orders(id),
  product_id int REFERENCES api.products(id),
  qty int NOT NULL DEFAULT 1,
  PRIMARY KEY (order_id, product_id)
);

CREATE TABLE api.employees (
  id serial PRIMARY KEY,
  name text NOT NULL,
  manager_id int REFERENCES api.employees(id)
);

CREATE TYPE api.mood AS ENUM ('sad', 'ok', 'happy');

CREATE TABLE api.moods (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mood api.mood NOT NULL DEFAULT 'ok',
  seen api.mood[],
  note text
);

-- notes is protected by row level security: a caller only sees and writes its own
CREATE TABLE api.notes (
  id serial PRIMARY KEY,
  owner text NOT NULL DEFAULT (… ->> 'sub'),
  body text NOT NULL
);

CREATE VIEW api.big_orders AS SELECT * FROM api.orders WHERE total > 100;
CREATE VIEW api.client_totals AS SELECT client_id, sum(total) AS revenue FROM api.orders GROUP BY client_id;

CREATE FUNCTION api.add(a int, b int) RETURNS int …;
CREATE FUNCTION api.greet(name text DEFAULT 'world') RETURNS text …;
CREATE FUNCTION api.orders_by_status(s text) RETURNS SETOF api.orders …;
CREATE FUNCTION api.nothing() RETURNS void …;
CREATE FUNCTION api.ovl(a int) RETURNS text …;   -- overloaded
CREATE FUNCTION api.ovl(a text) RETURNS text …;
-- a computed relationship: a function of a row, embeddable like a foreign key
CREATE FUNCTION api.recent_orders(api.clients) RETURNS SETOF api.orders …;
```

## Getting an instance

Without a type argument, the input is loosely typed and you name the result yourself:

```ts
const pgRest = await createPgRest({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const { data } = await pgRest.query<Array<{ id: number; name: string }>>({
  table: "clients",
  select: ["id", "name"],
});
```

With one, everything inside is checked and the result is inferred. The type comes from the catalog — see [`types.md`](types.md):

```ts
import type { Database } from "./db.types.ts";

const pgRest = await createPgRest<Database>({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const { data } = await pgRest.query({ table: "clients", select: ["id", "name"] });
// data: Array<{ id: number; name: string }>
```

Everything below assumes the typed instance. The rest of the API — `handle`, `schemaCache`, `reloadSchema`, `close` — is
unchanged.

## Reading

### Columns

```ts
// all of them
const all = await pgRest.query({ table: "clients" });
// all.data: Array<{ id: number; name: string; email: string | null; meta: unknown; tags: string[] | null; created_at: string }>

// some of them, and a renamed one
const some = await pgRest.query({ table: "clients", select: ["id", "who:name"] });
// some.data: Array<{ id: number; who: string }>

// `*` is the whole row, and can sit beside an embed
const star = await pgRest.query({ table: "profiles", select: ["*"] });
// star.data: Array<{ client_id: number; bio: string | null }>
```

An enum column is a union of its labels, so the compiler knows the three values:

```ts
const moods = await pgRest.query({ table: "moods", select: ["mood", "seen"] });
// moods.data: Array<{ mood: "sad" | "ok" | "happy"; seen: Array<"sad" | "ok" | "happy"> | null }>
```

### Embedded resources

A foreign key in either direction, a junction table, or a computed relationship — all of them are a key of `select`:

```ts
// to-one (orders.client_id -> clients): an object, or null when there is no match
const toOne = await pgRest.query({ table: "orders", select: ["id", { clients: ["name"] }] });
// toOne.data: Array<{ id: number; clients: { name: string } | null }>

// to-many (clients <- orders): an array
const toMany = await pgRest.query({ table: "clients", select: ["name", { orders: ["total"] }] });
// toMany.data: Array<{ name: string; orders: Array<{ total: number }> }>

// many-to-many, through order_items
const m2m = await pgRest.query({ table: "orders", select: ["id", { products: ["name"] }] });

// a computed relationship is addressed by the function's name
const computed = await pgRest.query({ table: "clients", select: ["name", { recent_orders: ["total"] }] });

// nested, as deep as you like
const nested = await pgRest.query({
  table: "clients",
  select: ["name", { orders: { select: ["id", { order_items: ["qty"] }] } }],
});
// nested.data: Array<{ name: string; orders: Array<{ id: number; order_items: Array<{ qty: number }> }> }>
```

The long form adds the embed's own filters, order and paging — and four modifiers:

```ts
// `inner` drops the parent rows without a match, so the embed stops being nullable
const inner = await pgRest.query({
  table: "orders",
  select: ["id", { clients: { select: ["name"], inner: true } }],
});
// inner.data: Array<{ id: number; clients: { name: string } }>

// `as` renames it, in the result and in the type
const renamed = await pgRest.query({
  table: "orders",
  select: ["id", { clients: { as: "who", select: ["name"] } }],
});
// renamed.data: Array<{ id: number; who: { name: string } | null }>

// `spread` merges the columns into the parent row instead of nesting them
const spreadOne = await pgRest.query({
  table: "orders",
  select: ["id", { clients: { select: ["name"], spread: true } }],
});
// spreadOne.data: Array<{ id: number; name: string }>

// spreading a to-many turns each column into an array of its values
const spreadMany = await pgRest.query({
  table: "clients",
  select: ["name", { orders: { select: ["t:total", "status"], spread: true } }],
});
// spreadMany.data: Array<{ name: string; t: number[]; status: string[] }>

// a to-one can be addressed by its foreign key column, which is how a self-reference is reached
const manager = await pgRest.query({
  table: "employees",
  select: ["name", { manager_id: { select: ["name"], as: "manager" } }],
});
// manager.data: Array<{ name: string; manager: { name: string } | null }>

// `hint` names the relationship to follow, which is required when more than one leads to the same
// resource (`PGRST201` tells you so, and lists them)
const hinted = await pgRest.query({
  table: "orders",
  select: ["id", { clients: { select: ["name"], hint: "orders_client_id_fkey" } }],
});

// the embed's own where / order / limit / offset
const page = await pgRest.query({
  table: "clients",
  select: ["name", { orders: { select: ["total"], where: { status: "paid" }, order: ["total.desc"], limit: 3 } }],
});
```

A filter on an embedded resource can also be written as a dotted path, the way the query string does it. The column
belongs to the other resource, so only the shape of the condition is checked there -- prefer the embed's own `where`,
which knows its columns:

```ts
const dotted = await pgRest.query({
  table: "clients",
  select: ["name", { orders: ["total"] }],
  where: { "orders.status": "paid", "orders.total": ["gte", 100] },
});
```

### Filters

A plain value means `eq`, `null` means `is.null`, a tuple names an operator, and the object form adds the modifiers:

```ts
const filters = await pgRest.query({
  table: "orders",
  select: ["id"],
  where: {
    status: "paid", //                   eq
    total: ["gte", 100], //              [operator, value]
    placed_at: ["lt", "2026-03-01"],
    id: ["in", [1, 2, 3]], //            a list
  },
});

// null is a NULL test, whichever way you write it
const nulls = await pgRest.query({
  table: "clients",
  select: ["id"],
  where: {
    meta: null, //                       is.null
    email: { op: "eq", value: null, not: true }, //  not.is.null
  },
});
```

Every operator PostgREST has, with what it does:

```ts
const operators = await pgRest.query({
  table: "clients",
  select: ["id"],
  where: {
    name: ["neq", "Ada"], //              <>
    id: ["gt", 1], //                     >
    email: ["like", "*@example.com"], //  LIKE, with * as the wildcard
    created_at: ["gte", "2020-01-01"],
    tags: ["cs", ["vip"]], //             @> contains
  },
});

// full text search, with its configuration; a non-tsvector column is wrapped in to_tsvector()
const search = await pgRest.query({
  table: "clients",
  select: ["id"],
  where: { name: { op: "fts", value: "ada", config: "english" } },
});

const patterns = await pgRest.query({
  table: "clients",
  select: ["id"],
  where: { email: ["ilike", "*@EXAMPLE.com"], name: ["match", "^A"] }, //  ILIKE and ~
});

const more = await pgRest.query({
  table: "orders",
  select: ["id"],
  where: {
    status: { op: "in", value: ["paid", "shipped"], not: true }, //  not.in
    total: { op: "isdistinct", value: 0 }, //                       IS DISTINCT FROM
  },
});
```

| operator                         | SQL                                                              |
| -------------------------------- | ---------------------------------------------------------------- |
| `eq` `neq` `gt` `gte` `lt` `lte` | `=` `<>` `>` `>=` `<` `<=`                                       |
| `like` `ilike`                   | `LIKE` / `ILIKE`, with `*` as the wildcard                       |
| `match` `imatch`                 | `~` / `~*`                                                       |
| `in`                             | `IN (…)`                                                         |
| `is`                             | `IS` (`null`, `true`, `false`, `unknown`)                        |
| `isdistinct`                     | `IS DISTINCT FROM`                                               |
| `fts` `plfts` `phfts` `wfts`     | `@@` with `to_tsquery`, `plainto_`, `phraseto_`, `websearch_to_` |
| `cs` `cd`                        | `@>` / `<@` (array and range containment)                        |
| `ov`                             | `&&` (overlap)                                                   |
| `sl` `sr` `nxl` `nxr` `adj`      | range `<<` `>>` `&<` `&>` `-\|-`                                 |

A quantifier applies the operator to every element of an array column, and `and`/`or` take nested groups:

```ts
const quantified = await pgRest.query({
  table: "clients",
  select: ["id"],
  where: { tags: { op: "eq", value: ["vip", "early"], quantifier: "any" } },
});

const logic = await pgRest.query({
  table: "orders",
  select: ["id"],
  where: {
    or: [
      { status: "new" }, //                    status = 'new'
      { total: ["gte", 400] }, //              OR total >= 400
      { status: "paid", total: ["lt", 50] }, // OR (status = 'paid' AND total < 50)
    ],
  },
});
```

Several conditions in one group are ANDed, so the third member above is a nested `and(…)`. Conditions at the top level
are ANDed too.

### Order, paging, and one row

```ts
const sorted = await pgRest.query({
  table: "orders",
  select: ["id"],
  order: [
    { column: "total", desc: true, nulls: "last" }, // the object form
    "placed_at.asc", //                               or the string form
    "id", //                                          or just a column
  ],
  limit: 10,
  offset: 20,
});

// `single` gives the object itself -- and a 406 (PGRST116) when there is not exactly one row
const one = await pgRest.query({ table: "clients", select: ["name"], where: { id: 1 }, single: true });
// one.data: { name: string }

// `count` fills `count` with the number of matching rows, ignoring limit/offset
const counted = await pgRest.query({ table: "orders", select: ["id"], limit: 1, count: "exact" });
// counted.count: number -- on a typed instance the mode decides the type, so there is nothing to test for
// counted.status: 206 when the answer is partial

// "planned" asks the planner, which can have no usable number: that one stays optional
const guessed = await pgRest.query({ table: "orders", select: ["id"], count: "planned" });
// guessed.count: number | undefined

// and no `count` asked for is no count at all
const plain = await pgRest.query({ table: "orders", select: ["id"] });
// plain.count: undefined

// `stripNulls` leaves the null fields out
const lean = await pgRest.query({ table: "clients", select: ["name", "meta"], stripNulls: true });
```

### Composite types

A column of a [composite type](https://www.postgresql.org/docs/current/rowtypes.html) is an object, in both directions:
it comes back as one, and a nested object is what writes it. A value with fields left out has NULL there, exactly like
the row literal it stands for — so a partial value is a legitimate thing to write, and a narrower thing to compare
against than it looks.

```ts
// the whole value, as the object Postgres returns
const venue = await pgRest.query({
  table: "venues",
  select: ["label", "owner", "branches"],
  where: { id: 1 },
  single: true,
});
// venue.data.owner: { name: string | null; home: { city: string | null; zip: string | null } | null; tags: string[] | null } | null

// filtering by a whole value: the fields may come in any order
const byOwner = await pgRest.query({
  table: "venues",
  select: ["id"],
  where: { owner: { name: "Ada", home: { city: "Paris", zip: "75001" }, tags: ["music"] } },
});

// `{ name: "Ada" }` is not "whose name is Ada": it compares against a row whose other fields are
// NULL. For one field, use its path -- on an instance created without a type argument, like any
// other JSON path (see "What the typed path does not describe")
const untyped = await createPgRest({ db: nodePostgresAdapter(pool), schemas: ["api"] });
const byName = await untyped.query({ table: "venues", select: ["id"], where: { "owner->>name": "Ada" } });

// writing one: the fields left out are NULL
const placed = await pgRest.query({
  table: "venues",
  action: "insert",
  rows: { label: "New hall", owner: { name: "Barbara", home: { city: "Brussels" } } },
  select: ["owner"],
});
// placed.data: [{ owner: { name: "Barbara", home: { city: "Brussels", zip: null }, tags: null } }]
```

The arrow operators reach a single field, and work on a composite column exactly as they do on `jsonb` — nested, and
through an array — because pg-rest converts the column with `to_jsonb()` first, as PostgREST does:

```ts
const untyped = await createPgRest({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const fields = await untyped.query({
  table: "venues",
  select: ["id", "owner->>name", "owner->home->>city", "city:branches->0->>city"],
  where: { "owner->home->>city": "Lyon" },
  order: ["owner->>name.desc"],
});
```

Two things to know:

- **A whole-value filter is pg-rest's own.** PostgREST answers `0A000` (_input of anonymous composite types is not
  implemented_) to any comparison against a composite column, because the literal it sends has no type. pg-rest sends
  the value as JSON and turns it into a row of the column's own type, so the comparison works — over `handle()` too,
  since both entry points share one pipeline. A bare Postgres row literal (`owner=eq.(Ada,,)`) still answers `0A000`,
  like PostgREST.
- **An object that names an operator is the long form.** `{ owner: { op: "eq", value: … } }` is a filter spec, not a
  composite value: an object is read as a value only when it has no `op` key. A composite type with a field actually
  named `op` therefore cannot be compared through the object form — pass the JSON yourself, as a string:
  `{ owner: '{"op":"and","name":"Ada"}' }`.

## Writing

`action` says what to do. A write returns the rows it touched unless you ask for `returning: "minimal"`, which is the
one place this API departs from PostgREST's default on purpose — a function that gives nothing back is of little use in a
program.

```ts
// insert one, and get it back
const created = await pgRest.query({
  table: "clients",
  action: "insert",
  rows: { name: "Hopper", email: "grace@example.com" },
  select: ["id", "name"],
});
// created.data: Array<{ id: number; name: string }>, created.status: 201

// insert many
const bulk = await pgRest.query({
  table: "clients",
  action: "insert",
  rows: [{ name: "A" }, { name: "B" }],
  select: ["id"],
});

// only these columns, whatever else the payload carries (and a uniform bulk insert)
const narrowed = await pgRest.query({
  table: "clients",
  action: "insert",
  rows: { name: "C", email: "c@example.com" },
  columns: ["name"],
});

// a column missing from `rows` takes its DEFAULT; `missing: "null"` makes it null instead
const defaults = await pgRest.query({
  table: "orders",
  action: "insert",
  rows: [{ client_id: 1 }, { client_id: 2, status: "paid" }],
  missing: "null",
});

// upsert: on a conflict, update instead -- on the primary key by default
const upserted = await pgRest.query({
  table: "products",
  action: "upsert",
  rows: { id: 1, name: "Keyboard mk2", price: 130 },
  onConflict: ["id"],
  select: ["name"],
});

// update the rows `where` matches
const patched = await pgRest.query({
  table: "orders",
  action: "update",
  set: { status: "shipped" },
  where: { status: "paid" },
  select: ["id", "status"],
});

// delete, and say nothing back
const deleted = await pgRest.query({
  table: "orders",
  action: "delete",
  where: { id: 99 },
  returning: "minimal",
});
// deleted.data: null, deleted.status: 204

// refuse the whole thing if it would touch too many rows (the transaction rolls back)
const careful = await pgRest.query({
  table: "orders",
  action: "update",
  set: { status: "x" },
  where: { status: "paid" },
  maxAffected: 1,
});
```

The payload is typed from the relation: a generated or `GENERATED ALWAYS AS IDENTITY` column is absent, a column with a
default or a nullable one is optional, and a relation that cannot be written at all has no payload to give.

```ts
// @ts-expect-error `name` is NOT NULL and has no default
void pgRest.query({ table: "clients", action: "insert", rows: {} });

// @ts-expect-error `moods.id` is GENERATED ALWAYS AS IDENTITY: Postgres refuses a value for it
void pgRest.query({ table: "moods", action: "insert", rows: { id: 42, mood: "ok" } });

// @ts-expect-error client_totals is an aggregate view: nothing can be written to it
void pgRest.query({ table: "client_totals", action: "insert", rows: { client_id: 1 } });

// @ts-expect-error an insert needs its rows
void pgRest.query({ table: "clients", action: "insert" });

// @ts-expect-error and a read has no business with them
void pgRest.query({ table: "clients", rows: { name: "x" } });
```

## Calling a function

`rpc` replaces `table`. The arguments and the result come from the signature the catalog carries:

```ts
// a scalar
const sum = await pgRest.query({ rpc: "add", args: { a: 2, b: 3 } });
// sum.data: number

// a parameter with a DEFAULT is optional
const hello = await pgRest.query({ rpc: "greet" });
const hi = await pgRest.query({ rpc: "greet", args: { name: "Ada" } });
// hello.data: string

// void gives null
const nothing = await pgRest.query({ rpc: "nothing" });
// nothing.data: null

// a set-returning function answers with rows, and takes the same select/where/order as a table
const paid = await pgRest.query({
  rpc: "orders_by_status",
  args: { s: "paid" },
  select: ["id", "total"],
  where: { total: ["gte", 100] },
  order: ["total.desc"],
  limit: 5,
});
// paid.data: Array<{ id: number; total: number }>

// an overloaded function takes either signature
const asInt = await pgRest.query({ rpc: "ovl", args: { a: 1 } });
const asText = await pgRest.query({ rpc: "ovl", args: { a: "one" } });
```

```ts
// @ts-expect-error that function does not exist
void pgRest.query({ rpc: "nope" });

// @ts-expect-error `a` is an integer
void pgRest.query({ rpc: "add", args: { a: "two", b: 3 } });

// @ts-expect-error a scalar function has no columns to select
void pgRest.query({ rpc: "greet", select: ["anything"] });
```

A function declared `RETURNS TABLE(…)` is the one gap: the catalog does not carry its output columns, and neither does
the request path, so its result is `Record<string, unknown>` and any `select` is accepted.

## Who is asking

The second argument is the caller. It is applied with `set_config` inside the transaction, so row level security and
privileges see exactly what they would behind PostgREST:

```ts
const ctx = { role: "authenticated", claims: { sub: user.id, email: user.email } };

// the row's `owner` defaults to claims.sub, and the policy only lets the owner write
await pgRest.query({ table: "notes", action: "insert", rows: { body: "mine" } }, ctx);

// the same query as somebody else returns nothing: the policy filtered it out
const mine = await pgRest.query({ table: "notes", select: ["body"] }, ctx);

// extra settings reach SQL as current_setting('app.tenant')
await pgRest.query({ table: "notes", select: ["id"] }, { ...ctx, settings: { "app.tenant": "acme" } });
```

Without a context the query runs as the anonymous role (`anon` by default, `anonymousRole: false` to refuse it
outright). **The types say nothing about what a role may do**: `insertable` and its siblings come from
`pg_relation_is_updatable`, which is structural, so an insert as `anon` compiles and Postgres answers `42501` → 401. One
schema serves every role, the role is usually resolved from a cookie at runtime, and RLS is a predicate over rows that no
type can express — so privileges stay where they are enforced.

### Binding it once

Threading `ctx` through every layer that happens to run a query is noise. `setContextQuery(source)` returns the same
`query`, typed the same way, with the context already decided -- `source` being either a fixed context or a function
called at _every_ call, which is what makes an `AsyncLocalStorage` work:

```ts
const pgQuery = pgRest.setContextQuery(() => store.getStore());

// entered once, per request
app.use(async (c, next) => {
  const user = await mySessionLookup(c.req.raw);
  const ctx: RequestContext = user
    ? { role: "authenticated", claims: { sub: user.id, email: user.email } }
    : { role: "anon" };
  await store.run(ctx, next);
});

// anywhere below, however deep, with no ctx to pass
const { data, error } = await pgQuery({ table: "notes", select: ["body"] });
```

```ts ignore
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "@adrdp/pg-rest";

const store = new AsyncLocalStorage<RequestContext>();
```

pg-rest keeps no store of its own: that is what leaves it dependency-free and runtime-neutral, and it lets the context
come from anywhere — `node:async_hooks` on Node and Bun, a per-request store your framework already has, a fixed context
for a job or a test. On Cloudflare Workers `AsyncLocalStorage` needs the `nodejs_als` (or `nodejs_compat`)
compatibility flag; without it, a fixed context and the per-call override below still work.

Two rules, and the second is the reason this is safe to reach for:

```ts
const db = pgRest.setContextQuery(() => store.getStore());

// a context passed to the call wins over the source: one administrative query without leaving the scope
await db({ table: "notes", select: ["id"] }, { role: "admin" });

// a source that gives nothing -- the store was never entered -- is an error, not the anonymous role
const forgotten = await db({ table: "notes" });
forgotten.error?.status; //    500
forgotten.error?.body.code; // "PGRSTX01"
```

Falling back to `anon` there would turn a missing middleware into a silent change of privileges, which is the kind of
bug that reads as "empty result" in development and as an incident in production. Like `query()`, a bound query never
rejects: a `source` that throws comes back as a 500 `error` carrying the original under `cause`.

Use `store.run(ctx, …)`, not `store.enterWith(ctx)`: `run` is bounded by its callback, `enterWith` leaks the context
into whatever follows in the current async resource. An `async` middleware is fine — `run` hands back its callback's
promise, and the context crosses every `await` inside it — as long as you `await` (or return) what `run` gives you,
otherwise the response leaves before the queries finish.

## Transactions

Every call opens its own transaction, which is right for a request — one request, one transaction, the role and the
claims set with `set_config` inside it — and is the whole story for `handle()`. But `query()` is called from
application code, where two writes that must land together are ordinary. `transaction()` is one scope, one transaction:

```ts
const { data, error } = await pgRest.transaction(async (tx) => {
  const order = await tx.query({
    table: "orders",
    action: "insert",
    rows: { client_id: 1, total: 42 },
    single: true,
  });
  if (order.error) throw order.error; //           rolls the transaction back

  const items = await tx.query({
    table: "order_items",
    action: "insert",
    rows: [{ order_id: order.data.id, product_id: 1, qty: 2 }],
  });
  if (items.error) throw items.error;

  return order.data.id; //                         this is the result's `data`
}, ctx);

error?.status; // the failure, if there was one -- `transaction()` never rejects either
data; //          number | null
```

The result is a `QueryResult` around whatever the callback returned: `data` is that value, there is no `count`, and the
status is `200`. A failure comes back the way `query()`'s does — a `QueryError` if it was one, a 500 carrying the
original under `cause` if it was anything else.

**`tx.query` takes no context, and cannot.** The role and the claims are set with `set_config(…, true)`, which is
transaction-local and issued once at the head of the transaction; honouring a per-call context would mean issuing
`set_config` again halfway through, which scopes nothing — it changes the role for every statement that follows, in row
order, with no way back. So `tx.query` is `query` minus its second parameter, and a context passed to it is a type
error rather than an argument quietly ignored. Another role means another transaction.

What the context does _not_ cover is per-statement: the `search_path`, the `request.*` settings SQL reads and the
`timezone` are issued with every query inside the scope, which is what lets two queries of one transaction name two
schemas.

### What rolls a scope back

Three things, and the third is the one worth reading twice:

```ts
// 1. a throw -- yours, or an `error` you rethrow
await pgRest.transaction(async (tx) => {
  await tx.query({ table: "notes", action: "insert", rows: { body: "gone" } });
  throw new Error("changed my mind");
}, ctx);

// 2. rollback(), when nothing went wrong and you still do not want it
const left = await pgRest.transaction(async (tx) => {
  await tx.query({ table: "notes", action: "insert", rows: { body: "gone" } });
  tx.rollback();
}, ctx);
left.error?.body.code; // "PGRSTX02", kind "rolled_back"

// 3. *any* query that failed, even if the callback went on and returned
const kept = await pgRest.transaction(async (tx) => {
  await tx.query({ table: "notes", action: "insert", rows: { body: "gone" } });
  const none = await tx.query({ table: "notes", where: { body: "nobody" }, single: true });
  return none.error?.body.code ?? "committed"; //  a value, from a callback that ignored a failure
}, ctx);
kept.data; //            null -- the scope rolled back anyway
kept.error?.status; //   406: the PGRST116 of the query that failed, carried out of the scope
```

The third rule exists because a failed query is not always a failed transaction as far as PostgreSQL is concerned.
`single` and `maxAffected` (`PGRST116`, `PGRST124`) are the library's own checks, raised _after_ a statement that
worked, and they exist in order to undo the write they just measured. A scope that committed on a callback's return
value would keep the row and hand you an `error` describing it as refused. So the scope refuses to commit, and the
first failure is what the result carries.

It follows that a scope has no use after a failure: PostgreSQL has aborted the transaction and the next statement
answers `25P02`, whatever it is. pg-rest says so instead — `PGRSTX03`, with the way out in its `hint`:

```ts
const r = await pgRest.transaction(async (tx) => {
  const bad = await tx.query({ table: "clients", action: "insert", rows: { name: "a", email: "taken@x.com" } });
  const next = await tx.query({ table: "clients", select: ["id"] });
  next.error?.body.code; // "PGRSTX03" -- refused, not sent
  return bad.error?.body.code;
}, ctx);
r.error?.body.code; // the first failure: "23505"
```

### Letting one query fail: a nested scope

`tx.transaction()` is a scope on a `SAVEPOINT`. It rolls back on its own when it fails, which leaves the transaction
around it usable — so a query that is _allowed_ to fail goes in one, and its failure comes back as that call's `error`
rather than condemning everything:

```ts
await pgRest.transaction(async (tx) => {
  const client = await tx.query({ table: "clients", action: "insert", rows: { name: "Ada" }, single: true });
  if (client.error) throw client.error;

  // the profile is optional: if it collides, the client still stands
  const profile = await tx.transaction(async (nested) => {
    const r = await nested.query({
      table: "profiles",
      action: "insert",
      rows: { client_id: client.data.id, bio: "hi" },
    });
    if (r.error) throw r.error; //        rolls back to the savepoint, and no further
    return r.data;
  });

  return { client: client.data.id, profile: profile.error === null };
}, ctx);
```

A nested scope answers a `QueryResult` like the outer one does, rather than rethrowing: the enclosing scope decides
whether to carry on or to rethrow. `nested.rollback()` undoes the savepoint only. It takes no context and no options —
neither the identity nor `READ ONLY` can change once the transaction has started.

### What the scope decides, and not the query

Three behaviours are per-transaction, so in a scope they belong to the scope rather than to whichever query went
first:

```ts
// READ ONLY for all of it: a write inside is refused by PostgreSQL (25006 -> 405)
await pgRest.transaction(async (tx) => tx.query({ table: "clients", select: ["id"] }), {
  ...ctx,
  readOnly: true,
});

// the isolation level, as PostgreSQL spells it. Both go in one `SET TRANSACTION`, first thing
await pgRest.transaction(async (tx) => tx.query({ table: "clients", select: ["id"] }), {
  ...ctx,
  isolationLevel: "serializable",
  readOnly: true,
});

// replaying a serialization failure means replaying *your callback*, so it is asked for
await pgRest.transaction(async (tx) => tx.query({ table: "clients", select: ["id"] }), {
  ...ctx,
  isolationLevel: "serializable",
  retry: {
    attempts: 3, //          runs of the callback in all; 1, the default, is no retry
    on: ["40001", "40P01"], // default ["40001"]; 40P01 is a deadlock
    delayMs: 25, //          default 0
  },
});
```

`isolationLevel` is `"read committed"`, `"repeatable read"` or `"serializable"`, and defaults to the database's own
setting. `"read uncommitted"` is deliberately absent: PostgreSQL accepts it and runs `read committed` anyway, so it
would be a synonym pretending to be a level. The other two are where a concurrent write can abort the transaction with
a serialization failure — which is what the third option is for.

A single `query()` retries `40001` twice on its own, because pg-rest owns that transaction and nothing else happened
inside it. A scope cannot assume as much: what else your callback does — a counter, an email, a write through another
driver — is not the library's to repeat. Hence off by default, and `attempts` in plain sight when it is not. The two go
together: asking for `serializable` without deciding what a `40001` means is asking for an error you have not planned
for.

The bound form carries the scope too, and reads its source **once, on entry**: a transaction has one `set_config`, so a
source answering differently halfway through could not be honoured anyway. A source that gives nothing is the
`PGRSTX01` it already is, returned before the `BEGIN` rather than leaving an empty transaction open.

```ts
const pgQuery = pgRest.setContextQuery(() => store.getStore());

await pgQuery.transaction(async (tx) => tx.query({ table: "notes", action: "insert", rows: { body: "mine" } }));

// `readOnly` and `retry` alone leave the ambient context in place; naming a role replaces it for
// the whole scope, which is the per-call override moved to the granularity set_config works at
await pgQuery.transaction(async (tx) => tx.query({ table: "notes", select: ["id"] }), { role: "admin" });
```

One asymmetry is left on purpose: the bound query is callable (`pgQuery(input)`) while the scope is an object
(`tx.query(input)`). The callable form is what is documented and in use, and an object is what lets a scope name a
second thing — `transaction`, `rollback` — without changing a signature again.

What a scope is not is a transaction **your** application opened: here pg-rest owns the `BEGIN`, the `COMMIT` and the
`ROLLBACK`, and lends a session to your callback. Running a pg-rest query inside a `sql.begin` of your own is the other
half, still under consideration in [`proposals.md`](proposals.md).

All of the above runs, end to end, in [`examples/with-transactions`](../examples/with-transactions): money moving
between two accounts, the caller read from an `AsyncLocalStorage`, and one scope per rule here.

## Errors

`query()` never rejects: a failure is part of the result, as an `error` carrying the PostgREST status and body plus the
input that produced it. Exactly one of `data` and `error` is set, so `if (error)` narrows both `data` and `count`.

```ts
const { data, count, error } = await pgRest.query(
  { table: "clients", action: "insert", rows: { name: "Dup", email: "ada@example.com" } },
  ctx,
);
if (error) {
  error.kind; //         "conflict" -- one of a closed set of strings, to switch on
  error.status; //       409
  error.body.code; //    "23505" -- the SQLSTATE, or a PGRSTxxx code
  error.body.message; // "duplicate key value violates unique constraint …"
  error.body.details;
  error.body.hint;
  error.input; //        the object you passed
  error.message; //      "23505: duplicate key … " -- one line, for your logs
  error.summary; //      the same failure written out for a person to read (below)
} else {
  data; //  non-null here, and `count` is the type the query asked for
  void count;
}
```

`error` is a `QueryError`, an `ApiError`, an `Error`: throw it, log it, or hand `error.body` straight to an HTTP client.
Even a failure the library did not foresee arrives this way -- a 500 carrying the original under `cause` -- so no
`try`/`catch` is needed anywhere.

`error.summary` is the same failure written out for whoever reads it: the call it came from, then what the database or
the parser said, then `details`, `hint` and the kind, each on its own line.

```
insert on "clients" failed: duplicate key value violates unique constraint "clients_email_key"
  details: Key (email)=(ada@example.com) already exists.
  kind: conflict -- a unique or foreign key constraint rejected the row (23505, HTTP 409)
```

It is a separate field rather than the `message`, which stays the one-line `"23505: duplicate key … hint: …"` summary
`ApiError` builds for a response: a multi-line `Error.message` is not what a log collector expects. `console.error(error.summary)`
when you want the long form, `throw error` when you want the short one. `body` is untouched either way -- it stays
exactly the JSON PostgREST answers with.

### `kind`: the error to switch on

`code` is exact and there are dozens of them; `kind` is the handful of cases that call for _different reactions_, as a
string union, so a `switch` is checked by the compiler rather than by a table of codes you keep yourself:

```ts
const addClient = async (name: string, email: string) => {
  const { data, error } = await pgRest.query(
    { table: "clients", action: "insert", rows: { name, email }, single: true },
    ctx,
  );
  if (!error) return { ok: true as const, client: data };

  switch (error.kind) {
    case "unauthenticated":
    case "forbidden":
      // about who is asking, not about what they asked
      throw new Response(error.body.message, { status: error.status });
    case "conflict":
      return { ok: false as const, why: "that email is already taken" };
    case "invalid_data":
      // a check constraint or a NOT NULL: the database says which
      return { ok: false as const, why: error.body.message };
    case "raised":
      // your own RAISE, so your own wording
      return { ok: false as const, why: error.body.message };
    case "unavailable":
      return { ok: false as const, why: "the database is down, try again" };
    default:
      // invalid_query, invalid_payload, internal... a bug on this side, not the caller's
      throw error;
  }
};
```

Every kind, and what it means:

| `kind`              | when                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `invalid_query`     | the query itself does not make sense: unknown operator, unparseable `select` or `order`, a filter on a resource that is not embedded |
| `invalid_payload`   | the `rows` or the `set` do not fit the table: a column that does not exist, keys that differ between rows, nothing to write          |
| `undefined_object`  | no table, view or function by that name — a typo (read the `hint`), or a migration the schema cache has not seen                     |
| `invalid_embed`     | no relationship between two resources, or more than one, which needs a `hint`                                                        |
| `not_single_row`    | `single` matched other than exactly one row — both "not found" and "found several"                                                   |
| `too_many_affected` | the write would have touched more rows than `maxAffected`, and was rolled back                                                       |
| `unauthenticated`   | no role in the context, or anonymous access disabled                                                                                 |
| `forbidden`         | the role lacks the privilege. RLS _hiding_ rows is empty data, not an error                                                          |
| `conflict`          | a unique or foreign key constraint rejected the row                                                                                  |
| `invalid_data`      | the values themselves were refused: a check constraint, a `NOT NULL`, a failed cast                                                  |
| `raised`            | your own `RAISE` in SQL (`P0001`, `PTxyz`, `PGRST`), with the message you wrote                                                      |
| `unsupported`       | not implemented, or not over `query()`                                                                                               |
| `unavailable`       | the database could not be reached, is out of connections, or timed out — retrying may work                                           |
| `no_context`        | the `source` of a bound query returned nothing (see [Binding it once](#binding-it-once))                                             |
| `internal`          | anything left: a bug, or an error pg-rest did not foresee. The original is under `cause`                                             |

A later version may map a code onto a kind it did not have before, and new kinds are additive — which is why the
`default` above matters, and why `code` remains the thing to test when you need the exact reason. The same mapping is
exported for an `ApiError` you hold from `handle()`: `errorKind(status, code)`, and `describeErrorKind(kind)` for its
wording.

The codes behind them, and what you are likely to see:

| code                    | status    | `kind`                          | when                                                                                     |
| ----------------------- | --------- | ------------------------------- | ---------------------------------------------------------------------------------------- |
| `PGRST205`              | 404       | `undefined_object`              | no such table — with a `hint` suggesting the nearest name                                |
| `PGRST204`              | 400       | `invalid_payload`               | no such column in a write payload                                                        |
| `PGRST200` / `PGRST201` | 400 / 300 | `invalid_embed`                 | no relationship between two resources, or more than one (pass a `hint`)                  |
| `PGRST116`              | 406       | `not_single_row`                | `single` matched something other than exactly one row                                    |
| `PGRST124`              | 400       | `too_many_affected`             | `maxAffected` exceeded                                                                   |
| `PGRST302`              | 401       | `unauthenticated`               | no context and anonymous access disabled                                                 |
| `PGRSTX01`              | 500       | `no_context`                    | the `source` of a bound query returned nothing (see [Binding it once](#binding-it-once)) |
| `42501`                 | 401 / 403 | `unauthenticated` / `forbidden` | the role lacks the privilege                                                             |
| `23505` / `23503`       | 409       | `conflict`                      | unique / foreign key violation                                                           |
| `PT4xx`                 | 4xx       | `raised`                        | your own `RAISE … USING ERRCODE = 'PT404'`                                               |
| `PGRST001`              | 503       | `unavailable`                   | the database connection failed                                                           |

## What the typed path does not describe

Three PostgREST forms change or invent a column, and reading them back out of a string literal would cost more than it
gives:

```ts
// @ts-expect-error a cast
void pgRest.query({ table: "orders", select: ["total::text"] });

// @ts-expect-error a JSON path, in a select
void pgRest.query({ table: "clients", select: ["tier:meta->>tier"] });

// @ts-expect-error ... or in a filter
void pgRest.query({ table: "clients", select: ["id"], where: { "meta->>tier": "gold" } });

// @ts-expect-error an aggregate
void pgRest.query({ table: "orders", select: ["status", "total.sum()"] });
```

They work on an instance created without a type argument, where the input is loose:

```ts
const loose = await createPgRest({ db: nodePostgresAdapter(pool), schemas: ["api"] });

const { data } = await loose.query<Array<{ status: string; sum: number }>>({
  table: "orders",
  select: ["status", "total.sum()"],
  order: ["status"],
});
```

Content negotiation stays on `handle()` entirely — CSV, GeoJSON, custom media type handlers, `EXPLAIN` plans, `Range`
headers, `OPTIONS` and the OpenAPI document:

```ts
const csv = await pgRest.handle(
  new Request("http://localhost/orders?select=id,total", { headers: { Accept: "text/csv" } }),
);
```

## Every field

| field             | meaning                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `table`           | the relation to read or write. Restricts everything else                                                  |
| `rpc`             | the function to call, instead of `table`                                                                  |
| `schema`          | one of the exposed schemas; optional for the default one, required for the others                         |
| `action`          | `"select"` (the default), `"insert"`, `"upsert"`, `"update"`, `"delete"`                                  |
| `select`          | columns, `"alias:column"`, `"*"`, and embedded resources                                                  |
| `where`           | conditions by column, plus `and` / `or` groups                                                            |
| `order`           | `"column"`, `"column.desc"`, `"column.desc.nullsfirst"`, or `{ column, desc, nulls }`                     |
| `limit`, `offset` | paging                                                                                                    |
| `single`          | one object instead of an array (406 otherwise)                                                            |
| `count`           | `"exact"`, `"planned"`, `"estimated"` → `count`. The mode decides its type: see [below](#what-comes-back) |
| `stripNulls`      | leave null fields out of the result                                                                       |
| `maxAffected`     | refuse and roll back beyond this many affected rows                                                       |
| `timezone`        | the time zone the statement runs in                                                                       |
| `rows`            | the payload of an `insert` or `upsert`: one object or many                                                |
| `set`             | the columns an `update` changes                                                                           |
| `onConflict`      | the columns an upsert resolves on (default: the primary key)                                              |
| `columns`         | insert only these, whatever else `rows` carries                                                           |
| `missing`         | a column absent from `rows`: its `"default"` or `"null"`                                                  |
| `returning`       | `"representation"` (the default here) or `"minimal"`                                                      |
| `args`            | a function's arguments, by name                                                                           |

### What comes back

`{ data, count, status }` — the rows, one object with `single`, or `null` for a minimal write; the total when a `count`
was asked for; and the status the same call would have answered over HTTP.

On a [typed instance](types.md) `count` is typed from the mode the query asked for, which is exactly what the runtime
answers:

| `count` in the query | `count` in the result |                                                                                   |
| -------------------- | --------------------- | --------------------------------------------------------------------------------- |
| absent               | `undefined`           | nothing was counted, so there is nothing to narrow                                |
| `"exact"`            | `number`              | always counted; with no paging to look past, that number is the page's own length |
| `"estimated"`        | `number`              | the planner's number above `maxRows`, the exact one below it                      |
| `"planned"`          | `number \| undefined` | `Plan Rows` out of an `EXPLAIN`, which can come back with nothing usable          |

An instance created without a type argument keeps `number | undefined` throughout: the input is not a literal, so there
is no mode to read it from.
