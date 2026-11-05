import type { RequestContext } from "./core";
import type { FilterOp, QueryResult, QuerySafeResult, Scalar } from "./query";
import type { PgRestInstance } from "./index";

/**
 * The types `generateTypes` emits, as constraints. They describe a database, not a query: see
 * {@link TypedQuery} for what a call may say, and {@link QueryData} for what it returns.
 */
export interface AnyRelation {
  readonly row: Record<string, unknown>;
  readonly insert: Record<string, unknown>;
  readonly update: Record<string, unknown>;
  readonly pk: ReadonlyArray<string>;
  readonly insertable: boolean;
  readonly updatable: boolean;
  readonly deletable: boolean;
  readonly rel: Record<string, { readonly rel: string; readonly to: "one" | "many" }>;
}

export interface AnySignature {
  readonly args: unknown;
  readonly returns: unknown;
  readonly set: boolean;
}

export interface AnySchema {
  readonly relations: Record<string, AnyRelation>;
  readonly functions: Record<string, ReadonlyArray<AnySignature>>;
}

/** What `createPgRest<Db>` expects: the type `generateTypes` exports. */
export interface AnyDatabase {
  readonly default: string;
  readonly schemas: Record<string, AnySchema>;
}

// ---------------------------------------------------------------------------
// reading the database type
// ---------------------------------------------------------------------------

type Schema<Db extends AnyDatabase> = keyof Db["schemas"] & string;
type Relations<Db extends AnyDatabase, S extends Schema<Db>> = Db["schemas"][S]["relations"];
type Functions<Db extends AnyDatabase, S extends Schema<Db>> = Db["schemas"][S]["functions"];
type Table<Db extends AnyDatabase, S extends Schema<Db>> = keyof Relations<Db, S> & string;
type Row<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = Relations<Db, S>[T]["row"];
type Column<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = keyof Row<Db, S, T> & string;
type Embeds<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = Relations<Db, S>[T]["rel"];
/** The relation an embedded name points at, if it is one of this schema's. */
type Target<Db extends AnyDatabase, S extends Schema<Db>, E> = E extends { rel: infer R }
  ? R extends Table<Db, S>
    ? R
    : never
  : never;

type UnionToIntersection<U> = (U extends unknown ? (x: U) => void : never) extends (x: infer I) => void ? I : never;
/** Flatten an intersection into one object, so hovers and errors read as a plain row. */
type Flatten<T> = T extends object ? { [K in keyof T]: T[K] } & {} : T;

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

/**
 * One item of a `select`. Columns, `alias:column`, `*`, and embedded resources as
 * `{ relation: [...] }` or `{ relation: { select, inner, limit, ... } }`.
 *
 * PostgREST's other string forms -- casts, JSON paths, aggregates -- are not described here: they
 * change the type of the value or invent a column, and parsing them from a string literal would
 * cost more than it gives. Use an untyped instance for those.
 */
type SelectItem<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> =
  | "*"
  | Column<Db, S, T>
  | `${string}:${Column<Db, S, T>}`
  | { readonly [E in keyof Embeds<Db, S, T>]?: Embed<Db, S, Target<Db, S, Embeds<Db, S, T>[E]>> };

type SelectList<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = ReadonlyArray<
  SelectItem<Db, S, T>
>;

/** An embedded resource: its columns, or an object with its own filters and paging. */
type EmbedOptions<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = {
  /** The columns of the embedded resource, and its own embeds. Defaults to all of them. */
  readonly select?: SelectList<Db, S, T>;
  /** `!inner`: drop the parent rows that have no match here. A to-one embed stops being nullable. */
  readonly inner?: boolean;
  /** Which relationship to follow, when more than one leads here: a foreign key name, or a table. */
  readonly hint?: string;
  /** Filters on the embedded rows, not on the parent's. */
  readonly where?: Where<Db, S, T>;
  /** How to sort the embedded rows. */
  readonly order?: ReadonlyArray<Order<Db, S, T>>;
  /** At most this many embedded rows per parent row. */
  readonly limit?: number;
  /** Skip this many embedded rows per parent row. */
  readonly offset?: number;
};

