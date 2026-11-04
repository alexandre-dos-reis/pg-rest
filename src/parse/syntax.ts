/**
 * Syntax errors worded like PostgREST's (Parsec) ones: `unexpected "f" expecting "not" or operator (eq, gt, ...)`
 * plus the `(line 1, column N)` position. The grammars here are hand-written checkers that mirror what the
 * Haskell parsers accept and where they stop; they were fitted against the real thing (see tests/compare).
 */
import { PgRestError } from "../errors";

interface SyntaxFailure {
  /** 0-based offset of the failure. */
  readonly pos: number;
  /** The offending character, or `undefined` at the end of the input. */
  readonly found: string | undefined;
  /** How the offending character is shown: `"x"` (a token) or `'x'` (end-of-input check). */
  readonly quote?: "double" | "single";
  readonly expecting: ReadonlyArray<string>;
}

/** Haskell `show` for a one-character string. */
const showChar = (c: string): string => {
  if (c === '"') return '"\\""';
  if (c === "\\") return '"\\\\"';
  if (c === "\n") return '"\\n"';
  if (c === "\t") return '"\\t"';
  const code = c.codePointAt(0)!;
  return code > 126 || code < 32 ? `"\\${code}"` : `"${c}"`;
};

const listWords = (xs: ReadonlyArray<string>): string => {
  const u = [...new Set(xs)];
  if (u.length <= 1) return u.join("");
  return `${u.slice(0, -1).join(", ")} or ${u[u.length - 1]}`;
};

export const syntaxError = (what: string, input: string, f: SyntaxFailure): PgRestError => {
  const unexpected =
    f.found === undefined
      ? "unexpected end of input"
      : `unexpected ${f.quote === "single" ? `'${f.found}'` : showChar(f.found)}`;
  const details = f.expecting.length ? `${unexpected} expecting ${listWords(f.expecting)}` : unexpected;
  return new PgRestError(
    400,
    "PGRST100",
    `"failed to parse ${what} (${input})" (line 1, column ${f.pos + 1})`,
    details,
  );
};

const at = (s: string, i: number): string | undefined => (i < s.length ? s[i] : undefined);

/** First index where `s` (from `from`) stops matching `word`; `word.length` if it matches entirely. */
const matchLen = (s: string, from: number, word: string): number => {
  let k = 0;
  while (k < word.length && s[from + k] === word[k]) k++;
  return k;
};

// ---------------------------------------------------------------------------
// filters: `[not.]op[(modifier)].value`
// ---------------------------------------------------------------------------

const OP_ORDER = [
  "eq",
  "gte",
  "gt",
  "lte",
  "lt",
  "neq",
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
] as const;
const QUANT_OPS: ReadonlySet<string> = new Set(["eq", "gt", "gte", "lt", "lte", "like", "ilike", "match", "imatch"]);
const FTS_OPS: ReadonlySet<string> = new Set(["fts", "plfts", "phfts", "wfts"]);
const OPERATOR = "operator (eq, gt, ...)";
const DELIMITER = "delimiter (.)";
const IS_LABEL = "isVal: (null, not_null, true, false, unknown)";
export const IS_VALUES_ORDER = ["null", "not_null", "true", "false", "unknown"] as const;

export interface FilterSyntax {
  readonly op: string;
  readonly negate: boolean;
  readonly quantifier?: string;
  readonly lang?: string;
  /** Offset of the value (just after the delimiter). */
  readonly valueAt: number;
}

/** Parse the operator part of a filter. */
const operatorHead = (s: string, from: number): FilterSyntax | SyntaxFailure => {
  let deepest: SyntaxFailure | undefined;
  const fail = (pos: number, found: string | undefined) => {
    if (!deepest || pos > deepest.pos) deepest = { pos, found, expecting: [OPERATOR] };
  };
  for (const op of OP_ORDER) {
    const n = matchLen(s, from, op);
    if (n < op.length) continue;
    let j = from + op.length;
    let quantifier: string | undefined;
    let lang: string | undefined;
    if (at(s, j) === "(" && (QUANT_OPS.has(op) || FTS_OPS.has(op))) {
      if (QUANT_OPS.has(op)) {
        const word = ["any", "all"].find((w) => matchLen(s, j + 1, w) === w.length);
        if (!word) {
          const k = matchLen(s, j + 1, "any");
          fail(j + 1, at(s, j + 1 + k));
          continue;
        }
        if (at(s, j + 1 + word.length) !== ")") {
          fail(j + 1 + word.length, at(s, j + 1 + word.length));
          continue;
        }
        quantifier = word;
        j += word.length + 2;
      } else {
        let k = j + 1;
        while (k < s.length && s[k] !== ")") k++;
        if (k === j + 1 || k >= s.length) {
          fail(k, at(s, k));
          continue;
        }
        lang = s.slice(j + 1, k);
        j = k + 1;
      }
    }
    if (at(s, j) !== ".") {
      fail(j, at(s, j));
      continue;
    }
    return { op, negate: false, ...(quantifier ? { quantifier } : {}), ...(lang ? { lang } : {}), valueAt: j + 1 };
  }
  if (!deepest) {
    // no operator name matched: the first alternative (`eq`) reports where it differs
    const k = matchLen(s, from, "eq");
    return { pos: from, found: at(s, from + k), expecting: [OPERATOR] };
  }
  return deepest;
};

