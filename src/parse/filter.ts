import { PgRestError } from "../errors";
import { type FieldRef, parseError, parseField, splitTopLevel, unquote } from "./field";
import { type SelectItem, parseSelect } from "./select";

export type Operator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "like"
  | "ilike"
  | "match"
  | "imatch"
  | "in"
  | "is"
  | "isdistinct"
  | "fts"
  | "plfts"
  | "phfts"
  | "wfts"
  | "cs"
  | "cd"
  | "ov"
  | "sl"
  | "sr"
  | "nxl"
  | "nxr"
  | "adj";

const OPERATORS: ReadonlySet<string> = new Set([
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "match",
  "imatch",
  "in",
  "is",
  "isdistinct",
  "fts",
  "plfts",
  "phfts",
  "wfts",
  "cs",
  "cd",
  "ov",
  "sl",
  "sr",
  "nxl",
  "nxr",
  "adj",
]);
const QUANTIFIABLE: ReadonlySet<string> = new Set(["eq", "gt", "gte", "lt", "lte", "like", "ilike", "match", "imatch"]);
const FTS: ReadonlySet<string> = new Set(["fts", "plfts", "phfts", "wfts"]);
const IS_VALUES: ReadonlySet<string> = new Set(["null", "not_null", "true", "false", "unknown"]);

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

const emptyParams = (): NodeParams => ({ filters: [], order: [], presence: [] });

export interface ParsedQuery {
  readonly select: SelectItem[];
  readonly root: NodeParams;
  /** Params for embedded resources, keyed by their dotted alias path (`orders.items`). */
  readonly embeds: Map<string, NodeParams>;
  readonly onConflict?: string[];
  readonly columns?: string[];
}

// ---------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------

const parseList = (raw: string, where: string): string[] => {
  const t = raw.trim();
  if (!t.startsWith("(") || !t.endsWith(")")) {
    throw parseError(`failed to parse filter (${where})`, "expected a list in parentheses, like (a,b,c)");
  }
  const inner = t.slice(1, -1);
  if (inner.trim() === "") return [];
  return splitTopLevel(inner, ",").map((v) => unquote(v));
};

/**
 * Parse `[not.]op[(modifier)].value`, the right-hand side of a filter.
 * `unquoteValue` is true inside and()/or() trees where values may be quoted.
 */
export const parseOperatorExpr = (field: FieldRef, expr: string, unquoteValue = false): Filter => {
  let rest = expr;
  let negate = false;
  if (rest.startsWith("not.")) {
    negate = true;
    rest = rest.slice(4);
  }
  const dot = rest.indexOf(".");
  if (dot < 0) throw parseError(`failed to parse filter (${expr})`);
  const opToken = rest.slice(0, dot);
  const rawValue = rest.slice(dot + 1);

  const m = /^([a-z]+)(?:\(([^)]*)\))?$/.exec(opToken);
  if (!m || !OPERATORS.has(m[1]!)) {
    throw parseError(`failed to parse filter (${expr})`, `unknown operator "${opToken}"`);
  }
  const op = m[1]! as Operator;
  const modifier = m[2];

  let quantifier: "any" | "all" | undefined;
  let lang: string | undefined;
  if (modifier !== undefined) {
    if (QUANTIFIABLE.has(op)) {
      if (modifier !== "any" && modifier !== "all") {
        throw parseError(`failed to parse filter (${expr})`, `"${modifier}" is not a valid quantifier, use any or all`);
      }
      quantifier = modifier;
    } else if (FTS.has(op)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(modifier)) {
        throw parseError(`failed to parse filter (${expr})`, `"${modifier}" is not a valid text search configuration`);
      }
      lang = modifier;
    } else {
      throw parseError(`failed to parse filter (${expr})`, `operator ${op} does not take a modifier`);
    }
  }

  let value: string | string[] = unquoteValue ? unquote(rawValue) : rawValue;
  if (op === "in") {
    value = parseList(rawValue, expr);
  } else if (op === "is") {
    const v = String(value).toLowerCase();
    if (!IS_VALUES.has(v)) {
      throw parseError(`failed to parse filter (${expr})`, "is only accepts null, not_null, true, false and unknown");
    }
    value = v;
  }

  return {
    kind: "filter",
    field,
    negate,
    op,
    ...(quantifier ? { quantifier } : {}),
    ...(lang ? { lang } : {}),
    value,
  };
};