/**
 * An embedded resource: its columns, or the long form with its own filters and paging.
 *
 * `as` and `spread` are exclusive, because PostgREST's grammar has no way to write both:
 * `...alias:table(*)` does not parse (`PGRST100`), so a type that accepted it would promise
 * something the request cannot express.
 */
type Embed<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> =
  | SelectList<Db, S, T>
  | (EmbedOptions<Db, S, T> & {
      /** Rename the resource in the result. The inferred key follows. */
      readonly as?: string;
      readonly spread?: never;
    })
  | (EmbedOptions<Db, S, T> & {
      /**
       * `...rel(*)`: merge these columns into the parent row instead of nesting them. Spreading a
       * to-many relationship turns each column into an array of its values.
       */
      readonly spread: true;
      readonly as?: never;
    });

/** The columns of `Items` picked out of a plain row, `alias:column` renamed, `*` taking them all. */
type PickedFrom<R, Items> =
  Items extends ReadonlyArray<unknown>
    ? Flatten<
        UnionToIntersection<
          {
            [I in keyof Items]: Items[I] extends "*"
              ? R
              : Items[I] extends keyof R & string
                ? { [K in Items[I]]: R[K] }
                : Items[I] extends `${infer A}:${infer C}`
                  ? C extends keyof R & string
                    ? { [K in A]: R[C] }
                    : unknown
                  : unknown;
          }[number]
        >
      >
    : R;

/** What a function's result may be asked for: its columns, if it has any. */
type RowSelect<R> = R extends object
  ? ReadonlyArray<"*" | (keyof R & string) | `${string}:${keyof R & string}`>
  : never;

/** The row a `select` produces: the picked columns, the aliases renamed, the embeds nested. */
type Selected<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Items> =
  Items extends ReadonlyArray<unknown>
    ? Flatten<UnionToIntersection<{ [I in keyof Items]: ItemOf<Db, S, T, Items[I]> }[number]>>
    : Row<Db, S, T>;

type ItemOf<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Item> = Item extends "*"
  ? Row<Db, S, T>
  : Item extends Column<Db, S, T>
    ? { [K in Item]: Row<Db, S, T>[K] }
    : Item extends `${infer A}:${infer C}`
      ? C extends Column<Db, S, T>
        ? { [K in A]: Row<Db, S, T>[C] }
        : unknown
      : Item extends object
        ? Embedded<Db, S, T, Item>
        : unknown;

/** Keys of an embed object that are spread into the parent, and the ones that stay nested. */
type SpreadKeys<Item> = { [E in keyof Item]: Item[E] extends { spread: true } ? E : never }[keyof Item];
type NestedKeys<Item> = { [E in keyof Item]: Item[E] extends { spread: true } ? never : E }[keyof Item];

/** One `{ relation: ... }` item: nested resources under their own key, spread ones merged in. */
type Embedded<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Item> = NestedPart<Db, S, T, Item> &
  SpreadPart<Db, S, T, Item>;

/**
 * Each half is skipped when it has no keys: a key-remapped mapped type over an empty key set is not
 * the empty object -- it carries a string index signature, which would spread to the whole row.
 */
type NestedPart<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Item> = [
  NestedKeys<Item>,
] extends [never]
  ? unknown
  : {
      [
        E in NestedKeys<Item> & keyof Item & keyof Embeds<Db, S, T> as Item[E] extends { as: infer A extends string }
          ? A
          : E
      ]: EmbedOf<Db, S, Target<Db, S, Embeds<Db, S, T>[E]>, Embeds<Db, S, T>[E], Item[E]>;
    };

type SpreadPart<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Item> = [
  SpreadKeys<Item>,
] extends [never]
  ? unknown
  : UnionToIntersection<
      {
        [E in SpreadKeys<Item> & keyof Item & keyof Embeds<Db, S, T>]: SpreadOf<
          Db,
          S,
          Target<Db, S, Embeds<Db, S, T>[E]>,
          Embeds<Db, S, T>[E],
          Item[E]
        >;
      }[SpreadKeys<Item> & keyof Item & keyof Embeds<Db, S, T>]
    >;

/**
 * A spread embed has no key of its own: its columns join the parent row. Spreading a to-many
 * relationship turns each of them into an array of that column's values.
 */
