# Queries — asking in-process

`@tsql/query` asks Postgres from inside your process: `select`, `insert`, `upsert`, `update`, `delete` and `rpc` each take a plain object and answer a result, with no
`Request`, no URL and no HTTP status in between. The method says what to do (`pgRest.insert({ table, rows })`); there is no `action` to write. One example per field below; the
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
- [Prepared queries](#prepared-queries)
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
const pgRest = createQuery({ db: nodePostgresAdapter(pool), schema });

const { data } = await pgRest.select<Array<{ id: number; name: string }>>({
  table: "clients",
  columns: ["id", "name"],
});
```

With one, everything inside is checked and the result is inferred. The type comes from the catalog — see [`types.md`](types.md):

```ts
import type { Database } from "./db.generated.ts";

const pgRest = createQuery<Database>({ db: nodePostgresAdapter(pool), schema });

const { data } = await pgRest.select({ table: "clients", columns: ["id", "name"] });
// data: Array<{ id: number; name: string }>
```

Everything below assumes the typed instance. The rest of the API — `setContextQuery`, `transaction`, `close` — is
unchanged.

## Reading

### Columns

A read names the columns it wants in `columns` (so does `rpc`, and so does an [embed](#embedded-resources) in its long
form). A write names what it answers with in `returning` instead -- see [Writing](#writing) -- because an insert's own
`columns` is something else: the columns it inserts.

```ts
// all of them
const all = await pgRest.select({ table: "clients" });
// all.data: Array<{ id: number; name: string; email: string | null; meta: unknown; tags: string[] | null; created_at: string }>

// some of them, and a renamed one
const some = await pgRest.select({ table: "clients", columns: ["id", "who:name"] });
// some.data: Array<{ id: number; who: string }>

// `*` is the whole row, and can sit beside an embed
const star = await pgRest.select({ table: "profiles", columns: ["*"] });
// star.data: Array<{ client_id: number; bio: string | null }>
```

An enum column is a union of its labels, so the compiler knows the three values:

```ts
const moods = await pgRest.select({ table: "moods", columns: ["mood", "seen"] });
// moods.data: Array<{ mood: "sad" | "ok" | "happy"; seen: Array<"sad" | "ok" | "happy"> | null }>
```

### Embedded resources

A foreign key in either direction, a junction table, or a computed relationship — all of them are a key of `columns`:

```ts
// to-one (orders.client_id -> clients): an object, or null when there is no match
const toOne = await pgRest.select({ table: "orders", columns: ["id", { clients: ["name"] }] });
// toOne.data: Array<{ id: number; clients: { name: string } | null }>

// to-many (clients <- orders): an array
const toMany = await pgRest.select({ table: "clients", columns: ["name", { orders: ["total"] }] });
// toMany.data: Array<{ name: string; orders: Array<{ total: number }> }>

// many-to-many, through order_items
const m2m = await pgRest.select({ table: "orders", columns: ["id", { products: ["name"] }] });

// a computed relationship is addressed by the function's name
const computed = await pgRest.select({ table: "clients", columns: ["name", { recent_orders: ["total"] }] });

// nested, as deep as you like
const nested = await pgRest.select({
  table: "clients",
  columns: ["name", { orders: { columns: ["id", { order_items: ["qty"] }] } }],
});
// nested.data: Array<{ name: string; orders: Array<{ id: number; order_items: Array<{ qty: number }> }> }>
```

The long form adds the embed's own filters, order and paging — and four modifiers:

```ts
// `inner` drops the parent rows without a match, so the embed stops being nullable
const inner = await pgRest.select({
  table: "orders",
  columns: ["id", { clients: { columns: ["name"], inner: true } }],
});
// inner.data: Array<{ id: number; clients: { name: string } }>

// `as` renames it, in the result and in the type
const renamed = await pgRest.select({
  table: "orders",
  columns: ["id", { clients: { as: "who", columns: ["name"] } }],
});
// renamed.data: Array<{ id: number; who: { name: string } | null }>

// `spread` merges the columns into the parent row instead of nesting them
const spreadOne = await pgRest.select({
  table: "orders",
  columns: ["id", { clients: { columns: ["name"], spread: true } }],
});
// spreadOne.data: Array<{ id: number; name: string }>

// spreading a to-many turns each column into an array of its values
const spreadMany = await pgRest.select({
  table: "clients",
  columns: ["name", { orders: { columns: ["t:total", "status"], spread: true } }],
});
// spreadMany.data: Array<{ name: string; t: number[]; status: string[] }>

// a to-one can be addressed by its foreign key column, which is how a self-reference is reached
const manager = await pgRest.select({
  table: "employees",
  columns: ["name", { manager_id: { columns: ["name"], as: "manager" } }],
});
// manager.data: Array<{ name: string; manager: { name: string } | null }>

// `hint` names the relationship to follow, which is required when more than one leads to the same
// resource (the error is `invalid_embed`, and its `details` list them)
const hinted = await pgRest.select({
  table: "orders",
  columns: ["id", { clients: { columns: ["name"], hint: "orders_client_id_fkey" } }],
});

// the embed's own where / order / limit / offset
const page = await pgRest.select({
  table: "clients",
  columns: ["name", { orders: { columns: ["total"], where: { status: "paid" }, order: ["total.desc"], limit: 3 } }],
});
```

A filter on an embedded resource can also be written as a dotted path, the way the query string does it. The column
belongs to the other resource, so only the shape of the condition is checked there -- prefer the embed's own `where`,
which knows its columns:

```ts
const dotted = await pgRest.select({
  table: "clients",
  columns: ["name", { orders: ["total"] }],
  where: { "orders.status": "paid", "orders.total": { $gte: 100 } },
});
```

### Filters

A plain value means `eq`, `null` means `is.null`, and an object names the operators, each one starting with `$`. Several operators on one column are ANDed:

```ts
const filters = await pgRest.select({
  table: "orders",
  columns: ["id"],
  where: {
    status: "paid", //                   eq
    total: { $gte: 100, $lt: 500 }, //   several operators, ANDed
    placed_at: { $lt: "2026-03-01" },
    id: { $in: [1, 2, 3] }, //           a list
  },
});

// null is a NULL test, whichever way you write it
const nulls = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: {
    meta: null, //                       is.null
    email: { $not: null }, //           not.is.null (same as { $not: { $eq: null } })
  },
});
```

Every operator, by what it works on. A `$` key is an operator; the table at the end lists them all.

**Comparison** works on numbers, text, dates, enums and arrays:

```ts
const comparison = await pgRest.select({
  table: "orders",
  columns: ["id"],
  where: {
    status: { $neq: "void" }, //            <>
    total: { $gt: 10, $lte: 500 }, //       > and <=, ANDed
    placed_at: { $gte: "2026-01-01" }, //   >=
    client_id: { $in: [1, 2] }, //          IN (1, 2)
  },
});

