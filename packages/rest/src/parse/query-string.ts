import { EngineError } from "@tspg/core/errors";
import { type FieldRef, parseError, parseField, splitTopLevel, unquote } from "@tspg/core/parse/field";
import {
  type Filter,
  type FilterNode,
  type Logic,
  type NodeParams,
  type Operator,
  type OrderTerm,
  type ParsedQuery,
  emptyParams,
  parseCount,
  parseOrderTerms,
  walkEmbeds,
} from "@tspg/core/parse/filter";
import { type SelectItem, parseSelect } from "@tspg/core/parse/select";
import { FTS_ORDER, IS_VALUES_ORDER, OPERATORS_ORDER, QUANTIFIABLE_ORDER, scanList } from "@tspg/core/parse/syntax";
import { checkFieldList, checkFilter, checkLogicTree, checkOrder, checkSelect, checkTreePath } from "./grammar";

// What PostgREST reads from a query string, parsed with the grammars of `grammar.ts`. The result is
// the engine's own `ParsedQuery`; `@tspg/query` builds the same thing from an object and never comes here.

const OPERATORS: ReadonlySet<string> = new Set(OPERATORS_ORDER);
const QUANTIFIABLE: ReadonlySet<string> = new Set(QUANTIFIABLE_ORDER);
const FTS: ReadonlySet<string> = new Set(FTS_ORDER);
const IS_VALUES: ReadonlySet<string> = new Set(IS_VALUES_ORDER);

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
  if (!unquoteValue) {
    const bad = checkFilter(expr);
    if (bad) throw bad;
  }
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
      if (!/^[\p{L}\p{N}_ $]+$/u.test(modifier)) {
        throw parseError(`failed to parse filter (${expr})`, `"${modifier}" is not a valid text search configuration`);
      }
      lang = modifier;
    } else {
      throw parseError(`failed to parse filter (${expr})`, `operator ${op} does not take a modifier`);
    }
  }

  let value: string | string[] = unquoteValue ? unquote(rawValue) : rawValue;
  if (op === "in") {
    // PostgREST stops at the closing parenthesis and ignores what follows.
    const end = unquoteValue ? undefined : scanList(rawValue, 0);
    value = parseList(typeof end === "number" ? rawValue.slice(0, end) : rawValue, expr);
  } else if (op === "is") {
    const prefix = unquoteValue ? undefined : IS_VALUES_ORDER.find((w) => rawValue.startsWith(w));
    const v = (prefix ?? String(value)).toLowerCase();
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
  return { kind: "logic", op, negate, children: splitTopLevel(inner, ",", true).map(parseLogicItem) };
};

export const parseOrder = (input: string): OrderTerm[] => {
  const bad = checkOrder(input);
  if (bad) throw bad;
  return parseOrderTerms(input);
};

// ---------------------------------------------------------------------------
// query string
// ---------------------------------------------------------------------------

const RESERVED_TERMINALS = new Set(["limit", "offset", "order", "and", "or"]);

/** The name a key stands for: what PostgREST's grammar reads of it, or the error when it reads nothing. */
const nameOfKey = (key: string): string => {
  const end = checkTreePath(key);
  if (end instanceof EngineError) throw end;
  return key.slice(0, end);
};

/**
 * Function arguments are read from the query string too: their names go through the grammar of a
 * filter's key, like PostgREST's, before they are looked for.
 */
export const keysChecked = (params: ReadonlyArray<readonly [string, string]>): Array<readonly [string, string]> =>
  params.map(([key, value]) =>
    key === "select" ||
    key === "on_conflict" ||
    key === "columns" ||
    RESERVED_TERMINALS.has(key.slice(key.lastIndexOf(".") + 1))
      ? ([key, value] as const)
      : ([nameOfKey(key), value] as const),
  );

/** Parse everything PostgREST reads from the query string, except function arguments. */
export const parseQuery = (
  params: ReadonlyArray<readonly [string, string]>,
  opts: { readonly allowFilterKey?: ((key: string) => boolean) | undefined } = {},
): ParsedQuery => {
  let select: SelectItem[] = [{ kind: "star" }];
  let onConflict: string[] | undefined;
  let columns: string[] | undefined;
  for (const [k, v] of params) {
    if (k === "select") {
      // PostgREST's parser stops at the first thing it cannot continue with and ignores the rest.
      const end = checkSelect(v);
      if (end instanceof EngineError) throw end;
      let used = v.slice(0, end).trim();
      // a number ends a JSON path only before `,`, `.`, `->`, `::` or the end: before anything else it is a key
      if (end < v.length && !/^(,|\.|->|::)/.test(v.slice(end))) used = used.replace(/(->>?)(-?\d+)$/, '$1"$2"');
      select = used === "" ? [{ kind: "star" }] : parseSelect(used);
    } else if (k === "on_conflict" || k === "columns") {
      // the names end up in the statement: they are read with PostgREST's grammar, which ignores what follows
      const end = v === "" ? 0 : checkFieldList(k, v);
      if (end instanceof EngineError) throw end;
      const names = splitTopLevel(v === "" ? v : v.slice(0, end), ",")
        .map(unquote)
        .filter(Boolean);
      if (k === "on_conflict") onConflict = names;
      else columns = names;
    }
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
      throw new EngineError(
        "not_embedded",
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

    const reserved = RESERVED_TERMINALS.has(key.slice(key.lastIndexOf(".") + 1));
    const parts = (reserved ? key : nameOfKey(key)).split(".");
    const last = parts[parts.length - 1]!;

    if (RESERVED_TERMINALS.has(last)) {
      let path = parts.slice(0, -1);
      if (last === "and" || last === "or") {
        const negate = path[path.length - 1] === "not";
        if (negate) path = path.slice(0, -1);
        const used = checkLogicTree(negate ? `not.${last}` : last, value);
        if (used instanceof EngineError) throw used;
        paramsFor(path, key).filters.push(parseLogic(last, negate, value.slice(0, used)));
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
        throw new EngineError(
          "invalid_embed_filter",
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