type SpreadOf<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Rel, Spec> = Rel extends {
  to: "many";
}
  ? Arrayed<SpreadRow<Db, S, T, Spec>>
  : SpreadRow<Db, S, T, Spec>;

type SpreadRow<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Spec> = Spec extends {
  select: infer Items;
}
  ? Selected<Db, S, T, Items>
  : Row<Db, S, T>;

type Arrayed<R> = { [K in keyof R]: R[K][] };

type EmbedOf<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Rel, Spec> =
  Spec extends ReadonlyArray<unknown>
    ? Shaped<Rel, Spec, Selected<Db, S, T, Spec>>
    : Spec extends { select: infer Items }
      ? Shaped<Rel, Spec, Selected<Db, S, T, Items>>
      : Shaped<Rel, Spec, Row<Db, S, T>>;

/**
 * A to-many embed is an array. A to-one embed is the row, or null when there is no match -- unless
 * the join is `inner`, which drops the parent rows that have none.
 */
type Shaped<Rel, Spec, R> = Rel extends { to: "many" } ? R[] : Spec extends { inner: true } ? R : R | null;

// ---------------------------------------------------------------------------
// filters, order
// ---------------------------------------------------------------------------

/** A condition on a column: the value itself (`eq`), a `[operator, value]` tuple, or the full form. */
type Filter<V> =
  | V
  | null
  | readonly [FilterOp, V | ReadonlyArray<V> | null]
  | {
      readonly op: FilterOp;
      readonly value?: V | ReadonlyArray<V> | null;
      readonly not?: boolean;
      readonly quantifier?: "any" | "all";
      readonly config?: string;
    };

type WhereOf<R, EmbedKeys extends string> = {
  readonly [K in keyof R & string]?: Filter<R[K]>;
} & {
  readonly and?: ReadonlyArray<WhereOf<R, EmbedKeys>>;
  readonly or?: ReadonlyArray<WhereOf<R, EmbedKeys>>;
} & {
  /**
   * A filter on an embedded resource, by its dotted path, the way the query string writes it. The
   * column belongs to the other resource, so only the shape of the condition is checked here --
   * prefer the embed's own `where`, which knows its columns.
   */
  readonly [K in `${EmbedKeys}.${string}`]?: Filter<Scalar>;
};

type OrderOf<R> =
  | (keyof R & string)
  | `${keyof R & string}.${"asc" | "desc"}`
  | `${keyof R & string}.${"asc" | "desc"}.${"nullsfirst" | "nullslast"}`
  | {
      readonly column: keyof R & string;
      readonly desc?: boolean;
      readonly nulls?: "first" | "last";
    };

type Where<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = WhereOf<
  Row<Db, S, T>,
  keyof Embeds<Db, S, T> & string
>;

type Order<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = OrderOf<Row<Db, S, T>>;

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

interface Common {
  /** At most this many rows. A read that is capped answers `206` with a `Content-Range`. */
  readonly limit?: number;
  /** Skip this many rows. Needs an `order` to mean anything stable. */
  readonly offset?: number;
  /**
   * Return one object instead of an array. Anything other than exactly one row is a `406`
   * (`PGRST116`), so `data` is the row itself, never `undefined`.
   */
  readonly single?: boolean;
  /**
   * Also count the rows the filters match, ignoring `limit`/`offset`, into `count`:
   * `"exact"` counts them, `"planned"` asks the planner, `"estimated"` takes the planner's
   * number only when it is above `maxRows`.
   */
  readonly count?: "exact" | "planned" | "estimated";
  /** Leave `null` fields out of the result rather than spelling them out. */
  readonly stripNulls?: boolean;
  /** Refuse the call -- and roll it back -- if it would affect more rows than this (`PGRST124`). */
  readonly maxAffected?: number;
  /** Run the statement in this time zone, which is what `timestamptz` values are rendered in. */
  readonly timezone?: string;
}

/** `schema` is optional for the default schema and required for any other. */
type AtSchema<Db extends AnyDatabase, S extends Schema<Db>> = S extends Db["default"]
  ? { readonly schema?: S }
  : { readonly schema: S };