const ranged = await pgRest.select({
  table: "orders",
  columns: ["id"],
  where: { total: { $gte: 100, $lt: 500 } }, //   100 <= total < 500
});
```

**Text** has the pattern operators. `*` is the wildcard of `$like` and `$ilike`; `$match` and `$imatch` take a POSIX
regular expression:

```ts
const text = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: {
    name: { $like: "A*" }, //                 LIKE 'A%'
    email: { $ilike: "*@EXAMPLE.com" }, //    ILIKE '%@EXAMPLE.com'
  },
});

const regex = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: { name: { $match: "^A.*a$" }, email: { $imatch: "@example\\.com$" } }, //  ~ and ~*
});
```

**NULL, booleans and `DISTINCT`**. Comparing with `null` is a NULL test, so `$eq: null` and `$neq: null` are `IS NULL` and
`IS NOT NULL`; `$is` is for the three-valued logic of booleans:

```ts
const untyped = createQuery({ db: nodePostgresAdapter(pool), schema });

const nulls = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: {
    meta: null, //                           IS NULL
    email: { $neq: null }, //                IS NOT NULL
    tags: { $is: "not_null" }, //            IS NOT NULL, the long way
  },
});

// $isdistinct is a null-safe <>: it never answers NULL
const distinct = await pgRest.select({
  table: "orders",
  columns: ["id"],
  where: { total: { $isdistinct: 0 }, placed_at: { $isdistinct: null } },
});

// booleans: $is takes true, false, unknown and null
const flags = await untyped.select({
  table: "todos",
  where: {
    done: { $is: false }, //                 IS FALSE
    archived: { $is: "unknown" }, //         IS UNKNOWN (a NULL boolean)
    starred: { $not: { $is: true } }, //     NOT (starred IS TRUE): false and NULL, unlike $not: true
  },
});
```

**Full-text search** wraps a column that is not a `tsvector` in `to_tsvector()`. The four operators differ in how they read the
query; each takes a text, or `{ query, config }`:

```ts
const search = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: { name: { $fts: "ada & lovelace" } }, //                           to_tsquery
});

const searches = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: {
    name: { $plfts: "ada lovelace" }, //                                    plainto_tsquery
    email: { $phfts: "ada lovelace" }, //                                   phraseto_tsquery
    meta: { $wfts: { query: "ada -babbage", config: "english" } }, //       websearch_to_tsquery, with a configuration
  },
});
```

**Arrays** have containment and overlap. To compare a whole array, say so with `$eq`: an array alone is not a condition:

```ts
const arrays = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: {
    tags: { $cs: ["vip"] }, //               @>  contains every one of these
  },
});

const more = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: {
    tags: { $cd: ["vip", "early", "beta"] }, //   <@  is contained in these
  },
});

const overlap = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: { tags: { $ov: ["vip", "beta"] } }, //   &&  shares at least one
});

const whole = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: { tags: { $eq: ["vip", "early"] } }, //  = the whole array, in order
});
```

**`jsonb` and ranges**. Their generated type is `unknown`, so every operator is offered. `$cs` and `$cd` work on `jsonb`
too, and the range operators on a range column:

```ts
const untyped = createQuery({ db: nodePostgresAdapter(pool), schema });

const json = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: { meta: { $cs: '{"tier":"gold"}' } }, //   @>  the jsonb contains this
});

const ranges = await untyped.select({
  table: "events",
  where: {
    during: { $ov: "[2026-01-01,2026-02-01)" }, //    &&  overlaps
    ends: { $sl: "[2026-03-01,2026-04-01)" }, //      <<  strictly left of
    starts: { $sr: "[2025-01-01,2025-02-01)" }, //    >>  strictly right of
    window: { $nxr: "[2026-01-01,2026-12-31)" }, //   &<  does not extend to the right of
    slot: { $nxl: "[2026-01-01,2026-12-31)" }, //     &>  does not extend to the left of
    shift: { $adj: "[2026-02-01,2026-03-01)" }, //    -|- adjacent to
  },
});
```

**A path into a column** (`->` and `->>`) filters on a field of a `json`/`jsonb`, composite or array column; every
operator applies to the result. It is available on an instance created without a type argument:

```ts
const untyped = createQuery({ db: nodePostgresAdapter(pool), schema });

const paths = await untyped.select({
  table: "venues",
  columns: ["id"],
  where: {
    "meta->>tier": { $in: ["gold", "silver"] },
    "owner->home->>city": { $ilike: "ly*" },
    "owner->>name": { $not: null },
  },
});
```

**Modifiers**. `$not` inverts one operator, or a plain value; `$any` and `$all` wrap an operator and compare a column
with each value of a list (`LIKE ANY (…)`). For `eq`, `$in` says it already; neither is for array columns, where `$cs`
and `$ov` do the job:

```ts
const negated = await pgRest.select({
  table: "orders",
  columns: ["id"],
  where: {
    status: { $not: { $in: ["paid", "shipped"] } }, //   NOT IN
    client_id: { $not: 2 }, //                            <> 2 (a plain value is an eq)
    placed_at: { $not: null }, //                         IS NOT NULL
  },
});

const quantified = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: { name: { $any: { $like: ["A*", "B*"] } } }, //   LIKE ANY ('A%', 'B%')
});

const everyone = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: { email: { $all: { $ilike: ["*@example.com", "ada*"] } } }, //   ILIKE ALL
});
```

**Groups**. Conditions at the top level are ANDed. `$or` takes a list of groups, `$and` is for the same operator twice
on one column, and `$not` inverts the AND of what is inside it:

```ts
const logic = await pgRest.select({
  table: "orders",
  columns: ["id"],
  where: {
    $or: [
      { status: "new" }, //                    status = 'new'
      { total: { $gte: 400 } }, //             OR total >= 400
      { status: "paid", total: { $lt: 50 } }, // OR (status = 'paid' AND total < 50)
    ],
  },
});

// an object cannot repeat a key, so two $like on one column go through $and
const both = await pgRest.select({
  table: "clients",
  columns: ["id"],
  where: { $and: [{ name: { $like: "A*" } }, { name: { $like: "*a" } }] },
});

