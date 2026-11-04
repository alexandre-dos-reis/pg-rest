/**
 * A tiny port of Haskell's Parsec (the semantics of consumed/empty results, `try`, `<|>`, labels and error
 * merging), just enough to run PostgREST's parsers and produce the same error messages.
 */

/** Message kinds, in Parsec's sort order. */
const SYS_UNEXPECT = 0;
const UNEXPECT = 1;
const EXPECT = 2;
const MESSAGE = 3;

interface Msg {
  readonly k: number;
  readonly s: string;
}
export interface PErr {
  /** Offset in the input. */
  readonly pos: number;
  readonly msgs: ReadonlyArray<Msg>;
}
type Reply<T> =
  | { readonly ok: true; readonly consumed: boolean; readonly v: T; readonly i: number; readonly err: PErr }
  | { readonly ok: false; readonly consumed: boolean; readonly err: PErr };
export type P<T> = (s: string, i: number) => Reply<T>;

const unknown = (pos: number): PErr => ({ pos, msgs: [] });
const mergeError = (e1: PErr, e2: PErr): PErr => {
  if (e2.msgs.length === 0 && e1.msgs.length > 0) return e1;
  if (e1.msgs.length === 0 && e2.msgs.length > 0) return e2;
  if (e1.pos === e2.pos) return { pos: e1.pos, msgs: [...e1.msgs, ...e2.msgs] };
  return e1.pos > e2.pos ? e1 : e2;
};
const setExpect = (e: PErr, label: string): PErr => ({
  pos: e.pos,
  msgs: [...e.msgs.filter((m) => m.k !== EXPECT), ...(label ? [{ k: EXPECT, s: label }] : [])],
});