/**
 * Everything a query on one relation may say. Reads and writes share **one** member per table on
 * purpose: when several members of the union carry the same `table` value, TypeScript cannot pick
 * one from the discriminant, and the editor then offers every table's columns inside `select` and
 * `where`. What the separate shapes used to enforce is enforced by {@link WriteRules} instead.
 */
type TableQuery<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = Common &
  AtSchema<Db, S> & {
    /**
     * The table or view to read or write. It is what restricts everything below: `select`, `where`
     * and `order` only accept this relation's columns, and `rows`/`set` its writable ones.
     */
    readonly table: T;
    /** Never both: the discriminant has to exist on every member for the editor to pick one. */
    readonly rpc?: never;
    /**
     * What to do. `"select"` (the default) reads; `"insert"` and `"upsert"` take `rows`, `"update"`
     * takes `set`, `"delete"` takes neither. A write returns its rows unless `returning: "minimal"`.
     */
    readonly action?: "select" | "insert" | "upsert" | "update" | "delete";
    /**
     * The columns to return, and the resources to embed. A string is a column (`"title"`) or a
     * renamed one (`"name:title"`); `"*"` takes them all; `{ tags: ["label"] }` embeds a related
     * resource, and `{ tags: { select, inner, where, order, limit, as, spread } }` is its long form.
     *
     * `data` is inferred from exactly this: pick two columns and the rows have two keys.
     */
    readonly select?: SelectList<Db, S, T>;
    /**
     * Which rows, by column. A plain value means `eq` (and `null` means `is.null`),
     * `["gte", 3]` names an operator, and `{ op, value, not, quantifier, config }` is the long form.
     * `and` and `or` take a list of nested groups; a dotted key filters an embedded resource.
     */
    readonly where?: Where<Db, S, T>;
    /** How to sort: `"created"`, `"created.desc"`, or `{ column, desc, nulls }`. */
    readonly order?: ReadonlyArray<Order<Db, S, T>>;
    /**
     * What to insert: one object or many. Generated and `GENERATED ALWAYS AS IDENTITY` columns are
     * absent, and a column with a default or a nullable one is optional.
     */
    readonly rows?: Relations<Db, S>[T]["insert"] | ReadonlyArray<Relations<Db, S>[T]["insert"]>;
    /** The columns to change, for an `"update"`. The rows are the ones `where` matches. */
    readonly set?: Relations<Db, S>[T]["update"];
    /** For an `"upsert"`, the columns the conflict is resolved on. Defaults to the primary key. */
    readonly onConflict?: ReadonlyArray<Column<Db, S, T>>;
    /** Insert only these columns, ignoring any other key in `rows` (and so making a bulk insert uniform). */
    readonly columns?: ReadonlyArray<Column<Db, S, T>>;
    /** What a column missing from `rows` gets: its `DEFAULT` (the default here) or `null`. */
    readonly missing?: "default" | "null";
    /** Whether a write answers with the rows it touched (the default here) or with nothing. */
    readonly returning?: "representation" | "minimal";
  };

/**
 * The payload each action needs, and refuses: `rows` belongs to an insert or an upsert, `set` to an
 * update, and a read has no business with either. Required here rather than in the shape, because
 * an optional property that must sometimes be present cannot be said in one object type.
 */
type WriteRules<Db extends AnyDatabase, Q> = (Q extends { action: "insert" | "upsert" }
  ? {
      readonly rows: WriteShape<Db, Q, "insert"> | ReadonlyArray<WriteShape<Db, Q, "insert">>;
    }
  : { readonly rows?: never; readonly onConflict?: never; readonly columns?: never; readonly missing?: never }) &
  (Q extends { action: "update" } ? { readonly set: WriteShape<Db, Q, "update"> } : { readonly set?: never }) &
  (Q extends { action: "insert" | "upsert" | "update" | "delete" } ? unknown : { readonly returning?: never });

