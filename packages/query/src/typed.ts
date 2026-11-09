import type { SqlRequestContext as RequestContext } from "@tsql/core/core";
import type {
  ContextSource,
  CountFrom,
  DefaultValue,
  Expression,
  FtsValue,
  Prepared,
  PreparedArgs,
  QueryOk,
  QueryResult,
  Scalar,
  Settled,
  TransactionOptions,
} from "./query";
import type { QueryInstance } from "./index";

/**
 * The types `generateTypes` emits, as constraints. They describe a database, not a query: see
 * {@link TypedSelect} (and its siblings) for what a call may say, and {@link QueryData} for what it returns.
 */
export interface AnyRelation {
  readonly row: Record<string, unknown>;
  readonly insert: Record<string, unknown>;
  readonly update: Record<string, unknown>;
  /** The columns that have a `DEFAULT`, and so the ones `{ $default: true }` may be used on. */
  readonly defaults: string;
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
/** The columns of `T` that have a `DEFAULT`. */
type Defaults<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = Relations<Db, S>[T]["defaults"];
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
 * `{ relation: [...] }` or `{ relation: { columns, inner, limit, ... } }`.
 *
 * The other string forms of a `select` -- casts, JSON paths, aggregates -- are not described here: they
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
  readonly columns?: SelectList<Db, S, T>;
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
 * `as` and `spread` are exclusive, because the request has no way to write both:
 * `...alias:table(*)` does not parse, so a type that accepted it would promise
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
  columns: infer Items;
}
  ? Selected<Db, S, T, Items>
  : Row<Db, S, T>;

type Arrayed<R> = { [K in keyof R]: R[K][] };

type EmbedOf<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>, Rel, Spec> =
  Spec extends ReadonlyArray<unknown>
    ? Shaped<Rel, Spec, Selected<Db, S, T, Spec>>
    : Spec extends { columns: infer Items }
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

/**
 * What a column may be compared against. A composite value may leave fields out -- the row it is
 * compared with has NULL there -- so the shape is the same one a write accepts.
 */
type Comparable<V> =
  V extends ReadonlyArray<unknown> ? V : V extends object ? { readonly [K in keyof V]?: Comparable<V[K]> } : V;

type IsValue = null | boolean | "null" | "not_null" | "true" | "false" | "unknown";

/** What a column is compared against: its own type, nullable. */
type Cmp<V> = Comparable<NonNullable<V>>;

/** The element of an array column, or the column itself. */
type Elem<V> = NonNullable<V> extends ReadonlyArray<infer E> ? E : NonNullable<V>;

/** Operators every column has. */
interface EqualityOps<V> {
  readonly $eq?: Cmp<V> | ReadonlyArray<Elem<V>> | null;
  readonly $neq?: Cmp<V> | ReadonlyArray<Elem<V>> | null;
  readonly $in?: ReadonlyArray<Cmp<V>>;
  readonly $is?: IsValue;
  readonly $isdistinct?: Cmp<V> | ReadonlyArray<Elem<V>> | null;
}

/** Numbers, text, dates and arrays have an order. */
interface OrderOps<V> {
  readonly $gt?: Cmp<V>;
  readonly $gte?: Cmp<V>;
  readonly $lt?: Cmp<V>;
  readonly $lte?: Cmp<V>;
}

/** `*` is the wildcard of `$like` and `$ilike`; `$match` and `$imatch` take a POSIX regular expression. */
interface PatternOps {
  readonly $like?: string;
  readonly $ilike?: string;
  readonly $match?: string;
  readonly $imatch?: string;
}

/** Full-text search: a query, or a query with its configuration. */
interface SearchOps {
  readonly $fts?: string | FtsValue;
  readonly $plfts?: string | FtsValue;
  readonly $phfts?: string | FtsValue;
  readonly $wfts?: string | FtsValue;
}