const inverted = await pgRest.select({
  table: "orders",
  columns: ["id"],
  where: {
    $not: { status: "paid", total: { $gte: 100 } }, //                     NOT (status = 'paid' AND total >= 100)
    $or: [{ client_id: 1 }, { $not: { $or: [{ status: "new" }, { status: "void" }] } }], //   groups nest
  },
});
```

Several conditions in one group are ANDed, so the third member of the first `$or` is a nested `and(…)`.

| operator                                   | SQL                                                              | on                                    |
| ------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------- |
| `$eq` `$neq`                               | `=` `<>` (`IS` / `IS NOT` with `null`)                           | every type                            |
| `$gt` `$gte` `$lt` `$lte`                  | `>` `>=` `<` `<=`                                                | numbers, text, dates, arrays          |
| `$like` `$ilike`                           | `LIKE` / `ILIKE`, with `*` as the wildcard                       | text                                  |
| `$match` `$imatch`                         | `~` / `~*`                                                       | text                                  |
| `$in`                                      | `IN (…)`                                                         | every type                            |
| `$is`                                      | `IS` (`null`, `not_null`, `true`, `false`, `unknown`)            | every type, booleans above all        |
| `$isdistinct`                              | `IS DISTINCT FROM`                                               | every type                            |
| `$fts` `$plfts` `$phfts` `$wfts`           | `@@` with `to_tsquery`, `plainto_`, `phraseto_`, `websearch_to_` | text, `tsvector`                      |
| `$cs` `$cd`                                | `@>` / `<@`                                                      | arrays, `jsonb`, ranges               |
| `$ov`                                      | `&&`                                                             | arrays, ranges                        |
| `$sl` `$sr` `$nxl` `$nxr` `$adj`           | range `<<` `>>` `&>` `&<` `-\|-`                                 | ranges                                |
| `$not`                                     | `NOT` (one operator or a plain value)                            | wraps                                 |
| `$any` `$all`                              | `op ANY (…)` / `op ALL (…)` over a list                          | a column holding one value            |
| `$and` `$or` `$not`                        | `AND` / `OR` / `NOT` over groups                                 | `where`                               |

The operators a column accepts follow its type: `$gt`/`$lt` need something ordered, `$like`/`$ilike`/`$match`/`$imatch` and
the full-text ones need text, `$cs`/`$cd`/`$ov` need an array, and a column whose generated type is `unknown` (a range,
`jsonb`) takes them all. A `$` key is always an operator or `$and`/`$or`/`$not`, so a column may be called `and` or `or`.
An array is not a condition by itself: write `{ $eq: [...] }` to compare a column with one.

### Order, paging, and one row

```ts
const sorted = await pgRest.select({
  table: "orders",
  columns: ["id"],
  order: [
    { column: "total", desc: true, nulls: "last" }, // the object form
    "placed_at.asc", //                               or the string form
    "id", //                                          or just a column
  ],
  limit: 10,
  offset: 20,
});

// `single` gives the object itself -- and a `not_single_row` error when there is not exactly one row
const one = await pgRest.select({ table: "clients", columns: ["name"], where: { id: 1 }, single: true });
// one.data: { name: string }

// `count` fills `count` with the number of matching rows, ignoring limit/offset
const counted = await pgRest.select({ table: "orders", columns: ["id"], limit: 1, count: "exact" });
// counted.count: number -- on a typed instance the mode decides the type, so there is nothing to test for

// "planned" asks the planner, which can have no usable number: that one stays optional
const guessed = await pgRest.select({ table: "orders", columns: ["id"], count: "planned" });
// guessed.count: number | undefined

// and no `count` asked for is no count at all
const plain = await pgRest.select({ table: "orders", columns: ["id"] });
// plain.count: undefined

// `stripNulls` leaves the null fields out
const lean = await pgRest.select({ table: "clients", columns: ["name", "meta"], stripNulls: true });
```

### Composite types

A column of a [composite type](https://www.postgresql.org/docs/current/rowtypes.html) is an object, in both directions:
it comes back as one, and a nested object is what writes it. A value with fields left out has NULL there, exactly like
the row literal it stands for — so a partial value is a legitimate thing to write, and a narrower thing to compare
against than it looks.

```ts
// the whole value, as the object Postgres returns
const venue = await pgRest.select({
  table: "venues",
  columns: ["label", "owner", "branches"],
  where: { id: 1 },
  single: true,
});
// venue.data.owner: { name: string | null; home: { city: string | null; zip: string | null } | null; tags: string[] | null } | null

// filtering by a whole value: the fields may come in any order
const byOwner = await pgRest.select({
  table: "venues",
  columns: ["id"],
  where: { owner: { name: "Ada", home: { city: "Paris", zip: "75001" }, tags: ["music"] } },
});

// `{ name: "Ada" }` is not "whose name is Ada": it compares against a row whose other fields are
// NULL. For one field, use its path -- on an instance created without a type argument, like any
// other JSON path (see "What the typed path does not describe")
const untyped = createQuery({ db: nodePostgresAdapter(pool), schema });
const byName = await untyped.select({ table: "venues", columns: ["id"], where: { "owner->>name": "Ada" } });

// writing one: the fields left out are NULL
const placed = await pgRest.insert({
  table: "venues",
  rows: { label: "New hall", owner: { name: "Barbara", home: { city: "Brussels" } } },
  returning: ["owner"],
});
// placed.data: [{ owner: { name: "Barbara", home: { city: "Brussels", zip: null }, tags: null } }]
```

The arrow operators reach a single field, and work on a composite column exactly as they do on `jsonb` — nested, and
through an array — because the column is converted with `to_jsonb()` first:

```ts
const untyped = createQuery({ db: nodePostgresAdapter(pool), schema });

const fields = await untyped.select({
  table: "venues",
  columns: ["id", "owner->>name", "owner->home->>city", "city:branches->0->>city"],
  where: { "owner->home->>city": "Lyon" },
  order: ["owner->>name.desc"],
});
```

Two things to know:

- **A whole-value filter compares the whole composite.** The value is sent as JSON and turned into a row of the
  column's own type, so `{ owner: { name: "Ada" } }` works. A bare Postgres row literal as a string
  (`owner: "(Ada,,)"`) is not a value of the column's type and the database refuses it.
- **An object whose keys all start with `$` names operators.** `{ owner: { $eq: … } }` is a filter, not a composite
  value: any other object is read as a value. A composite type with a field whose name starts with `$` therefore cannot
  be compared through the object form — pass the JSON yourself, as a string: `{ owner: '{"$id":1,"name":"Ada"}' }`.

## Writing

The method says what to do. A write returns the rows it touched unless you ask for `returning: "minimal"`: a function
that gives nothing back is of little use in a program. `returning` also takes a list, the same one `columns` takes on a
read -- `returning: ["id", "name"]` -- and `data` is typed from it.

```ts
// insert one, and get it back
const created = await pgRest.insert({
  table: "clients",
  rows: { name: "Hopper", email: "grace@example.com" },
  returning: ["id", "name"],
});
// created.data: Array<{ id: number; name: string }>

// insert many
const bulk = await pgRest.insert({
  table: "clients",
  rows: [{ name: "A" }, { name: "B" }],
  returning: ["id"],
});