type Rpc<Db extends AnyDatabase, S extends Schema<Db>, F extends keyof Functions<Db, S> & string> = Common &
  AtSchema<Db, S> & {
    /**
     * The function to call, like `POST /rpc/name`. Its arguments and its result come from the
     * signature the catalog carries, overloads included.
     */
    readonly rpc: F;
    /**
     * `table` is absent from a function call, but it must still be *declared*: a union where some
     * members lack the discriminant altogether is one TypeScript will not narrow, and the editor
     * then offers every table's columns inside `select`.
     */
    readonly table?: never;
    /** A function call has no action: it is whatever the function does. */
    readonly action?: never;
    /** The arguments, by name. A parameter with a `DEFAULT` is optional. */
    readonly args?: Functions<Db, S>[F][number]["args"];
    /**
     * A function's result is a row like any other, so it takes the same three. These apply to the
     * rows it returns, not to its arguments -- and a scalar function has no columns to ask for.
     */
    readonly select?: RowSelect<Functions<Db, S>[F][number]["returns"]>;
    /** Filters on the rows the function returned, by their column. */
    readonly where?: WhereOf<Functions<Db, S>[F][number]["returns"], never>;
    /** How to sort the rows the function returned. */
    readonly order?: ReadonlyArray<OrderOf<Functions<Db, S>[F][number]["returns"]>>;
  };

/** The keys any member of a union accepts (`keyof` a union keeps only the common ones). */
type KeysOfUnion<U> = U extends unknown ? keyof U : never;

/**
 * Inference through a type parameter checks assignability, which does not flag excess properties:
 * `{ table: "t", limitt: 10 }` would type-check and the misspelled field would be dropped in
 * silence. Intersecting this makes any unknown key `never`, so it has to be reported.
 */
export type NoExtraKeys<Q, Allowed> = {
  readonly [K in Exclude<keyof Q, KeysOfUnion<Allowed>>]: never;
};

/** The insert or update shape of the relation a query writes to. */
type WriteShape<Db extends AnyDatabase, Q, Field extends "insert" | "update"> = Q extends { table: infer T }
  ? T extends Table<Db, SchemaIn<Db, Q>>
    ? Relations<Db, SchemaIn<Db, Q>>[T][Field]
    : never
  : never;

/**
 * The same guard, for the payload of a write: `rows: { id: 42, ... }` on a generated column, or any
 * other key the relation does not accept, would otherwise reach the database and be refused there.
 */
type NoExtraPayload<Db extends AnyDatabase, Q> = (Q extends { rows: infer R }
  ? {
      // mapped over the tuple, not over `infer E`: the element union would keep only the keys the
      // rows have in common, and a stray key on one of them would slip through
      readonly rows: R extends ReadonlyArray<unknown>
        ? { readonly [I in keyof R]: R[I] & NoExtraKeys<R[I], WriteShape<Db, Q, "insert">> }
        : R & NoExtraKeys<R, WriteShape<Db, Q, "insert">>;
    }
  : unknown) &
  (Q extends { set: infer U } ? { readonly set: U & NoExtraKeys<U, WriteShape<Db, Q, "update">> } : unknown);

/** What a `where` may be keyed by: this relation's columns, a group, or an embedded dotted path. */
type WhereKeys<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> =
  | Column<Db, S, T>
  | "and"
  | "or"
  | `${keyof Embeds<Db, S, T> & string}.${string}`;

/**
 * A condition on something that is not a column of this relation. An unknown key inside `where` is
 * not reported by assignability either -- `{ "titel": true }` would reach the database and come
 * back as a `42703`. The columns of the relation the query names, so after its `table`.
 */
type NoExtraWhereKeys<Db extends AnyDatabase, Q> = Q extends { where: infer W }
  ? Q extends { table: infer T }
    ? T extends Table<Db, SchemaIn<Db, Q>>
      ? { readonly where: W & { readonly [K in Exclude<keyof W, WhereKeys<Db, SchemaIn<Db, Q>, T>>]: never } }
      : unknown
    : unknown
  : unknown;

/** Every query this database allows, as a union discriminated by `table` or `rpc`. */
export type TypedQuery<Db extends AnyDatabase> = {
  [S in Schema<Db>]:
    | { [T in Table<Db, S>]: TableQuery<Db, S, T> }[Table<Db, S>]
    | { [F in keyof Functions<Db, S> & string]: Rpc<Db, S, F> }[keyof Functions<Db, S> & string];
}[Schema<Db>];

// ---------------------------------------------------------------------------
// the result
// ---------------------------------------------------------------------------