/** Containment and overlap, for arrays (and ranges and `jsonb`, which the generated types leave `unknown`). */
interface ContainOps<V> {
  readonly $cs?: ReadonlyArray<Elem<V>> | string;
  readonly $cd?: ReadonlyArray<Elem<V>> | string;
  readonly $ov?: ReadonlyArray<Elem<V>> | string;
}

/** Range positions: strictly left, strictly right, does not extend right/left, adjacent. */
interface RangeOps {
  readonly $sl?: string;
  readonly $sr?: string;
  readonly $nxl?: string;
  readonly $nxr?: string;
  readonly $adj?: string;
}

/** Which operators a column takes, by the kind of its TypeScript type. */
type CoreOps<V> = [unknown] extends [V]
  ? EqualityOps<V> & OrderOps<V> & PatternOps & SearchOps & ContainOps<V> & RangeOps
  : NonNullable<V> extends ReadonlyArray<unknown>
    ? EqualityOps<V> & OrderOps<V> & ContainOps<V>
    : NonNullable<V> extends number
      ? EqualityOps<V> & OrderOps<V>
      : NonNullable<V> extends string
        ? EqualityOps<V> & OrderOps<V> & PatternOps & SearchOps
        : EqualityOps<V>;

/** `$any` / `$all`: the operator applied to a list of values, the column against each. */
interface QuantifiedOps<V> {
  readonly $eq?: ReadonlyArray<Elem<V>>;
  readonly $gt?: ReadonlyArray<Elem<V>>;
  readonly $gte?: ReadonlyArray<Elem<V>>;
  readonly $lt?: ReadonlyArray<Elem<V>>;
  readonly $lte?: ReadonlyArray<Elem<V>>;
  readonly $like?: ReadonlyArray<string>;
  readonly $ilike?: ReadonlyArray<string>;
  readonly $match?: ReadonlyArray<string>;
  readonly $imatch?: ReadonlyArray<string>;
}

/** The column against each value of a list, so on a column that holds one value: an array column has no `$any`. */
interface Quantifiers<V> {
  readonly $any?: NonNullable<V> extends ReadonlyArray<unknown> ? never : QuantifiedOps<V>;
  readonly $all?: NonNullable<V> extends ReadonlyArray<unknown> ? never : QuantifiedOps<V>;
}

/**
 * The operators of a column, each starting with `$`: `{ $gte: 100, $lt: 500 }` is `>= 100 AND < 500`.
 * `$not` inverts one of them (`{ $not: { $in: [1, 2] } }`, or `{ $not: null }` for a plain value), and `$any` / `$all` compare the column
 * with each value of a list (`{ $any: { $like: ["a*", "b*"] } }`).
 */
type Operators<V> = CoreOps<V> &
  Quantifiers<V> & { readonly $not?: PlainValue<V> | null | (CoreOps<V> & Quantifiers<V>) };

/**
 * A condition on a column: the value itself (`eq`), `null` (`is.null`), or its operators. An array
 * is not a condition on its own -- `{ $eq: [...] }` says it is compared with one.
 */
type Filter<V> = PlainValue<V> | null | Operators<V>;

/** A value that is a condition by itself: not an array, which has to say how it is compared. */
type PlainValue<V> = Exclude<Cmp<V>, ReadonlyArray<unknown>>;