/** Where a parenthesised `in` list ends (offset after the `)`), or the failure. */
export const scanList = (s: string, from: number): number | SyntaxFailure => {
  if (at(s, from) !== "(") return { pos: from, found: at(s, from), expecting: ['"("'] };
  let i = from + 1;
  let first = true;
  for (;;) {
    // item: quoted (`"…"` with backslash escapes) when it closes properly, otherwise raw text
    let end = i;
    if (at(s, i) === '"') {
      let k = i + 1;
      while (k < s.length && s[k] !== '"') k += s[k] === "\\" ? 2 : 1;
      if (k < s.length && (at(s, k + 1) === "," || at(s, k + 1) === ")")) end = k + 1;
    }
    if (end === i) while (end < s.length && s[end] !== "," && s[end] !== ")") end++;
    const c = at(s, end);
    if (c === ")") return end + 1;
    if (c === ",") {
      i = end + 1;
      first = false;
      continue;
    }
    return {
      pos: end,
      found: undefined,
      expecting: first && end === i ? ['"\\""', '","', '")"'] : ['","', '")"'],
    };
  }
};

/** `undefined` when `expr` (the part after `col=`) parses; otherwise PostgREST's error. */
export const filterSyntax = (expr: string): FilterSyntax | PgRestError => {
  const wrap = (f: SyntaxFailure) => syntaxError("filter", expr, f);
  let negate = false;
  let from = 0;
  let notFailure: SyntaxFailure | undefined;
  if (matchLen(expr, 0, "not") === 3) {
    if (at(expr, 3) === ".") {
      negate = true;
      from = 4;
    } else {
      notFailure = { pos: 3, found: at(expr, 3), expecting: [DELIMITER] };
    }
  }
  const head = operatorHead(expr, from);
  if (!("valueAt" in head)) {
    if (notFailure && notFailure.pos >= head.pos) return wrap(notFailure);
    // at the very start both the `not` alternative and the operator alternative failed
    const expecting = from === 0 && !notFailure && head.pos === 0 ? ['"not"', ...head.expecting] : head.expecting;
    return wrap({ ...head, expecting });
  }
  if (head.op === "is") {
    const p = head.valueAt;
    if (!IS_VALUES_ORDER.some((w) => matchLen(expr, p, w) === w.length)) {
      const k = matchLen(expr, p, "null");
      return wrap({ pos: p, found: at(expr, p + k), expecting: [IS_LABEL] });
    }
  } else if (head.op === "in") {
    const r = scanList(expr, head.valueAt);
    if (typeof r !== "number") return wrap(r);
  }
  return { ...head, negate };
};

// ---------------------------------------------------------------------------
// order: `field[.asc|.desc][.nullsfirst|.nullslast],…`
// ---------------------------------------------------------------------------

const FIELD_LABEL = "field name (* or [a..z0..9_$])";
const DIRECTIONS = ["asc", "desc"] as const;
const NULLS = ["nullsfirst", "nullslast"] as const;
const quoted = (xs: ReadonlyArray<string>) => xs.map((x) => `"${x}"`);

const firstMismatch = (s: string, from: number, words: ReadonlyArray<string>): SyntaxFailure => {
  const k = matchLen(s, from, words[0]!);
  return { pos: from, found: at(s, from + k), expecting: quoted(words) };
};

/** `undefined` when the `order` value parses; otherwise PostgREST's error. */
export const orderSyntax = (input: string): PgRestError | undefined => {
  const wrap = (f: SyntaxFailure) => syntaxError("order", input, f);
  let i = 0;
  for (;;) {
    // field: up to the next top-level `.` or `,` (quotes and parentheses protect their content)
    const start = i;
    let depth = 0;
    let inQuote = false;
    while (i < input.length) {
      const c = input[i]!;
      if (c === '"') inQuote = !inQuote;
      else if (!inQuote) {
        if (c === "(") depth++;
        else if (c === ")") depth = Math.max(0, depth - 1);
        else if (depth === 0 && (c === "." || c === ",")) break;
      }
      i++;
    }
    if (i === start) return wrap({ pos: start, found: at(input, start), expecting: [FIELD_LABEL] });
    if (at(input, i) === ".") {
      const r = i + 1;
      const word = [...DIRECTIONS, ...NULLS].find((w) => matchLen(input, r, w) === w.length);
      if (!word) return wrap(firstMismatch(input, r, [...DIRECTIONS, ...NULLS]));
      i = r + word.length;
      if ((DIRECTIONS as ReadonlyArray<string>).includes(word) && at(input, i) === ".") {
        const n = r + word.length + 1;
        const nulls = NULLS.find((w) => matchLen(input, n, w) === w.length);
        if (!nulls) return wrap(firstMismatch(input, n, NULLS));
        i = n + nulls.length;
      }
    }
    if (i >= input.length) return undefined;
    if (input[i] !== ",") return wrap({ pos: i, found: input[i], quote: "single", expecting: ['","', "end of input"] });
    i++;
  }
};
