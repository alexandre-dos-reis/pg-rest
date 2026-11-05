import type { RequestContext } from "./core";
import type { FilterOp, QueryResult, QuerySafeResult } from "./query";
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
 * cost more than it gives. Neither is `spread`, which merges an embed into the parent row, and for a
 * to-many embed turns each of its columns into an array. Use an untyped instance for those.
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
type Embed<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> =
  | SelectList<Db, S, T>
  | {
      readonly select?: SelectList<Db, S, T>;
      readonly inner?: boolean;
      readonly hint?: string;
      readonly as?: string;
      readonly where?: Where<Db, S, T>;
      readonly order?: ReadonlyArray<Order<Db, S, T>>;
      readonly limit?: number;
      readonly offset?: number;
    };

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
  /** A filter on an embedded resource, by its dotted path. The column is not checked there. */
  readonly [K in `${EmbedKeys}.${string}`]?: Filter<never>;
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
  readonly limit?: number;
  readonly offset?: number;
  readonly single?: boolean;
  readonly count?: "exact" | "planned" | "estimated";
  readonly stripNulls?: boolean;
  readonly maxAffected?: number;
  readonly timezone?: string;
}

/** `schema` is optional for the default schema and required for any other. */
type AtSchema<Db extends AnyDatabase, S extends Schema<Db>> = S extends Db["default"]
  ? { readonly schema?: S }
  : { readonly schema: S };

type Read<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = Common &
  AtSchema<Db, S> & {
    readonly table: T;
    readonly action?: "select";
    readonly select?: SelectList<Db, S, T>;
    readonly where?: Where<Db, S, T>;
    readonly order?: ReadonlyArray<Order<Db, S, T>>;
  };

type Write<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = Common &
  AtSchema<Db, S> & {
    readonly table: T;
    readonly select?: SelectList<Db, S, T>;
    readonly returning?: "representation" | "minimal";
  } & (
    | {
        readonly action: "insert" | "upsert";
        readonly rows: Relations<Db, S>[T]["insert"] | ReadonlyArray<Relations<Db, S>[T]["insert"]>;
        readonly onConflict?: ReadonlyArray<Column<Db, S, T>>;
        readonly columns?: ReadonlyArray<Column<Db, S, T>>;
        readonly missing?: "default" | "null";
      }
    | {
        readonly action: "update";
        readonly set: Relations<Db, S>[T]["update"];
        readonly where?: Where<Db, S, T>;
      }
    | {
        readonly action: "delete";
        readonly where?: Where<Db, S, T>;
      }
  );

type Rpc<Db extends AnyDatabase, S extends Schema<Db>, F extends keyof Functions<Db, S> & string> = Common &
  AtSchema<Db, S> & {
    readonly rpc: F;
    readonly args?: Functions<Db, S>[F][number]["args"];
    /** A function's result is a row like any other, so it takes the same three. */
    readonly select?: RowSelect<Functions<Db, S>[F][number]["returns"]>;
    readonly where?: WhereOf<Functions<Db, S>[F][number]["returns"], never>;
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

/** Every query this database allows, as a union discriminated by `table` or `rpc`. */
export type TypedQuery<Db extends AnyDatabase> = {
  [S in Schema<Db>]:
    | { [T in Table<Db, S>]: Read<Db, S, T> | Write<Db, S, T> }[Table<Db, S>]
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
  query<const Q extends TypedQuery<Db>>(
    input: Q & NoExtraKeys<Q, TypedQuery<Db>>,
    ctx?: RequestContext,
  ): Promise<QueryResult<QueryData<Db, Q>>>;
  querySafe<const Q extends TypedQuery<Db>>(
    input: Q & NoExtraKeys<Q, TypedQuery<Db>>,
    ctx?: RequestContext,
  ): Promise<QuerySafeResult<QueryData<Db, Q>>>;
}