type WhereOf<R, EmbedKeys extends string> = {
  readonly [K in keyof R & string]?: Filter<R[K]>;
} & {
  readonly $and?: ReadonlyArray<WhereOf<R, EmbedKeys>>;
  readonly $or?: ReadonlyArray<WhereOf<R, EmbedKeys>>;
  /** The conditions inside are ANDed, then inverted. */
  readonly $not?: WhereOf<R, EmbedKeys>;
} & {
  /**
   * A filter on a path into a column: `"meta->>tier"`, `"owner->home->>city"`. The path does not
   * change the shape of the result, so it is accepted here -- unlike in a `select` -- and the value
   * is checked no further than its shape, since the type of a JSON field is not known.
   */
  readonly [K in `${keyof R & string}->${string}`]?: Scalar | Operators<unknown>;
} & {
  /**
   * A filter on an embedded resource, by its dotted path, the way the query string writes it. The
   * column belongs to the other resource, so only the shape of the condition is checked here --
   * prefer the embed's own `where`, which knows its columns.
   */
  readonly [K in `${EmbedKeys}.${string}`]?: Scalar | Operators<unknown>;
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
   * Return one object instead of an array. Anything other than exactly one row is a `not_single_row`
   * error, so `data` is the row itself, never `undefined`. An insert of a single `rows` object does
   * this on its own; `single: false` asks it for the array.
   */
  readonly single?: boolean;
  /**
   * Also count the rows the filters match, ignoring `limit`/`offset`, into `count`:
   * `"exact"` counts them, `"planned"` asks the planner, `"estimated"` takes the planner's
   * number only when it is above `maxRows`.
   *
   * The mode decides the type of `count`: a `number` for `"exact"` and `"estimated"`,
   * `number | undefined` for `"planned"` (an `EXPLAIN` can give nothing usable), and `undefined`
   * when no count is asked for.
   */
  readonly count?: "exact" | "planned" | "estimated";
  /** Leave `null` fields out of the result rather than spelling them out. */
  readonly stripNulls?: boolean;
  /** Refuse the call -- and roll it back -- if it would affect more rows than this (`too_many_affected`). */
  readonly maxAffected?: number;
  /** Run the statement in this time zone, which is what `timestamptz` values are rendered in. */
  readonly timezone?: string;
}

/** `schema` is optional for the default schema and required for any other. */
type AtSchema<Db extends AnyDatabase, S extends Schema<Db>> = S extends Db["default"]
  ? { readonly schema?: S }
  : { readonly schema: S };

/**
 * What any operation on one relation may say. `table` is what restricts everything below: `where`
 * and `order` only accept this relation's columns. Each operation has its own union with one member
 * per table: were several members to carry the same `table` value, TypeScript could not pick one
 * from the discriminant, and the editor would offer every table's columns inside `columns` and `where`.
 */
type TableBase<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = Common &
  AtSchema<Db, S> & {
    /**
     * The table or view to read or write. It is what restricts everything below: `columns`, `where`
     * and `order` only accept this relation's columns, and `rows`/`set` its writable ones.
     */
    readonly table: T;
    /**
     * Which rows, by column. A plain value means `eq` (and `null` means `is.null`), and
     * `{ $gte: 3, $lt: 9 }` names the operators; `$not`, `$any` and `$all` modify one.
     * `$and` and `$or` take a list of nested groups, `$not` one group to invert; a dotted key
     * filters an embedded resource.
     */
    readonly where?: Where<Db, S, T>;
    /** How to sort: `"created"`, `"created.desc"`, or `{ column, desc, nulls }`. */
    readonly order?: ReadonlyArray<Order<Db, S, T>>;
  };

/** A read of one relation. */
type TableRead<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = TableBase<Db, S, T> & {
  /**
   * The columns to return, and the resources to embed. A string is a column (`"title"`) or a
   * renamed one (`"name:title"`); `"*"` takes them all; `{ tags: ["label"] }` embeds a related
   * resource, and `{ tags: { columns, inner, where, order, limit, as, spread } }` is its long form.
   *
   * `data` is inferred from exactly this: pick two columns and the rows have two keys.
   */
  readonly columns?: SelectList<Db, S, T>;
};

/**
 * What a write answers with: its rows (`"representation"`, the default), nothing (`"minimal"`), or
 * its rows with only these columns and embeds, like the `RETURNING` of the statement. `data` is
 * inferred from the list.
 */
interface Returning<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> {
  readonly returning?: "representation" | "minimal" | SelectList<Db, S, T>;
}