type SchemaIn<Db extends AnyDatabase, Q> = Q extends { schema: infer S }
  ? S extends Schema<Db>
    ? S
    : never
  : Db["default"] & Schema<Db>;

/** The overloads of the function a query calls. */
type Signatures<Db extends AnyDatabase, Q> = Q extends { rpc: infer F }
  ? F extends keyof Functions<Db, SchemaIn<Db, Q>> & string
    ? Functions<Db, SchemaIn<Db, Q>>[F][number]
    : never
  : never;

/** One row of the answer, before `single` decides whether it comes alone. */
type RowOut<Db extends AnyDatabase, Q> = Q extends { rpc: string }
  ? Q extends { select: infer Items }
    ? PickedFrom<Signatures<Db, Q>["returns"], Items>
    : Signatures<Db, Q>["returns"]
  : Q extends { table: infer T }
    ? T extends Table<Db, SchemaIn<Db, Q>>
      ? Q extends { select: infer Items }
        ? Selected<Db, SchemaIn<Db, Q>, T, Items>
        : Row<Db, SchemaIn<Db, Q>, T>
      : never
    : never;

/**
 * What `data` holds: the rows, one object with `single`, and `null` for a write that was asked to
 * return nothing or a function that returns `void`.
 */
export type QueryData<Db extends AnyDatabase, Q> = Q extends { returning: "minimal" }
  ? null
  : Q extends { single: true }
    ? RowOut<Db, Q>
    : Q extends { rpc: string }
      ? // a set-returning function answers with rows, a scalar one with the value itself
        [Signatures<Db, Q>["set"]] extends [true]
        ? RowOut<Db, Q>[]
        : RowOut<Db, Q>
      : RowOut<Db, Q>[];

// ---------------------------------------------------------------------------
// the instance
// ---------------------------------------------------------------------------

/**
 * A {@link PgRestInstance} whose `query` and `querySafe` are typed by a generated database type:
 * `table` and `rpc` are the ones that exist, `select` and `where` only name real columns and
 * relationships, and `data` is inferred from the `select`.
 *
 * `handle` is unchanged: HTTP requests are strings from outside and cannot be typed.
 */
export interface TypedPgRestInstance<Db extends AnyDatabase> extends Omit<PgRestInstance, "query" | "querySafe"> {
  /**
   * Run a query, in-process. `table` (or `rpc`) decides what the rest may say: `select`, `where` and
   * `order` take this relation's columns and the resources a foreign key leads to, `rows` and `set`
   * its writable columns. `data` is inferred from the `select`, nesting included.
   *
   * `ctx` is who is asking -- `{ role, claims, settings }` -- applied with `set_config`, so row
   * level security and privileges work as they do over HTTP. They are the database's business: no
   * type here knows what a role may do.
   *
   * Failures **throw** a `QueryError` carrying the PostgREST status and body. Use
   * {@link TypedPgRestInstance.querySafe} to get them as a value instead.
   *
   * @example
   * const { data } = await pgRest.query({
   *   table: "todos",
   *   select: ["id", "title", { tags: ["label"] }],
   *   where: { done: false },
   *   limit: 10,
   * });
   * // data: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
   */
  query<const Q extends TypedQuery<Db>>(
    input: Q & NoExtraKeys<Q, TypedQuery<Db>> & NoExtraPayload<Db, Q> & NoExtraWhereKeys<Db, Q> & WriteRules<Db, Q>,
    ctx?: RequestContext,
  ): Promise<QueryResult<QueryData<Db, Q>>>;
  /**
   * {@link TypedPgRestInstance.query} with the failure as a value: `{ data, error }`, where exactly
   * one of the two is set, so `if (error)` leaves `data` non-null. It never rejects.
   *
   * @example
   * const { data, error } = await pgRest.querySafe({ table: "todos", select: ["id"] });
   * if (error) return c.json(error.body, error.status);
   */
  querySafe<const Q extends TypedQuery<Db>>(
    input: Q & NoExtraKeys<Q, TypedQuery<Db>> & NoExtraPayload<Db, Q> & NoExtraWhereKeys<Db, Q> & WriteRules<Db, Q>,
    ctx?: RequestContext,
  ): Promise<QuerySafeResult<QueryData<Db, Q>>>;
}