// only these columns, whatever else the payload carries (and a uniform bulk insert)
const narrowed = await pgRest.insert({
  table: "clients",
  rows: { name: "C", email: "c@example.com" },
  columns: ["name"],
});

// a column missing from `rows` takes its DEFAULT; `missing: "null"` makes it null instead
const defaults = await pgRest.insert({
  table: "orders",
  rows: [{ client_id: 1 }, { client_id: 2, status: "paid" }],
  missing: "null",
});

// upsert: on a conflict, update instead -- on the primary key by default
const upserted = await pgRest.upsert({
  table: "products",
  rows: { id: 1, name: "Keyboard mk2", price: 130 },
  onConflict: ["id"],
  returning: ["name"],
});

// update the rows `where` matches
const patched = await pgRest.update({
  table: "orders",
  set: { status: "shipped" },
  where: { status: "paid" },
  returning: ["id", "status"],
});

// delete, and say nothing back
const deleted = await pgRest.delete({
  table: "orders",
  where: { id: 99 },
  returning: "minimal",
});
// deleted.data: null

// refuse the whole thing if it would touch too many rows (the transaction rolls back)
const careful = await pgRest.update({
  table: "orders",
  set: { status: "x" },
  where: { status: "paid" },
  maxAffected: 1,
});
```

The payload is typed from the relation: a generated or `GENERATED ALWAYS AS IDENTITY` column is absent, a column with a
default or a nullable one is optional, and a relation that cannot be written at all has no payload to give.

```ts
// @ts-expect-error `name` is NOT NULL and has no default
void pgRest.insert({ table: "clients", rows: { } });

// @ts-expect-error `moods.id` is GENERATED ALWAYS AS IDENTITY: Postgres refuses a value for it
void pgRest.insert({ table: "moods", rows: { id: 42, mood: "ok" } });

// @ts-expect-error client_totals is an aggregate view: nothing can be written to it
void pgRest.insert({ table: "client_totals", rows: { client_id: 1 } });

// @ts-expect-error an insert needs its rows
void pgRest.insert({ table: "clients", });

// @ts-expect-error and a read has no business with them
void pgRest.select({ table: "clients", rows: { name: "x" } });
```

### Computed values

`set` takes more than values. It follows PostgreSQL's `UPDATE … SET`, one column at
a time: `column_name = { expression | DEFAULT }`.

A plain value is still a plain value. An object whose keys all start with `$` is an expression the database computes,
so every operator starts with `$`, like the filters:

```ts
const computed = await pgRest.update({
  table: "orders",
  set: {
    status: "paid", //                                      a plain value, as before
    total: { $add: [{ $col: "total" }, 10] }, //            total = total + 10
    placed_at: { $default: true }, //                       = DEFAULT
  },
  where: { id: 1 },
  returning: ["id", "status", "total"],
});
```

`{ $col: "name" }` is a column of the row being updated; a string, number, boolean or `null` is a literal, and a string is
**never** a column. `{ $val: x }` is any JSON value as a literal. The keys of `set` are the columns of the table, and
nothing else: PostgreSQL's `(a, b) = ROW(x, y)` is `a = x, b = y`.

**Numbers**: `$add`, `$sub`, `$mul`, `$div`, `$mod` and `$pow` take any number of operands, left to right; `$neg` is a
unary minus.

```ts
const arithmetic = await pgRest.update({
  table: "orders",
  set: {
    total: { $add: [{ $col: "total" }, 10, { $neg: 2 }] }, //                    total + 10 + (-2)
  },
  where: { id: 1 },
});

const more = await pgRest.update({
  table: "orders",
  set: {
    total: { $div: [{ $mul: [{ $col: "total" }, 3] }, 2] }, //                   (total * 3) / 2
    client_id: { $mod: [{ $add: [{ $col: "client_id" }, 1] }, 5] }, //           (client_id + 1) % 5
  },
  where: { id: 2 },
});

const power = await pgRest.update({
  table: "products",
  set: { price: { $pow: [{ $col: "price" }, 2] } }, //                           price ^ 2
  where: { id: 1 },
});
```

**Text, arrays and `jsonb`**: `$concat` is `||`, and the type decides what it means: it joins text, appends to an array and
merges `jsonb`. `$sub` on a `jsonb` removes a key. A bare string next to an array is read as an array literal, as in
PostgreSQL, so an element is written `{ $val: ["x"] }`:

```ts
const text = await pgRest.update({
  table: "clients",
  set: { name: { $concat: ["Dr. ", { $col: "name" }, "!"] } }, //               'Dr. ' || name || '!'
  where: { id: 1 },
});

const array = await pgRest.update({
  table: "clients",
  set: { tags: { $concat: [{ $coalesce: [{ $col: "tags" }, { $val: [] }] }, { $val: ["vip"] }] } }, //   append, from NULL too
  where: { id: 1 },
});

const json = await pgRest.update({
  table: "clients",
  set: {
    meta: { $concat: [{ $coalesce: [{ $col: "meta" }, { $val: {} }] }, { $val: { seen: true } }] }, //   jsonb merge
  },
  where: { id: 1 },
});

const removed = await pgRest.update({
  table: "clients",
  set: { meta: { $sub: [{ $col: "meta" }, "seen"] } }, //                         meta - 'seen'
  where: { id: 1 },
});
```

**Functions**: `$coalesce`, `$greatest` and `$least` take a list; `$cast` takes an expression and a type, from the same
allowlist as a column cast. The other functions are a fixed list too, and a name is never taken from the input:

| function                                  | SQL                                    | on          |
| ----------------------------------------- | -------------------------------------- | ----------- |
| `{ $now: true }`                          | `now()`                                | dates       |
| `$lower` `$upper` `$trim`                 | `lower` `upper` `btrim`, one operand   | text        |
| `$length`                                 | `length`, one operand                  | text        |
| `$abs`                                    | `abs`, one operand                     | numbers     |
| `{ $round: [x] }` `{ $round: [x, 2] }`    | `round(x)`, `round(x, 2)`              | numbers     |
| `{ $arrayAppend: [array, element] }`      | `array_append(array, element)`         | arrays      |
| `{ $arrayRemove: [array, element] }`      | `array_remove(array, element)`         | arrays      |

```ts
const stamped = await pgRest.update({
  table: "clients",
  set: {
    name: { $upper: { $trim: { $col: "name" } } }, //                           upper(btrim(name))
    created_at: { $now: true }, //                                               now()
  },
  where: { id: 1 },
});

const rounded = await pgRest.update({
  table: "orders",
  set: { total: { $round: [{ $mul: [{ $col: "total" }, 1.2] }, 2] } }, //        round(total * 1.2, 2)
  where: { id: 1 },
});

