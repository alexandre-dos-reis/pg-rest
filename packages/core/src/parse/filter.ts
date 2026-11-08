import { type FieldRef, parseError, parseField, splitTopLevel, unquote } from "./field";
import type { SelectItem } from "./select";
import type { OPERATORS_ORDER } from "./syntax";

export type Operator = (typeof OPERATORS_ORDER)[number];

export interface Filter {
  readonly kind: "filter";
  readonly field: FieldRef;
  readonly negate: boolean;
  readonly op: Operator;
  readonly quantifier?: "any" | "all";
  /** Text search configuration, e.g. `english`. */
  readonly lang?: string;
  /** `in` yields a list, everything else a string. */
  readonly value: string | ReadonlyArray<string>;
}

export interface Logic {
  readonly kind: "logic";
  readonly op: "and" | "or";
  readonly negate: boolean;
  readonly children: ReadonlyArray<FilterNode>;
}

export type FilterNode = Filter | Logic;

export interface OrderTerm {
  readonly field: FieldRef;
  /** Set when ordering by a column of a related (to-one) embed: `order=client(name)`. */
  readonly relation?: string;
  readonly dir: "asc" | "desc";
  readonly nulls?: "first" | "last";
}

/** `?embed=is.null` / `?embed=not.is.null` */
export interface EmbedPresence {
  readonly embed: string;
  readonly present: boolean;
}

export interface NodeParams {
  readonly filters: FilterNode[];
  readonly order: OrderTerm[];
  limit?: number;
  offset?: number;
  readonly presence: EmbedPresence[];
}

export const emptyParams = (): NodeParams => ({ filters: [], order: [], presence: [] });

export interface ParsedQuery {
  readonly select: SelectItem[];
  readonly root: NodeParams;
  /** Params for embedded resources, keyed by their dotted alias path (`orders.items`). */
  readonly embeds: Map<string, NodeParams>;
  readonly onConflict?: string[];
  readonly columns?: string[];
}

// ---------------------------------------------------------------------------
// order / pagination
// ---------------------------------------------------------------------------

/** The terms of an order list (`total.desc,client(name).nullslast`), without the grammar's check. */
export const parseOrderTerms = (input: string): OrderTerm[] =>
  splitTopLevel(input, ",").map((raw) => {
    const tokens = raw.trim().split(".");
    let nulls: "first" | "last" | undefined;
    let dir: "asc" | "desc" = "asc";
    const last = () => tokens[tokens.length - 1]?.toLowerCase();
    if (tokens.length > 1 && (last() === "nullsfirst" || last() === "nullslast")) {
      nulls = last() === "nullsfirst" ? "first" : "last";
      tokens.pop();
    }
    if (tokens.length > 1 && (last() === "asc" || last() === "desc")) {
      dir = last() as "asc" | "desc";
      tokens.pop();
    }
    const expr = tokens.join(".");
    const related = /^([^()>-]+)\((.+)\)$/.exec(expr);
    if (related && /[()]/.test(related[2]!)) {
      throw parseError(`"failed to parse order (${input})"`, `unexpected '(' in "${expr}"`);
    }
    const base = related
      ? { relation: unquote(related[1]!), field: parseField(related[2]!) }
      : { field: parseField(expr) };
    return { ...base, dir, ...(nulls ? { nulls } : {}) };
  });

/** PostgREST ignores a `limit`/`offset` that is not an integer; a negative limit is refused later. */
export const parseCount = (name: "limit" | "offset", v: string): number | undefined => {
  const ok = name === "limit" ? /^-?\d+$/.test(v) : /^\d+$/.test(v);
  return ok ? Number(v) : undefined;
};

/**
 * The embedded resources a select names, by dotted path (`orders.items`). PostgREST 16 still accepts
 * the original table name of an aliased embed (`select=a:orders(*)&orders.id=eq.1`), so both spellings
 * map to the alias path.
 */
export const walkEmbeds = (items: ReadonlyArray<SelectItem>, prefix: string[], known: Map<string, string>): void => {
  for (const it of items) {
    if (it.kind !== "embed") continue;
    const name = it.alias ?? it.target;
    const canonical = [...prefix, name].join(".");
    known.set(canonical, canonical);
    if (it.alias) known.set([...prefix, it.target].join("."), canonical);
    walkEmbeds(it.items, [...prefix, name], known);
  }
};
