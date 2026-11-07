import { safeType } from "../quote";
import { type FieldRef, parseError, parseField, scanTopLevel, splitTopLevel, unquote } from "./field";

export type AggregateFn = "count" | "sum" | "avg" | "max" | "min";
const AGGREGATES: ReadonlySet<string> = new Set(["count", "sum", "avg", "max", "min"]);

export interface StarItem {
  readonly kind: "star";
}

export interface FieldItem {
  readonly kind: "field";
  readonly field: FieldRef;
  readonly alias?: string;
  readonly cast?: string;
}

export interface AggregateItem {
  readonly kind: "aggregate";
  readonly fn: AggregateFn;
  /** `count()` has no column. */
  readonly field?: FieldRef;
  readonly alias?: string;
  readonly cast?: string;
}

export interface EmbedItem {
  readonly kind: "embed";
  readonly target: string;
  readonly alias?: string;
  readonly hint?: string;
  readonly join: "left" | "inner";
  readonly spread: boolean;
  readonly items: ReadonlyArray<SelectItem>;
}

export type SelectItem = StarItem | FieldItem | AggregateItem | EmbedItem;

/**
 * Output key of a field in the JSON result. A JSON path is named after its last key -- and when it
 * ends on an *index*, after the last key before it, so `data->1->mycol->>2` is `mycol` and `data->3`
 * is `data` (PostgREST's `lastJsonKey`, in `Plan.hs`).
 */
export const outputName = (item: FieldItem | AggregateItem): string => {
  if (item.alias) return item.alias;
  if (item.kind === "aggregate") return item.fn;
  const path = item.field.json;
  const last = path[path.length - 1];
  if (!last) return item.field.name;
  if (!last.isIndex) return last.key;
  return [...path].reverse().find((step) => !step.isIndex)?.key ?? item.field.name;
};

const parseItem = (raw: string): SelectItem => {
  let s = raw.trim();
  if (!s) throw parseError("Empty item in select", `in "${raw}"`);
  if (s === "*") return { kind: "star" };

  let spread = false;
  if (s.startsWith("...")) {
    spread = true;
    s = s.slice(3);
  }

  // trailing ::cast (last "::" at depth 0)
  let cast: string | undefined;
  let castAt = -1;
  scanTopLevel(s, (i, ch) => {
    if (ch === ":" && s[i + 1] === ":") {
      castAt = i;
    }
  });
  if (castAt >= 0) {
    cast = safeType(s.slice(castAt + 2));
    s = s.slice(0, castAt);
  }

  // alias: first lone ":" at depth 0
  let alias: string | undefined;
  let aliasAt = -1;
  scanTopLevel(s, (i, ch) => {
    if (ch === ":") {
      aliasAt = i;
      return true;
    }
    return false;
  });
  if (aliasAt >= 0) {
    alias = unquote(s.slice(0, aliasAt));
    s = s.slice(aliasAt + 1).trim();
    if (!alias) throw parseError("Empty alias in select", `in "${raw}"`);
  }

  const parenAt = firstParen(s);

  if (parenAt >= 0) {
    if (!s.endsWith(")")) throw parseError("Unbalanced parentheses in select", `in "${raw}"`);
    const head = s.slice(0, parenAt).trim();
    const inner = s.slice(parenAt + 1, -1);

    // aggregate: `count()`, `col.sum()`, `col->a.avg()`
    if (inner.trim() === "") {
      const dot = head.lastIndexOf(".");
      const fn = (dot >= 0 ? head.slice(dot + 1) : head).trim().toLowerCase();
      const colPart = dot >= 0 ? head.slice(0, dot) : "";
      // a bare `sum()` is not an aggregate: PostgREST reads it as an embedded resource named `sum`
      if (AGGREGATES.has(fn) && (colPart || fn === "count")) {
        if (spread) throw parseError("Cannot spread an aggregate", `in "${raw}"`);
        return {
          kind: "aggregate",
          fn: fn as AggregateFn,
          ...(colPart ? { field: parseField(colPart) } : {}),
          ...(alias ? { alias } : {}),
          ...(cast ? { cast } : {}),
        };
      }
    }

    if (cast) throw parseError("Cannot cast an embedded resource", `in "${raw}"`);
    const [targetRaw, ...mods] = splitTopLevel(head, "!");
    const target = unquote(targetRaw ?? "");
    if (!target) throw parseError("Empty embedded resource name", `in "${raw}"`);
    let join: "left" | "inner" = "left";
    let hint: string | undefined;
    for (const m of mods) {
      const mod = unquote(m);
      if (mod === "inner") join = "inner";
      else if (mod === "left") join = "left";
      else if (hint === undefined) hint = mod;
      else throw parseError("Only one hint is allowed per embedded resource", `in "${raw}"`);
    }
    return {
      kind: "embed",
      target,
      ...(alias ? { alias } : {}),
      ...(hint ? { hint } : {}),
      join,
      spread,
      items: inner.trim() === "" ? [] : parseSelect(inner),
    };
  }

  if (spread) throw parseError("Only embedded resources can be spread", `in "${raw}"`);
  return {
    kind: "field",
    field: parseField(s),
    ...(alias ? { alias } : {}),
    ...(cast ? { cast } : {}),
  };
};

const firstParen = (s: string): number => {
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === "\\") i++;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === "(") return i;
  }
  return -1;
};

/** Parse the value of the `select` query parameter. */
export const parseSelect = (input: string): SelectItem[] => {
  if (input.trim() === "") return [{ kind: "star" }];
  return splitTopLevel(input, ",").map(parseItem);
};