/** An insert of one row or several. */
type TableInsert<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = TableBase<Db, S, T> &
  Returning<Db, S, T> & {
    /**
     * What to insert: one object or many. Generated and `GENERATED ALWAYS AS IDENTITY` columns are
     * absent, and a column with a default or a nullable one is optional.
     *
     * It decides the answer's shape too: one object comes back as that object, an array of them as
     * an array of rows.
     */
    readonly rows: Relations<Db, S>[T]["insert"] | ReadonlyArray<Relations<Db, S>[T]["insert"]>;
    /** Insert only these columns, ignoring any other key in `rows` (and so making a bulk insert uniform). */
    readonly columns?: ReadonlyArray<Column<Db, S, T>>;
    /** What a column missing from `rows` gets: its `DEFAULT` (the default here) or `null`. */
    readonly missing?: "default" | "null";
  };

/** An insert that resolves a conflict by updating the row it finds. */
type TableUpsert<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = TableInsert<Db, S, T> & {
  /** The columns the conflict is resolved on. Defaults to the primary key. */
  readonly onConflict?: ReadonlyArray<Column<Db, S, T>>;
};

/** An update of the rows `where` matches. */
type TableUpdate<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = TableBase<Db, S, T> &
  Returning<Db, S, T> & {
    /** The columns to change. The rows are the ones `where` matches. */
    readonly set: SetOf<Relations<Db, S>[T]["update"], Defaults<Db, S, T>>;
  };

/** A delete of the rows `where` matches. */
type TableDelete<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> = TableBase<Db, S, T> &
  Returning<Db, S, T>;