const showChar = (c: string): string => `'${c}'`;
/** Haskell `show` of a one-character string. */
const showStr1 = (c: string): string => {
  if (c === '"') return '"\\""';
  if (c === "\\") return '"\\\\"';
  if (c === "\n") return '"\\n"';
  if (c === "\t") return '"\\t"';
  const code = c.codePointAt(0)!;
  return code > 126 || code < 32 ? `"\\${code}"` : `"${c}"`;
};
const showStr = (s: string): string =>
  s.length === 1 ? showStr1(s) : `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

// ---------------------------------------------------------------------------
// primitives
// ---------------------------------------------------------------------------

export const pure =
  <T>(v: T): P<T> =>
  (_s, i) => ({ ok: true, consumed: false, v, i, err: unknown(i) });
export const zero: P<never> = (_s, i) => ({ ok: false, consumed: false, err: unknown(i) });
export const unexpected =
  (msg: string): P<never> =>
  (_s, i) => ({ ok: false, consumed: false, err: { pos: i, msgs: [{ k: UNEXPECT, s: msg }] } });

const codePointAt = (s: string, i: number): string | undefined => {
  if (i >= s.length) return undefined;
  const cp = s.codePointAt(i)!;
  return String.fromCodePoint(cp);
};

/** Consume one character satisfying `f`. */
export const satisfy =
  (f: (c: string) => boolean): P<string> =>
  (s, i) => {
    const c = codePointAt(s, i);
    if (c === undefined) return { ok: false, consumed: false, err: { pos: i, msgs: [{ k: SYS_UNEXPECT, s: "" }] } };
    if (!f(c)) return { ok: false, consumed: false, err: { pos: i, msgs: [{ k: SYS_UNEXPECT, s: showStr1(c) }] } };
    const j = i + c.length;
    return { ok: true, consumed: true, v: c, i: j, err: unknown(j) };
  };

export const label =
  <T>(p: P<T>, name: string): P<T> =>
  (s, i) => {
    const r = p(s, i);
    if (r.consumed) return r;
    if (r.ok) return { ...r, err: r.err.msgs.length === 0 ? r.err : setExpect(r.err, name) };
    return { ...r, err: setExpect(r.err, name) };
  };

export const char = (c: string): P<string> =>
  label(
    satisfy((x) => x === c),
    showStr1(c),
  );
export const oneOf = (cs: string): P<string> => satisfy((x) => cs.includes(x));
export const noneOf = (cs: string): P<string> => satisfy((x) => !cs.includes(x));
export const anyChar: P<string> = satisfy(() => true);
export const letter: P<string> = label(
  satisfy((c) => /\p{L}/u.test(c)),
  "letter",
);
export const digit: P<string> = label(
  satisfy((c) => c >= "0" && c <= "9"),
  "digit",
);

/** Parsec's `string`: fails after consuming when only a prefix matches (wrap in `tryP` to backtrack). */
export const string =
  (w: string): P<string> =>
  (s, i) => {
    const expect: Msg = { k: EXPECT, s: showStr(w) };
    for (let k = 0; k < w.length; k++) {
      const c = codePointAt(s, i + k);
      if (c === undefined) {
        const err: PErr = { pos: i, msgs: [{ k: SYS_UNEXPECT, s: "" }, expect] };
        return { ok: false, consumed: k > 0, err };
      }
      if (c !== w[k]) {
        const err: PErr = { pos: i, msgs: [{ k: SYS_UNEXPECT, s: showStr1(c) }, expect] };
        return { ok: false, consumed: k > 0, err };
      }
    }
    const j = i + w.length;
    return { ok: true, consumed: w.length > 0, v: w, i: j, err: unknown(j) };
  };

// ---------------------------------------------------------------------------
// combinators
// ---------------------------------------------------------------------------

export const tryP =
  <T>(p: P<T>): P<T> =>
  (s, i) => {
    const r = p(s, i);
    return !r.ok && r.consumed ? { ok: false, consumed: false, err: r.err } : r;
  };

export const bind =
  <A, B>(p: P<A>, f: (a: A) => P<B>): P<B> =>
  (s, i) => {
    const r = p(s, i);
    if (!r.ok) return r;
    const q = f(r.v)(s, r.i);
    if (r.consumed) {
      if (q.consumed) return q;
      return q.ok
        ? { ...q, consumed: true, err: mergeError(r.err, q.err) }
        : { ok: false, consumed: true, err: mergeError(r.err, q.err) };
    }
    if (q.consumed) return q;
    return q.ok
      ? { ...q, err: mergeError(r.err, q.err) }
      : { ok: false, consumed: false, err: mergeError(r.err, q.err) };
  };

export const map = <A, B>(p: P<A>, f: (a: A) => B): P<B> => bind(p, (a) => pure(f(a)));
/** `p <* q` */
export const before = <A, B>(p: P<A>, q: P<B>): P<A> => bind(p, (a) => map(q, () => a));
/** `p *> q` */
export const after = <A, B>(p: P<A>, q: P<B>): P<B> => bind(p, () => q);

// Alternatives may have different result types here (we only care about success and errors).
// oxlint-disable-next-line typescript/no-explicit-any
export const alt =
  <T = any>(...ps: P<any>[]): P<T> =>
  (s, i) => {
    let acc: PErr | undefined;
    for (const p of ps) {
      const r = p(s, i);
      if (r.consumed) return r;
      if (r.ok) return acc ? { ...r, err: mergeError(acc, r.err) } : r;
      acc = acc ? mergeError(acc, r.err) : r.err;
    }
    return { ok: false, consumed: false, err: acc ?? unknown(i) };
  };

export const many =
  <T>(p: P<T>): P<T[]> =>
  (s, i) => {
    const out: T[] = [];
    let consumed = false;
    let pos = i;
    for (;;) {
      const r = p(s, pos);
      if (!r.ok) {
        if (r.consumed) return r;
        return { ok: true, consumed, v: out, i: pos, err: r.err };
      }
      if (!r.consumed) throw new Error("combinator 'many' is applied to a parser that accepts an empty string");
      out.push(r.v);
      consumed = true;
      pos = r.i;
    }
  };
export const many1 = <T>(p: P<T>): P<T[]> => bind(p, (x) => map(many(p), (xs) => [x, ...xs]));
export const sepBy1 = <T, S>(p: P<T>, sep: P<S>): P<T[]> =>
  bind(p, (x) => map(many(after(sep, p)), (xs) => [x, ...xs]));
export const sepBy = <T, S>(p: P<T>, sep: P<S>): P<T[]> => alt(sepBy1(p, sep), pure([] as T[]));
export const option = <T>(d: T, p: P<T>): P<T> => alt(p, pure(d));
export const optionMaybe = <T>(p: P<T>): P<T | undefined> => option<T | undefined>(undefined, p);
export const between = <T>(open: P<unknown>, close: P<unknown>, p: P<T>): P<T> => after(open, before(p, close));

export const lookAhead =
  <T>(p: P<T>): P<T> =>
  (s, i) => {
    const r = p(s, i);
    if (!r.ok) return r;
    return { ok: true, consumed: false, v: r.v, i, err: unknown(i) };
  };

export const notFollowedBy = <T>(p: P<T>): P<void> =>
  tryP(
    alt(
      bind(tryP(p), (c) => unexpected(typeof c === "string" && c.length === 1 ? showChar(c) : showStr(String(c)))),
      pure(undefined as void),
    ),
  );

/** `eof` does not move the error position past the offending character (Parsec's `anyToken` keeps the position). */
export const eof: P<void> = label((s, i) => {
  const c = codePointAt(s, i);
  if (c === undefined) return { ok: true, consumed: false, v: undefined, i, err: unknown(i) };
  return { ok: false, consumed: false, err: { pos: i, msgs: [{ k: UNEXPECT, s: showChar(c) }] } };
}, "end of input");
export const guard = (ok: boolean): P<void> => (ok ? pure(undefined) : zero);

// ---------------------------------------------------------------------------
// running and reporting
// ---------------------------------------------------------------------------

const columnAt = (s: string, offset: number): number => {
  let col = 1;
  for (let k = 0; k < offset; k++) {
    col = s[k] === "\t" ? col + 8 - ((col - 1) % 8) : col + 1;
  }
  return col;
};

const clean = (xs: string[]): string[] => [...new Set(xs.filter((x) => x !== ""))];
const commasOr = (xs: string[]): string =>
  xs.length === 0 ? "" : xs.length === 1 ? xs[0]! : `${xs.slice(0, -1).join(", ")} or ${xs[xs.length - 1]}`;

/** Parsec's `showErrorMessages "or" "unknown parse error" "expecting" "unexpected" "end of input"`. */
export const showMessages = (msgs: ReadonlyArray<Msg>): string => {
  if (msgs.length === 0) return "unknown parse error";
  const sorted = [...msgs].sort((a, b) => a.k - b.k); // stable
  const sys = sorted.filter((m) => m.k === SYS_UNEXPECT);
  const unex = sorted.filter((m) => m.k === UNEXPECT);
  const expect = sorted.filter((m) => m.k === EXPECT);
  const other = sorted.filter((m) => m.k === MESSAGE);
  const showMany = (pre: string, ms: Msg[]) => {
    const c = commasOr(clean(ms.map((m) => m.s)));
    return c === "" ? "" : pre ? `${pre} ${c}` : c;
  };
  const sysShown =
    unex.length > 0 || sys.length === 0 ? "" : sys[0]!.s === "" ? "unexpected end of input" : `unexpected ${sys[0]!.s}`;
  return clean([sysShown, showMany("unexpected", unex), showMany("expecting", expect), showMany("", other)]).join(" ");
};

export interface ParseFailure {
  /** 1-based column (the input is a single line). */
  readonly column: number;
  readonly details: string;
}

/** Run `p` at the start of `input` (no `eof` is implied, as in Parsec's `parse`). */
export const run = <T>(
  p: P<T>,
  input: string,
): { ok: true; value: T; end: number } | { ok: false; failure: ParseFailure } => {
  const r = p(input, 0);
  if (r.ok) return { ok: true, value: r.v, end: r.i };
  return { ok: false, failure: { column: columnAt(input, r.err.pos), details: showMessages(r.err.msgs).trim() } };
};