const tagged = await pgRest.update({
  table: "clients",
  set: { tags: { $arrayAppend: [{ $coalesce: [{ $col: "tags" }, { $val: [] }] }, "vip"] } }, //   array_append(…, 'vip')
  where: { id: 1 },
});

const untagged = await pgRest.update({
  table: "clients",
  set: { tags: { $arrayRemove: [{ $col: "tags" }, "vip"] } }, //                  array_remove(tags, 'vip')
  where: { id: 1 },
});
```

```ts
const functions = await pgRest.update({
  table: "orders",
  set: {
    total: { $greatest: [{ $col: "total" }, 0] }, //                             never below 0
    status: { $coalesce: [{ $cast: [{ $col: "client_id" }, "text"] }, "none"] }, //   COALESCE(client_id::text, 'none')
  },
  where: { id: 1 },
});

const capped = await pgRest.update({
  table: "orders",
  set: { total: { $least: [{ $mul: [{ $col: "total" }, 2] }, 1000] } }, //       at most 1000
  where: { id: 1 },
});
```

**Comparison and logic** make a boolean, for a boolean column: `$eq`, `$neq`, `$gt`, `$gte`, `$lt`, `$lte`, `$cs`, `$cd`,
`$ov` take two operands; `$and` and `$or` any number; `$not` one.

```ts
const untyped = createQuery({ db: nodePostgresAdapter(pool), schema });

const booleans = await untyped.update({
  table: "todos",
  set: {
    done: { $not: { $col: "done" } }, //                                                 done = NOT done
    urgent: { $and: [{ $gt: [{ $col: "priority" }, 3] }, { $lte: [{ $col: "due", }, { $val: "2026-12-31" }] }] }, //   priority > 3 AND due <= '2026-12-31'
    seen: { $or: [{ $col: "seen" }, { $eq: [{ $col: "owner" }, "ada"] }] }, //          seen OR owner = 'ada'
    shared: { $ov: [{ $col: "tags" }, { $val: ["team"] }] }, //                          tags && '{team}'
  },
  where: { id: 1 },
});
```

**`DEFAULT`** is a whole assignment, never part of an expression. Several columns are several keys, and a plain value
and an expression can share one update:

```ts
const reset = await pgRest.update({
  table: "orders",
  set: {
    status: { $default: true }, //                           status = DEFAULT
    total: { $default: true }, //                            total = DEFAULT
    placed_at: "2026-01-01", //                              a plain value, in the same statement
  },
  where: { id: 1 },
});
```

| node                                                   | SQL                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `1`, `"text"`, `true`, `null`                          | a literal. A string is **never** a column: use `$col`  |
| `{ $col: "total" }`                                    | the column of the row being updated                    |
| `{ $val: x }`                                          | any JSON value as a literal: an object, an array       |
| `$add` `$sub` `$mul` `$div` `$mod` `$pow` `$concat`    | `+` `-` `*` `/` `%` `^` `\|\|`, two operands or more    |
| `$neg`                                                 | unary `-`                                              |
| `$eq` `$neq` `$gt` `$gte` `$lt` `$lte` `$cs` `$cd` `$ov` | `=` `<>` `>` `>=` `<` `<=` `@>` `<@` `&&`, two operands |
| `$and` `$or` `$not`                                    | `AND` `OR` `NOT`                                       |
| `$coalesce` `$greatest` `$least`                       | the functions of the same name                         |
| `$lower` `$upper` `$trim` `$length` `$abs` `$round`    | the functions, see above                               |
| `$now` `$arrayAppend` `$arrayRemove`                   | `now()`, `array_append`, `array_remove`                |
| `{ $cast: [expression, "numeric"] }`                   | `::type`, from the allowlist of a column cast        |
| `{ $default: true }`                                   | `DEFAULT`, as a whole assignment                       |

Nothing is raw SQL: a column is checked against the schema, a type against an allowlist, a value is escaped, and an
unknown `$` key is refused, in an expression and as a key of `set`. An object with `$` keys that is meant as a `jsonb`
value is written `{ $val: … }`.

On a typed instance the expression has to give the column's type, and `$col` names a column of the same kind: a text
operator is refused on a number column, `$add` on text, `$arrayAppend` on anything but an array. A column TypeScript
cannot tell more about (`jsonb`, ranges) takes any expression, and so does `$cast`.

```ts
// @ts-expect-error `nope` is not a column of orders
void pgRest.update({ table: "orders", set: { nope: { $add: [1, 2] } } });

// @ts-expect-error `total` is a number, `$lower` gives text
void pgRest.update({ table: "orders", set: { total: { $lower: { $col: "status" } } } });

// @ts-expect-error `$col: "status"` is text, `$add` takes numbers here
void pgRest.update({ table: "orders", set: { total: { $add: [{ $col: "status" }, 1] } } });
```

## Calling a function

`rpc` replaces `table`. The arguments and the result come from the signature the catalog carries:

```ts
// a scalar
const sum = await pgRest.rpc({ rpc: "add", args: { a: 2, b: 3 } });
// sum.data: number

// a parameter with a DEFAULT is optional
const hello = await pgRest.rpc({ rpc: "greet" });
const hi = await pgRest.rpc({ rpc: "greet", args: { name: "Ada" } });
// hello.data: string

// void gives null
const nothing = await pgRest.rpc({ rpc: "nothing" });
// nothing.data: null

// a set-returning function answers with rows, and takes the same columns/where/order as a table
const paid = await pgRest.rpc({
  rpc: "orders_by_status",
  args: { s: "paid" },
  columns: ["id", "total"],
  where: { total: { $gte: 100 } },
  order: ["total.desc"],
  limit: 5,
});
// paid.data: Array<{ id: number; total: number }>

// an overloaded function takes either signature
const asInt = await pgRest.rpc({ rpc: "ovl", args: { a: 1 } });
const asText = await pgRest.rpc({ rpc: "ovl", args: { a: "one" } });
```

```ts
// @ts-expect-error that function does not exist
void pgRest.rpc({ rpc: "nope" });

// @ts-expect-error `a` is an integer
void pgRest.rpc({ rpc: "add", args: { a: "two", b: 3 } });

// @ts-expect-error a scalar function has no columns to ask for
void pgRest.rpc({ rpc: "greet", columns: ["anything"] });
```

A function declared `RETURNS TABLE(…)` is the one gap: the catalog does not carry its output columns, and neither does
the request path, so its result is `Record<string, unknown>` and any `columns` is accepted.

## Who is asking

The second argument is the caller. It is applied with `set_config` inside the transaction, so row level security and
privileges apply to the query as they would to any session of that role:

```ts
const ctx = { role: "authenticated", claims: { sub: user.id, email: user.email } };