type Rpc<Db extends AnyDatabase, S extends Schema<Db>, F extends keyof Functions<Db, S> & string> = Common &
  AtSchema<Db, S> & {
    /**
     * The function to call, like `POST /rpc/name`. Its arguments and its result come from the
     * signature the catalog carries, overloads included.
     */
    readonly rpc: F;
    /** The arguments, by name. A parameter with a `DEFAULT` is optional. */
    readonly args?: Functions<Db, S>[F][number]["args"];
    /**
     * A function's result is a row like any other, so it takes the same three. These apply to the
     * rows it returns, not to its arguments -- and a scalar function has no columns to ask for.
     */
    readonly columns?: RowSelect<Functions<Db, S>[F][number]["returns"]>;
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

/**
 * What an update may set: the columns of the relation, each to its type or to an expression the
 * database computes (`{ $add: [{ $col: "total" }, 10] }`, `{ $default: true }`).
 *
 * `D` is the columns that have a `DEFAULT`, and `{ $default: true }` is offered on those alone:
 * `SET col = DEFAULT` on a column without one is a null, which is a refusal on a `NOT NULL` column
 * and a silent loss anywhere else.
 */
type SetOf<U, D extends string> = {
  readonly [K in keyof U]?: U[K] | ExpressionFor<U, U[K]> | (K extends D ? DefaultValue : never);
};

/** The columns of `U` that hold a `T`, for `$col`. */
type ColumnsOf<U, T> = {
  readonly [K in keyof U & string]-?: [NonNullable<U[K]>] extends [T] ? K : never;
}[keyof U & string];

/**
 * An expression for a column of type `V`: its operators are the ones that give such a value, and its
 * `$col` names a column of the same kind. A column PostgreSQL types more finely than TypeScript does
 * (`jsonb`, ranges) is `unknown` and takes any expression, as does `$cast`, which says its own type.
 */
type ExpressionFor<U, V> = unknown extends V
  ? Expression
  : [NonNullable<V>] extends [never]
    ? Expression
    : [NonNullable<V>] extends [number | bigint]
      ? NumberExpression<U>
      : [NonNullable<V>] extends [string]
        ? StringExpression<U>
        : [NonNullable<V>] extends [boolean]
          ? BooleanExpression<U>
          : [NonNullable<V>] extends [ReadonlyArray<infer E>]
            ? ArrayExpression<U, E>
            : Expression;

type Cast = { readonly $cast: readonly [Expression, string] };
type Value = { readonly $val: unknown };

// Each `{ [K in Keys]: { [P in K]: … } }[Keys]` is one node per key: `{ $add: X[] } | { $sub: X[] } | …`.
// It is written out where it is used, because TypeScript only allows a recursive type through the
// properties of an object type, not through the argument of another alias.

type NumberExpression<U> =
  | number
  | Value
  | Cast
  | { readonly $col: ColumnsOf<U, number | bigint> }
  | { readonly [K in "$neg" | "$abs"]: { readonly [P in K]: NumberExpression<U> } }["$neg" | "$abs"]
  | { readonly $round: readonly [NumberExpression<U>] | readonly [NumberExpression<U>, number] }
  | { readonly $length: StringExpression<U> }
  | {
      readonly [K in NumberList]: { readonly [P in K]: ReadonlyArray<NumberExpression<U>> };
    }[NumberList];

type NumberList = "$add" | "$sub" | "$mul" | "$div" | "$mod" | "$pow" | "$coalesce" | "$greatest" | "$least";
// dates and timestamps are strings too: `placed_at + '1 day'`
type StringList = "$concat" | "$add" | "$sub" | "$coalesce" | "$greatest" | "$least";
type StringFn = "$lower" | "$upper" | "$trim";
type Comparison = "$eq" | "$neq" | "$gt" | "$gte" | "$lt" | "$lte" | "$cs" | "$cd" | "$ov";

type StringExpression<U> =
  | string
  | Value
  | Cast
  | { readonly $col: ColumnsOf<U, string> }
  | { readonly $now: true }
  | { readonly [K in StringFn]: { readonly [P in K]: StringExpression<U> } }[StringFn]
  | { readonly [K in StringList]: { readonly [P in K]: ReadonlyArray<StringExpression<U>> } }[StringList];

type BooleanExpression<U> =
  | boolean
  | Value
  | Cast
  | { readonly $col: ColumnsOf<U, boolean> }
  | { readonly $not: BooleanExpression<U> }
  | { readonly $and: ReadonlyArray<BooleanExpression<U>> }
  | { readonly $or: ReadonlyArray<BooleanExpression<U>> }
  | { readonly $coalesce: ReadonlyArray<BooleanExpression<U>> }
  | { readonly [K in Comparison]: { readonly [P in K]: readonly [Expression, Expression] } }[Comparison];

type ArrayExpression<U, E> =
  | Value
  | Cast
  | { readonly $col: ColumnsOf<U, ReadonlyArray<E>> }
  | { readonly $concat: ReadonlyArray<ArrayExpression<U, E>> }
  | { readonly $coalesce: ReadonlyArray<ArrayExpression<U, E>> }
  | { readonly $arrayAppend: readonly [ArrayExpression<U, E>, E | Value] }
  | { readonly $arrayRemove: readonly [ArrayExpression<U, E>, E | Value] };

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
  (Q extends { set: infer U }
    ? { readonly set: U & NoExtraKeys<U, SetOf<WriteShape<Db, Q, "update">, string>> }
    : unknown);

/** What a `where` may be keyed by: this relation's columns, a group, or an embedded dotted path. */
type WhereKeys<Db extends AnyDatabase, S extends Schema<Db>, T extends Table<Db, S>> =
  | Column<Db, S, T>
  | "$and"
  | "$or"
  | "$not"
  | `${Column<Db, S, T>}->${string}`
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

/** Every `select` this database allows, as a union discriminated by `table`. */
export type TypedSelect<Db extends AnyDatabase> = {
  [S in Schema<Db>]: { [T in Table<Db, S>]: TableRead<Db, S, T> }[Table<Db, S>];
}[Schema<Db>];

/** Every `insert` this database allows. */
export type TypedInsert<Db extends AnyDatabase> = {
  [S in Schema<Db>]: { [T in Table<Db, S>]: TableInsert<Db, S, T> }[Table<Db, S>];
}[Schema<Db>];

/** Every `upsert` this database allows. */
export type TypedUpsert<Db extends AnyDatabase> = {
  [S in Schema<Db>]: { [T in Table<Db, S>]: TableUpsert<Db, S, T> }[Table<Db, S>];
}[Schema<Db>];

/** Every `update` this database allows. */
export type TypedUpdate<Db extends AnyDatabase> = {
  [S in Schema<Db>]: { [T in Table<Db, S>]: TableUpdate<Db, S, T> }[Table<Db, S>];
}[Schema<Db>];

/** Every `delete` this database allows. */
export type TypedDelete<Db extends AnyDatabase> = {
  [S in Schema<Db>]: { [T in Table<Db, S>]: TableDelete<Db, S, T> }[Table<Db, S>];
}[Schema<Db>];

/** Every function call this database allows, as a union discriminated by `rpc`. */
export type TypedRpc<Db extends AnyDatabase> = {
  [S in Schema<Db>]: { [F in keyof Functions<Db, S> & string]: Rpc<Db, S, F> }[keyof Functions<Db, S> & string];
}[Schema<Db>];

/**
 * An input checked against what an operation allows. Inference through a type parameter does not
 * flag excess properties, so the keys, the payload and the `where` are each checked on their own.
 */
type Guard<Db extends AnyDatabase, Q, Allowed> = Q &
  NoExtraKeys<Q, Allowed> &
  NoExtraPayload<Db, Q> &
  NoExtraWhereKeys<Db, Q>;

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
  ? Q extends { columns: infer Items }
    ? PickedFrom<Signatures<Db, Q>["returns"], Items>
    : Signatures<Db, Q>["returns"]
  : Q extends { table: infer T }
    ? T extends Table<Db, SchemaIn<Db, Q>>
      ? TableRowOut<Db, Q, T>
      : never
    : never;

/**
 * A table's row: the list a read names in `columns`, or the one a write names in `returning`. An insert
 * has a `columns` of its own -- the columns it inserts -- which says nothing about the answer.
 */
type TableRowOut<Db extends AnyDatabase, Q, T extends Table<Db, SchemaIn<Db, Q>>> = Q extends {
  returning: infer R;
}
  ? R extends ReadonlyArray<unknown>
    ? Selected<Db, SchemaIn<Db, Q>, T, R>
    : Row<Db, SchemaIn<Db, Q>, T>
  : Q extends { rows: unknown }
    ? Row<Db, SchemaIn<Db, Q>, T>
    : Q extends { columns: infer Items }
      ? Selected<Db, SchemaIn<Db, Q>, T, Items>
      : Row<Db, SchemaIn<Db, Q>, T>;

/**
 * What `data` holds: the rows, one object with `single`, and `null` for a write that was asked to
 * return nothing or a function that returns `void`.
 *
 * An insert needs no `single`: one `rows` object is one row by construction, so it answers with that
 * object, and an array of them answers with an array. `single: false` asks for the array anyway.
 */
export type QueryData<Db extends AnyDatabase, Q> = Q extends { returning: "minimal" }
  ? null
  : Q extends { single: true }
    ? RowOut<Db, Q>
    : Q extends { single: false }
      ? RowOut<Db, Q>[]
      : Q extends { rpc: string }
        ? // a set-returning function answers with rows, a scalar one with the value itself
          [Signatures<Db, Q>["set"]] extends [true]
          ? RowOut<Db, Q>[]
          : RowOut<Db, Q>
        : // an insert of one object answers with that object, of many with as many (`rows` is
          // an insert's and an upsert's alone, so it identifies them)
          Q extends { rows: infer R }
          ? R extends ReadonlyArray<unknown>
            ? RowOut<Db, Q>[]
            : RowOut<Db, Q>
          : RowOut<Db, Q>[];

// ---------------------------------------------------------------------------
// the instance
// ---------------------------------------------------------------------------

/**
 * The six operations typed by a generated database type: `table` and `rpc` are the ones that exist,
 * `columns` and `where` only name real columns and relationships, `rows` and `set` its writable
 * columns, and `data` is inferred from the `columns`, nesting included.
 *
 * `Mode` and `Ctx` are what {@link Operations} takes: how a failure comes back, and what follows the input.
 */
export interface TypedOperations<Db extends AnyDatabase, Mode extends "result" | "ok", Ctx extends unknown[]> {
  /**
   * Read rows. `columns`, `where` and `order` take this relation's columns and the resources a
   * foreign key leads to; `data` is inferred from the `columns`.
   *
   * The optional `ctx` is who is asking -- `{ role, claims, settings }` -- applied with `set_config`,
   * so row level security and privileges work as they do over HTTP. They are the database's business:
   * no type here knows what a role may do.
   *
   * A failure is part of the result: `error` is a `QueryError` (a `kind`, a `message`, `details`,
   * `hint` and the SQLSTATE of a database error), and exactly one of `data` and `error` is set, so
   * `if (error)` narrows both `data` and `count`. It never rejects.
   *
   * @example
   * const { data, error } = await pgRest.select({
   *   table: "todos",
   *   columns: ["id", "title", { tags: ["label"] }],
   *   where: { done: false },
   *   limit: 10,
   * });
   * if (error) return c.json({ error: error.message, kind: error.kind }, 400);
   * // data: Array<{ id: number; title: string; tags: Array<{ label: string }> }>
   */
  select<const Q extends TypedSelect<Db>>(
    input: Guard<Db, Q, TypedSelect<Db>>,
    ...ctx: Ctx
  ): Promise<Settled<Mode, QueryData<Db, Q>, CountFrom<Q>>>;
  /**
   * Insert one row or several. `rows` is required and takes the relation's writable columns; the
   * rows come back unless `returning: "minimal"`; `returning: ["id"]` returns only those columns.
   *
   * `rows` decides the answer's shape: one object comes back as that object, an array of them as an
   * array of rows. `single: false` asks a one-object insert for the array.
   *
   * @example
   * const { data } = await pgRest.insert({ table: "todos", rows: { title: "ship it" } });
   * data.id; // one row in, one row out
   */
  insert<const Q extends TypedInsert<Db>>(
    input: Guard<Db, Q, TypedInsert<Db>>,
    ...ctx: Ctx
  ): Promise<Settled<Mode, QueryData<Db, Q>, CountFrom<Q>>>;
  /** Insert, or update the row a conflict is found with: `onConflict` names the columns, the primary key by default. */
  upsert<const Q extends TypedUpsert<Db>>(
    input: Guard<Db, Q, TypedUpsert<Db>>,
    ...ctx: Ctx
  ): Promise<Settled<Mode, QueryData<Db, Q>, CountFrom<Q>>>;
  /** Change the rows `where` matches. `set` is required; a column takes a value or an expression the database computes. */
  update<const Q extends TypedUpdate<Db>>(
    input: Guard<Db, Q, TypedUpdate<Db>>,
    ...ctx: Ctx
  ): Promise<Settled<Mode, QueryData<Db, Q>, CountFrom<Q>>>;
  /** Remove the rows `where` matches. */
  delete<const Q extends TypedDelete<Db>>(
    input: Guard<Db, Q, TypedDelete<Db>>,
    ...ctx: Ctx
  ): Promise<Settled<Mode, QueryData<Db, Q>, CountFrom<Q>>>;
  /** Call a function, like `POST /rpc/name`; its arguments and result come from the signature the catalog carries. */
  rpc<const Q extends TypedRpc<Db>>(
    input: Guard<Db, Q, TypedRpc<Db>>,
    ...ctx: Ctx
  ): Promise<Settled<Mode, QueryData<Db, Q>, CountFrom<Q>>>;
}

/**
 * The object {@link TypedQueryInstance.setContextQuery} returns: the instance's operations with the
 * context decided once, typed by the database.
 */
export interface TypedContextQuery<Db extends AnyDatabase> extends TypedOperations<
  Db,
  "result",
  [ctx?: RequestContext]
> {
  /** Run a call of a prepared query, with this context. */
  run<T, C extends number | undefined>(call: Prepared<T, C>, ctx?: RequestContext): Promise<QueryResult<T, C>>;
  /** {@link TypedQueryInstance.transaction} with the context read from the source, once, on entry. */
  transaction<A>(
    fn: (tx: TypedTransaction<Db>) => Promise<A>,
    options?: TransactionOptions,
  ): Promise<QueryResult<A, undefined>>;
}

/**
 * The scope `transaction()` hands out, whose operations are typed by the database, like the instance's own -- minus
 * the context, which a scope decides once, on entry. They **reject** on failure rather than answering an `error`, so
 * the result is the success: `data` is not null and `count` is the number the query asked for.
 * The scope catches it, rolls back, and hands it to you as its own `error`.
 */
export interface TypedTransaction<Db extends AnyDatabase> extends TypedOperations<Db, "ok", []> {
  /** Run a call of a prepared query in this transaction. Like the operations, it rejects on failure. */
  run<T, C extends number | undefined>(call: Prepared<T, C>): Promise<QueryOk<T, C>>;
  /** A nested scope on a `SAVEPOINT`: it rolls back on its own, leaving this one usable. */
  transaction<A>(fn: (tx: TypedTransaction<Db>) => Promise<A>): Promise<QueryResult<A, undefined>>;
  /** Roll this scope back and leave it. */
  rollback(): never;
}

export interface TypedQueryInstance<Db extends AnyDatabase>
  extends
    Omit<
      QueryInstance,
      "select" | "insert" | "upsert" | "update" | "delete" | "rpc" | "prepare" | "setContextQuery" | "transaction"
    >,
    TypedOperations<Db, "result", [ctx?: RequestContext]> {
  /**
   * Plan a select once and get a function that fills in its values: a call is string concatenation
   * and the statement for the driver, with no parsing or planning. The query is checked against the
   * database like `select`'s, and the result is typed by it. A call is run with `run`, on the
   * instance, in a transaction scope (`tx.run`) or on a `setContextQuery` object.
   *
   * An argument is a **filter value and nothing else**: `build` runs once with a stand-in for each,
   * so it cannot pick a column, an operator or a limit, and cannot branch on an argument. Preparing
   * throws, at set-up time, for a query that does not follow that. A call whose values change the
   * SQL itself (`null`, a `*` wildcard, a composite) is not an error: it runs the ordinary way.
   *
   * @example
   * const paidOver = pgRest.prepare((a: { status: string; min: number }) => ({
   *   table: "orders",
   *   columns: ["id", "total"],
   *   where: { status: a.status, total: { $gte: a.min } },
   * }));
   * const { data, error } = await pgRest.run(paidOver({ status: "paid", min: 100 }), ctx);
   */
  prepare<A extends PreparedArgs, const Q extends TypedSelect<Db>>(
    build: (args: A) => Guard<Db, Q, TypedSelect<Db>>,
  ): (args: A) => Prepared<QueryData<Db, Q>, CountFrom<Q>>;

  /**
   * The operations with the context decided once -- typically read from an `AsyncLocalStorage` your
   * middleware entered -- so queries deep in the call stack no longer carry it. They are typed
   * exactly like the instance's, minus `ctx`.
   *
   * @example
   * const store = new AsyncLocalStorage<RequestContext>();
   * const db = pgRest.setContextQuery(() => store.getStore());
   * const { data, error } = await db.select({ table: "todos", columns: ["id", "title"] });
   * // data: Array<{ id: number; title: string }>
   */
  setContextQuery(source: ContextSource): TypedContextQuery<Db>;

  /**
   * Several queries in one transaction, typed like the instance's. The context is applied once for the
   * whole scope, so the scope's operations take none; the callback's return value is the result's `data`.
   *
   * @example
   * const { data, error } = await pgRest.transaction(async (tx) => {
   *   const client = await tx.insert({ table: "clients", rows: { name: "Ada" } });
   *   await tx.insert({ table: "orders", rows: { client_id: client.data.id, total: 10 } });
   *   return client.data.id;
   * }, { role: "authenticated" });
   * // data: number | null -- null when the scope failed, which `error` is what explains
   */
  transaction<A>(
    fn: (tx: TypedTransaction<Db>) => Promise<A>,
    options?: TransactionOptions,
  ): Promise<QueryResult<A, undefined>>;
}
