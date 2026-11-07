/** Helpers for the lenient parts of PostgREST's filter syntax (the error wording lives in `grammar.ts`). */

export const IS_VALUES_ORDER = ["null", "not_null", "true", "false", "unknown"] as const;

/**
 * The filter operators, by the syntax each one takes. This is the **only** place the vocabulary is
 * written down: the `Operator` type, the sets `parse/filter.ts` tests membership against, the
 * parser's alternations in `grammar.ts` and `query.ts`'s public `FilterOp` all come from here.
 *
 * The order inside each group is the order the parser tries them in, so a longer operator comes
 * before a prefix of itself (`gte` before `gt`): leave it alone.
 */
export const QUANTIFIABLE_ORDER = ["eq", "gte", "gt", "lte", "lt", "like", "ilike", "match", "imatch"] as const;

/** Full-text search, each with an optional `(config)`. */
export const FTS_ORDER = ["fts", "plfts", "phfts", "wfts"] as const;

/** One value, no modifier. */
export const SINGLE_VALUE_ORDER = ["neq", "cs", "cd", "ov", "sl", "sr", "nxr", "nxl", "adj"] as const;

/** The three with a value syntax of their own: a list, an `IS` value, and a plain value. */
export const SPECIAL_VALUE_ORDER = ["in", "is", "isdistinct"] as const;

/** Every operator there is. */
export const OPERATORS_ORDER = [
  ...QUANTIFIABLE_ORDER,
  ...FTS_ORDER,
  ...SINGLE_VALUE_ORDER,
  ...SPECIAL_VALUE_ORDER,
] as const;

const at = (s: string, i: number): string | undefined => (i < s.length ? s[i] : undefined);

/**
 * Where a parenthesised `in` list ends (offset after the closing `)`). PostgREST stops there and ignores what follows;
 * an unterminated list returns the input length (the grammar reports the error before this is used).
 */
export const scanList = (s: string, from: number): number => {
  let i = from + 1;
  for (;;) {
    let end = i;
    if (at(s, i) === '"') {
      let k = i + 1;
      while (k < s.length && s[k] !== '"') k += s[k] === "\\" ? 2 : 1;
      if (k < s.length && (at(s, k + 1) === "," || at(s, k + 1) === ")")) end = k + 1;
    }
    if (end === i) while (end < s.length && s[end] !== "," && s[end] !== ")") end++;
    const c = at(s, end);
    if (c === ")") return end + 1;
    if (c !== ",") return s.length;
    i = end + 1;
  }
};