// the row's `owner` defaults to claims.sub, and the policy only lets the owner write
await pgRest.insert({ table: "notes", rows: { body: "mine" } }, ctx);

// the same query as somebody else returns nothing: the policy filtered it out
const mine = await pgRest.select({ table: "notes", columns: ["body"] }, ctx);

// extra settings reach SQL as current_setting('app.tenant')
await pgRest.select({ table: "notes", columns: ["id"] }, { ...ctx, settings: { "app.tenant": "acme" } });
```

Without a context the query runs as the anonymous role (`anon` by default, `anonymousRole: false` to refuse it
outright). **The types say nothing about what a role may do**: `insertable` and its siblings come from
`pg_relation_is_updatable`, which is structural, so an insert as `anon` compiles and Postgres answers `42501` → 401. One
schema serves every role, the role is usually resolved from a cookie at runtime, and RLS is a predicate over rows that no
type can express — so privileges stay where they are enforced.

### Binding it once

Threading `ctx` through every layer that happens to run a query is noise. `setContextQuery(source)` returns the same
operations, typed the same way, with the context already decided -- `source` being either a fixed context or a function
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
const { data, error } = await pgQuery.select({ table: "notes", columns: ["body"] });
```

```ts ignore
import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestContext } from "@tsql/query";

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
await db.select({ table: "notes", columns: ["id"] }, { role: "admin" });

// a source that gives nothing -- the store was never entered -- is an error, not the anonymous role
const forgotten = await db.select({ table: "notes" });
forgotten.error?.kind; // "no_context"
```

Falling back to `anon` there would turn a missing middleware into a silent change of privileges, which is the kind of
bug that reads as "empty result" in development and as an incident in production. Like the instance's operations, a bound one never
rejects: a `source` that throws comes back as a 500 `error` carrying the original under `cause`.

Use `store.run(ctx, …)`, not `store.enterWith(ctx)`: `run` is bounded by its callback, `enterWith` leaks the context
into whatever follows in the current async resource. An `async` middleware is fine — `run` hands back its callback's
promise, and the context crosses every `await` inside it — as long as you `await` (or return) what `run` gives you,
otherwise the response leaves before the queries finish.

## Prepared queries

A query that runs many times with different values need not be parsed and planned every time. `prepare()` does that
once and gives back a function of the values; a call of it is run with `run()`:

```ts
const paidOver = pgRest.prepare((a: { status: string; min: number }) => ({
  table: "orders",
  columns: ["id", "total", { clients: ["name"] }],
  where: { status: a.status, total: { $gte: a.min } },
  order: ["id"],
}));

const { data, error } = await pgRest.run(paidOver({ status: "paid", min: 100 }), ctx);
// data: the rows, typed by the columns
```

The query is checked against the database when it is written, like any other, and `data` is typed by it. A call is
string concatenation and the statement for the driver: no parsing, no planning. What remains is the database.

