/** Helpers for the lenient parts of PostgREST's filter syntax (the error wording lives in `grammar.ts`). */

export const IS_VALUES_ORDER = ["null", "not_null", "true", "false", "unknown"] as const;

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