const parseLogicItem = (raw: string): FilterNode => {
  const item = raw.trim();
  const m = /^(not\.)?(and|or)\(/.exec(item);
  if (m) {
    if (!item.endsWith(")")) throw parseError("Unbalanced parentheses in logic tree", `in "${item}"`);
    const inner = item.slice(m[0].length - 1); // keep "(...)"
    return parseLogic(m[2] as "and" | "or", Boolean(m[1]), inner);
  }
  const dot = item.indexOf(".");
  if (dot < 0) throw parseError(`failed to parse logic tree (${item})`);
  return parseOperatorExpr(parseField(item.slice(0, dot)), item.slice(dot + 1), true);
};

/** Parse `(a.eq.1,or(b.eq.2,c.eq.3))` into a {@link Logic} node. */
export const parseLogic = (op: "and" | "or", negate: boolean, value: string): Logic => {
  const v = value.trim();
  if (!v.startsWith("(") || !v.endsWith(")")) {
    throw parseError(`failed to parse logic tree (${value})`, "expected a list in parentheses");
  }
  const inner = v.slice(1, -1);
  if (inner.trim() === "") throw parseError(`failed to parse logic tree (${value})`, "empty tree");
  return { kind: "logic", op, negate, children: splitTopLevel(inner, ",").map(parseLogicItem) };
};

// ---------------------------------------------------------------------------
// order / pagination
// ---------------------------------------------------------------------------

export const parseOrder = (input: string): OrderTerm[] =>
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
const parseCount = (name: "limit" | "offset", v: string): number | undefined => {
  const ok = name === "limit" ? /^-?\d+$/.test(v) : /^\d+$/.test(v);
  return ok ? Number(v) : undefined;
};

// ---------------------------------------------------------------------------
// query string
// ---------------------------------------------------------------------------

const walkEmbeds = (items: ReadonlyArray<SelectItem>, prefix: string[], known: Map<string, string>) => {
  for (const it of items) {
    if (it.kind !== "embed") continue;
    const name = it.alias ?? it.target;
    const canonical = [...prefix, name].join(".");
    known.set(canonical, canonical);
    // PostgREST 16 still accepts the original table name for aliased embeds
    // (legacy target names), so `select=a:orders(*)&orders.id=eq.1` works.
    if (it.alias) known.set([...prefix, it.target].join("."), canonical);
    walkEmbeds(it.items, [...prefix, name], known);
  }
};

const RESERVED_TERMINALS = new Set(["limit", "offset", "order", "and", "or"]);

/** Parse everything PostgREST reads from the query string, except function arguments. */
export const parseQuery = (
  params: ReadonlyArray<readonly [string, string]>,
  opts: { readonly allowFilterKey?: (key: string) => boolean } = {},
): ParsedQuery => {
  let select: SelectItem[] = [{ kind: "star" }];
  let onConflict: string[] | undefined;
  let columns: string[] | undefined;
  for (const [k, v] of params) {
    if (k === "select") select = parseSelect(v);
    else if (k === "on_conflict") onConflict = splitTopLevel(v, ",").map(unquote).filter(Boolean);
    else if (k === "columns") columns = splitTopLevel(v, ",").map(unquote).filter(Boolean);
  }

  const known = new Map<string, string>();
  walkEmbeds(select, [], known);

  const root = emptyParams();
  const embeds = new Map<string, NodeParams>();
  const paramsFor = (path: string[], key: string): NodeParams => {
    if (path.length === 0) return root;
    const joined = path.join(".");
    const canonical = known.get(joined);
    if (!canonical) {
      throw new PgRestError(
        400,
        "PGRST108",
        `'${joined}' is not an embedded resource in this request`,
        null,
        `Verify that '${joined}' is included in the 'select' query parameter.`,
      );
    }
    let p = embeds.get(canonical);
    if (!p) {
      p = emptyParams();
      embeds.set(canonical, p);
    }
    void key;
    return p;
  };

  for (const [key, value] of params) {
    if (key === "select" || key === "on_conflict" || key === "columns") continue;
    if (opts.allowFilterKey && !opts.allowFilterKey(key)) continue;

    const parts = key.split(".");
    const last = parts[parts.length - 1]!;

    if (RESERVED_TERMINALS.has(last)) {
      let path = parts.slice(0, -1);
      if (last === "and" || last === "or") {
        const negate = path[path.length - 1] === "not";
        if (negate) path = path.slice(0, -1);
        paramsFor(path, key).filters.push(parseLogic(last, negate, value));
      } else if (last === "order") {
        paramsFor(path, key).order.push(...parseOrder(value));
      } else if (last === "limit") {
        const n = parseCount("limit", value);
        if (n !== undefined) paramsFor(path, key).limit = n;
      } else {
        const n = parseCount("offset", value);
        if (n !== undefined) paramsFor(path, key).offset = n;
      }
      continue;
    }

    // A filter on a column, or `embed=is.null` on an embedded resource itself.
    const embedPath = parts.join(".");
    if (known.has(embedPath)) {
      const m = /^(not\.)?is\.null$/.exec(value);
      if (!m) {
        throw new PgRestError(
          400,
          "PGRST120",
          "Embedded resource filter only accepts is.null or not.is.null",
          null,
          null,
        );
      }
      paramsFor(parts.slice(0, -1), key).presence.push({
        embed: known.get(embedPath)!.split(".").pop()!,
        present: Boolean(m[1]),
      });
      continue;
    }
    const path = parts.slice(0, -1);
    paramsFor(path, key).filters.push(parseOperatorExpr(parseField(last), value));
  }

  return {
    select,
    root,
    embeds,
    ...(onConflict ? { onConflict } : {}),
    ...(columns ? { columns } : {}),
  };
};