`run()` is on the instance, on a [`setContextQuery`](#binding-it-once) function, and as `tx.run()` in a
[transaction](#transactions), where it rejects on failure like the scope's operations:

```ts
// the same kind of prepared query as above
const paidOver = pgRest.prepare((a: { status: string; min: number }) => ({
  table: "orders",
  columns: ["id", "total"],
  where: { status: a.status, total: { $gte: a.min } },
}));

const inScope = await pgRest.transaction(async (tx) => (await tx.run(paidOver({ status: "new", min: 0 }))).data, ctx);
```

**An argument is a filter value, and nothing else.** `prepare()` calls your function once, with a stand-in for each
argument, and cuts the SQL it gets at those stand-ins. So an argument cannot choose a column, an operator, a `limit`
or what the query selects, and the function cannot branch on one (`a.status ? … : …` always sees a value). A query that
does not follow that, one that names a table that does not exist, and anything but a select, make `prepare()` throw
when the module loads rather than when the first request arrives.

A call whose values would change the SQL itself is not an error: `null` (`IS NULL` instead of `=`), a string with a `*`
(the wildcard of `like`) and one that opens a `{` (it may be a composite) build the query object and run it the
ordinary way, with the same result, at the cost of the saving.

## Transactions

Every call opens its own transaction, which is right for a request — one request, one transaction, the role and the
claims set with `set_config` inside it — and is the whole story for `handle()`. But the operations are called from
application code, where two writes that must land together are ordinary. `transaction()` is one scope, one transaction:

```ts
const { data, error } = await pgRest.transaction(async (tx) => {
  const order = await tx.insert({
    table: "orders",
    rows: { client_id: 1, total: 42 },
    single: true,
  });

  await tx.insert({
    table: "order_items",
    rows: [{ order_id: order.data.id, product_id: 1, qty: 2 }],
  });

  return order.data.id; //                         this is the result's `data`
}, ctx);

error?.kind; //   the failure, if there was one -- `transaction()` never rejects
data; //          number | null
```

The result is a `QueryResult` around whatever the callback returned: `data` is that value, and there is no `count`.
A failure comes back the way an operation's does — a `QueryError` if it was one, an `internal` one carrying the
original under `cause` if it was anything else.

**A scope's operations differ from the instance's in exactly two ways**, and both of them follow from sharing a transaction.

**It takes no context, and cannot.** The role and the claims are set with `set_config(…, true)`, which is
transaction-local and issued once at the head of the transaction; honouring a per-call context would mean issuing
`set_config` again halfway through, which scopes nothing — it changes the role for every statement that follows, in row
order, with no way back. So a context passed to a scope's operation is a type error rather than an argument quietly ignored.
Another role means another transaction.

**It rejects on failure instead of answering an `error`** — which is why nothing is narrowed above. A query that failed
is a transaction that will not commit, so there is nothing left for the rest of the callback to do with it; leaving is
the only correct next step, and the library takes it rather than asking every call site to. What comes back is
therefore the *success*: `data` is not null and `count` is the number the query asked for.

```ts
const { data, count } = await pgRest.transaction(async (tx) => {
  const { data: rows, count: total } = await tx.select({
    table: "clients",
    columns: ["id", "name"],
    count: "exact",
    limit: 10,
  });
  // rows: Array<{ id: number; name: string }> -- not `| null`
  // total: number -- not `number | undefined`
  return `${rows.length} of ${total}`;
}, ctx);
```

The promise that never rejects did not disappear; it moved from the query to the **scope**, which is the only place it
can mean anything now that several of them share a transaction. What a scope's operation throws is the same `QueryError`
the instance's would have returned, so a `catch` can read it — and the section below is about why you rarely want to.

What the context does _not_ cover is per-statement: the `search_path` and the
`timezone` are issued with every query inside the scope, which is what lets two queries of one transaction name two
schemas.

### What rolls a scope back

```ts
// 1. a failed query -- it leaves the scope, and the write before it is undone with it
const refused = await pgRest.transaction(async (tx) => {
  await tx.insert({ table: "clients", rows: { name: "Ada", email: "a@b.c" } });
  await tx.insert({ table: "clients", rows: { name: "Dup", email: "a@b.c" } });
  return "unreachable"; //                       the second insert collides, so this is never reached
}, ctx);
refused.error?.sqlState; // "23505" -- the query's own failure, carried out of the scope

// 2. a throw of your own, for a reason the database knows nothing about
await pgRest.transaction(async (tx) => {
  await tx.insert({ table: "notes", rows: { body: "gone" } });
  throw new Error("changed my mind");
}, ctx);

// 3. rollback(), when nothing went wrong and you still do not want it
const left = await pgRest.transaction(async (tx) => {
  await tx.insert({ table: "notes", rows: { body: "gone" } });
  tx.rollback();
}, ctx);
left.error?.kind; // "rolled_back"
```

A fourth case is worth naming because it is the one that could have been wrong. `single` and `maxAffected`
(`not_single_row`, `too_many_affected`) are the library's own checks, raised _after_ a statement that worked, in order to undo the
write they just measured. Nothing has aborted the transaction when they fire — so a scope that committed because the
callback returned would keep the row and hand you an `error` describing it as refused. **Any query that failed stops
the scope from committing**, even if you caught what it threw and carried on:

```ts
const kept = await pgRest.transaction(async (tx) => {
  await tx.insert({ table: "notes", rows: { body: "gone" } });
  try {
    await tx.select({ table: "notes", where: { body: "nobody" }, single: true });
  } catch {
    return "committed anyway?"; //                 a value, from a callback that swallowed a failure
  }
  return "unreachable";
}, ctx);
kept.data; //            null -- the scope rolled back regardless
kept.error?.kind; //     "not_single_row": the query that failed
```

Which is also why catching inside a scope buys little: PostgreSQL has aborted the transaction, the next statement
answers `25P02` whatever it is, and the scope will not commit. pg-rest says so rather than passing that on —
a `rolled_back` error, with the way out in its `hint`. The way out is the next section.

### Letting one query fail: a nested scope

`tx.transaction()` is a scope on a `SAVEPOINT`, and it is the one place a transaction can carry on after a failure: the
savepoint undoes it, the transaction around it stays usable. So it answers a `QueryResult` rather than rejecting — a
nested scope is where an `error` is a thing you can read and decide about:

```ts
await pgRest.transaction(async (tx) => {
  const client = await tx.insert({ table: "clients", rows: { name: "Ada" }, single: true });

  // the profile is optional: if it collides, the client still stands
  const profile = await tx.transaction((nested) =>
    nested.insert({ table: "profiles", rows: { client_id: client.data.id, bio: "hi" } }),
  );
  profile.error?.sqlState; //  "23505" perhaps -- and the scope is still good

  return { client: client.data.id, profile: profile.error === null };
}, ctx);
```

Nothing in there has to rethrow: the nested scope catches what the query threw, rolls back to its savepoint, and hands
the failure to its caller. `nested.rollback()` undoes the savepoint only. A nested scope takes no context and no
options — neither the identity nor `READ ONLY` can change once the transaction has started.

### What the scope decides, and not the query

Three behaviours are per-transaction, so in a scope they belong to the scope rather than to whichever query went
first:

```ts
// READ ONLY for all of it: a write inside is refused by PostgreSQL (25006 -> 405)
await pgRest.transaction(async (tx) => tx.select({ table: "clients", columns: ["id"] }), {
  ...ctx,
  readOnly: true,
});

// the isolation level, as PostgreSQL spells it. Both go in one `SET TRANSACTION`, first thing
await pgRest.transaction(async (tx) => tx.select({ table: "clients", columns: ["id"] }), {
  ...ctx,
  isolationLevel: "serializable",
  readOnly: true,
});

// replaying a serialization failure means replaying *your callback*, so it is asked for
await pgRest.transaction(async (tx) => tx.select({ table: "clients", columns: ["id"] }), {
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

A single operation retries `40001` twice on its own, because pg-rest owns that transaction and nothing else happened
inside it. A scope cannot assume as much: what else your callback does — a counter, an email, a write through another
driver — is not the library's to repeat. Hence off by default, and `attempts` in plain sight when it is not. The two go
together: asking for `serializable` without deciding what a `40001` means is asking for an error you have not planned
for.

The bound form carries the scope too, and reads its source **once, on entry**: a transaction has one `set_config`, so a
source answering differently halfway through could not be honoured anyway. A source that gives nothing is the
`no_context` error it already is, returned before the `BEGIN` rather than leaving an empty transaction open.

```ts
const pgQuery = pgRest.setContextQuery(() => store.getStore());

await pgQuery.transaction(async (tx) => tx.insert({ table: "notes", rows: { body: "mine" } }));

// `readOnly`, `isolationLevel` and `retry` alone leave the ambient context in place; naming a role
// replaces it for the whole scope, which is the per-call override moved to the granularity
// set_config works at
await pgQuery.transaction(async (tx) => tx.select({ table: "notes", columns: ["id"] }), { role: "admin" });
```

What a scope is not is a transaction **your** application opened: here pg-rest owns the `BEGIN`, the `COMMIT` and the
`ROLLBACK`, and lends a session to your callback. Running a pg-rest query inside a `sql.begin` of your own is the other
half, still under consideration in [`proposals.md`](proposals.md) — along with
[the line none of these may cross](proposals.md#the-line-none-of-these-may-cross), which is where a page of additions
says what it refuses to become.

All of the above runs, end to end, in [`examples/query/with-transactions`](../examples/query/with-transactions): money moving
between two accounts, the caller read from an `AsyncLocalStorage`, and one scope per rule here.

## Errors

An operation never rejects: a failure is part of the result, as an `error` carrying what went wrong and the input that
produced it. Exactly one of `data` and `error` is set, so `if (error)` narrows both `data` and `count`.

```ts
const { data, count, error } = await pgRest.insert(
  { table: "clients", rows: { name: "Dup", email: "ada@example.com" } },
  ctx,
);
if (error) {
  error.kind; //     "conflict" -- one of a closed set of strings, to switch on
  error.message; //  "duplicate key value violates unique constraint …"
  error.details; //  "Key (email)=(ada@example.com) already exists."
  error.hint; //     what to do about it, when the database or the parser knew -- or null
  error.sqlState; // "23505" -- for a failure that came from the database, otherwise undefined
  error.input; //    the object you passed
  error.summary; //  the same failure written out for a person to read (below)
} else {
  data; //  non-null here, and `count` is the type the query asked for
  void count;
}
```

`error` is a `QueryError`, an `Error`: throw it, log it, or read its fields. Even a failure the library did not foresee
arrives this way -- an `internal` one carrying the original under `cause` -- so no `try`/`catch` is needed anywhere.
There is no HTTP status on it: an operation has no response, and what to answer is for the caller to decide from the
`kind`.

`error.summary` is the same failure written out for whoever reads it: the call it came from, then what the database or
the parser said, then `details`, `hint` and the kind, each on its own line.

```
insert on "clients" failed: duplicate key value violates unique constraint "clients_email_key"
  details: Key (email)=(ada@example.com) already exists.
  kind: conflict -- a unique or foreign key constraint rejected the row (23505)
```

It is a separate field rather than the `message`, which stays the one line the database or the parser gave: a
multi-line `Error.message` is not what a log collector expects. `console.error(error.summary)` when you want the long
form, `throw error` when you want the short one.

### `kind`: the error to switch on

`kind` is the handful of cases that call for _different reactions_, as a string union, so a `switch` is checked by the
compiler rather than by a table of codes you keep yourself. For a database error the exact reason is still there, in
`sqlState`:

```ts
const addClient = async (name: string, email: string) => {
  const { data, error } = await pgRest.insert(
    { table: "clients", rows: { name, email }, single: true },
    ctx,
  );
  if (!error) return { ok: true as const, client: data };

  switch (error.kind) {
    case "unauthenticated":
    case "forbidden":
      // about who is asking, not about what they asked
      throw new Error(error.message);
    case "conflict":
      return { ok: false as const, why: "that email is already taken" };
    case "invalid_data":
      // a check constraint or a NOT NULL: the database says which
      return { ok: false as const, why: error.message };
    case "raised":
      // your own RAISE, so your own wording
      return { ok: false as const, why: error.message };
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
| `invalid_query`     | the query itself does not make sense: unknown operator, unparseable `columns` or `order`, a filter on a resource that is not embedded |
| `invalid_payload`   | the `rows` or the `set` do not fit the table: a column that does not exist, keys that differ between rows, nothing to write          |
| `undefined_object`  | no table, view or function by that name — a typo (read the `hint`), or a migration the generated schema has not seen                 |
| `invalid_embed`     | no relationship between two resources, or more than one, which needs a `hint`                                                        |
| `not_single_row`    | `single` matched other than exactly one row — both "not found" and "found several"                                                   |
| `too_many_affected` | the write would have touched more rows than `maxAffected`, and was rolled back                                                       |
| `unauthenticated`   | no role in the context, or anonymous access disabled                                                                                 |
| `forbidden`         | the role lacks the privilege. RLS _hiding_ rows is empty data, not an error                                                          |
| `conflict`          | a unique or foreign key constraint rejected the row                                                                                  |
| `invalid_data`      | the values themselves were refused: a check constraint, a `NOT NULL`, a failed cast                                                  |
| `raised`            | your own `RAISE` in SQL, with the message you wrote                                                                                  |
| `unsupported`       | not implemented, or not over the in-process operations                                                                                               |
| `unavailable`       | the database could not be reached, is out of connections, or timed out — retrying may work                                           |
| `no_context`        | the `source` of a bound query returned nothing (see [Binding it once](#binding-it-once))                                             |
| `rolled_back`       | a transaction scope will not commit: `rollback()` was called, or a query in it already failed                                        |
| `internal`          | anything left: a bug, or an error pg-rest did not foresee. The original is under `cause`                                             |

A later version may map a failure onto a kind it did not have before, and new kinds are additive — which is why the
`default` above matters, and why `sqlState` remains the thing to test when you need the exact reason of a database
error. `describeErrorKind(kind)` gives a kind's wording, for a log line.

## What the typed path does not describe

Three string forms of a column change or invent a column, and reading them back out of a string literal would cost
more than it gives. A JSON path in a `where` is the exception, because a filter does not change the result: it is
accepted on its column, with a value checked no further than its shape.

```ts
// @ts-expect-error a cast
void pgRest.select({ table: "orders", columns: ["total::text"] });

// @ts-expect-error a JSON path, in `columns`
void pgRest.select({ table: "clients", columns: ["tier:meta->>tier"] });

// a JSON path in a filter is fine: it names a column, and the column is checked
void pgRest.select({ table: "clients", columns: ["id"], where: { "meta->>tier": { $ilike: "go*" } } });

// @ts-expect-error ... but not on a column that does not exist
void pgRest.select({ table: "clients", columns: ["id"], where: { "nope->>tier": "gold" } });

// @ts-expect-error an aggregate
void pgRest.select({ table: "orders", columns: ["status", "total.sum()"] });
```

They work on an instance created without a type argument, where the input is loose:

```ts
const loose = createQuery({ db: nodePostgresAdapter(pool), schema });

const { data } = await loose.select<Array<{ status: string; sum: number }>>({
  table: "orders",
  columns: ["status", "total.sum()"],
  order: ["status"],
});
```

## Every field

| field             | meaning                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `table`           | the relation to read or write. Restricts everything else                                                  |
| `rpc`             | the function to call, instead of `table`                                                                  |
| `schema`          | one of the exposed schemas; optional for the default one, required for the others                         |
| `columns`         | on a read or an `rpc`: columns, `"alias:column"`, `"*"`, and embedded resources                             |
| `where`           | conditions by column (`{ $gte: 1 }`), plus `$and` / `$or` / `$not` groups                                 |
| `order`           | `"column"`, `"column.desc"`, `"column.desc.nullsfirst"`, or `{ column, desc, nulls }`                     |
| `limit`, `offset` | paging                                                                                                    |
| `single`          | one object instead of an array (`not_single_row` otherwise)                                                            |
| `count`           | `"exact"`, `"planned"`, `"estimated"` → `count`. The mode decides its type: see [below](#what-comes-back) |
| `stripNulls`      | leave null fields out of the result                                                                       |
| `maxAffected`     | refuse and roll back beyond this many affected rows                                                       |
| `timezone`        | the time zone the statement runs in                                                                       |
| `rows`            | the payload of an `insert` or `upsert`: one object or many                                                |
| `set`             | the columns an `update` changes: values, or `$` expressions and `$default`                              |
| `onConflict`      | the columns an upsert resolves on (default: the primary key)                                              |
| `columns`         | on an `insert` or `upsert`: insert only these, whatever else `rows` carries                               |
| `missing`         | a column absent from `rows`: its `"default"` or `"null"`                                                  |
| `returning`       | on a write: `"representation"` (the default here), `"minimal"`, or a list of columns like `columns` takes |
| `args`            | a function's arguments, by name                                                                           |

### What comes back

`{ data, count, error }` — the rows, one object with `single`, or `null` for a minimal write; the total when a `count`
was asked for; and `error`, which is `null` when the query worked.

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
