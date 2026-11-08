/**
 * PostgREST v16's query-string parsers (`PostgREST.ApiRequest.QueryParams`), ported on top of `parsec.ts`
 * so that syntax errors read exactly like PostgREST's. They only validate: the structures the rest of the
 * library works with come from the hand-written parsers in `@tsql/core/parse`.
 */
import {
  after,
  alt,
  anyChar,
  before,
  between,
  bind,
  char,
  digit,
  eof,
  guard,
  label,
  letter,
  lookAhead,
  many,
  many1,
  map,
  noneOf,
  notFollowedBy,
  oneOf,
  option,
  optionMaybe,
  type P,
  pure,
  run,
  sepBy,
  sepBy1,
  string,
  tryP,
  zero,
} from "./parsec";
import { EngineError } from "@tsql/core/errors";
import { FTS_ORDER, IS_VALUES_ORDER, QUANTIFIABLE_ORDER, SINGLE_VALUE_ORDER } from "@tsql/core/parse/syntax";

const ws = many(oneOf(" \t"));
const lexeme = <T>(p: P<T>): P<T> => before(after(ws, p), ws);
const lazy =
  <T>(f: () => P<T>): P<T> =>
  (s, i) =>
    f()(s, i);
const join = (xs: string[]) => xs.join("");

// ---------------------------------------------------------------------------
// names, quoting, json paths
// ---------------------------------------------------------------------------

const identifierChar = alt(letter, digit, oneOf("_ $"));
const identifier = map(many1(identifierChar), (cs) => join(cs).trim());
const dash = tryP(after(char("-"), notFollowedBy(char(">"))));
const sepByDash = (p: P<string>): P<string> => map(sepBy1(p, dash), (xs) => xs.join("-"));

const slashedOrPlain = alt(noneOf('\\"'), after(char("\\"), anyChar));
const quotedValue: P<string> = map(between(char('"'), char('"'), many(slashedOrPlain)), join);

const fieldName: P<string> = label(alt(quotedValue, sepByDash(identifier)), "field name (* or [a..z0..9_$])");
const jsonKeyName: P<string> = label(
  alt(quotedValue, sepByDash(map(many1(noneOf("(-:.,>)")), (cs) => join(cs).trim()))),
  "any non reserved character different from: .,>()",
);

const delimiter = label(char("."), "delimiter (.)");

const jsonEnd = alt(
  tryP(lookAhead(string("->"))),
  tryP(lookAhead(string("::"))),
  tryP(lookAhead(string("."))),
  tryP(lookAhead(string(","))),
  tryP(eof),
);
const jsonIdx = before(
  bind(option("+", char("-")), () => many1(digit)),
  jsonEnd,
);
const jsonOperation = after(alt(tryP(string("->>")), tryP(string("->"))), alt(tryP(jsonIdx), tryP(jsonKeyName)));
const jsonPath = many(jsonOperation);
const field = lexeme(bind(fieldName, () => option([] as unknown[], jsonPath)));

// ---------------------------------------------------------------------------
// select
// ---------------------------------------------------------------------------

const aliasSeparator = after(char(":"), notFollowedBy(char(":")));
const aliasPrefix = optionMaybe(tryP(before(fieldName, aliasSeparator)));

const embedParam = after(char("!"), alt(tryP(string("left")), tryP(string("inner")), tryP(fieldName)));
const embedParams = after(optionMaybe(embedParam), optionMaybe(embedParam));

const selectEnd = alt(tryP(lookAhead(string(")"))), tryP(lookAhead(string(","))), tryP(eof));

const aggregation = alt(string("sum"), string("avg"), string("count"), tryP(string("max")), tryP(string("min")), zero);

const relationSelect = lexeme(
  bind(aliasPrefix, () =>
    bind(fieldName, (name) => after(guard(name !== "count"), after(embedParams, tryP(lookAhead(string("(")))))),
  ),
);
const spreadRelationSelect = lexeme(
  after(string("..."), after(fieldName, after(embedParams, tryP(lookAhead(string("(")))))),
);

const fieldSelect = lexeme(
  alt(
    tryP(after(string("*"), selectEnd)),
    tryP(after(aliasPrefix, after(string("count()"), after(optionMaybe(after(string("::"), identifier)), selectEnd)))),
    after(
      aliasPrefix,
      after(
        field,
        after(
          optionMaybe(after(string("::"), identifier)),
          after(
            optionMaybe(tryP(before(after(char("."), aggregation), string("()")))),
            after(optionMaybe(after(string("::"), identifier)), selectEnd),
          ),
        ),
      ),
    ),
  ),
);

const forest: P<unknown[]> = sepBy(
  alt(
    bind(tryP(spreadRelationSelect), () =>
      between(
        char("("),
        char(")"),
        lazy(() => forest),
      ),
    ),
    bind(tryP(relationSelect), () =>
      between(
        char("("),
        char(")"),
        lazy(() => forest),
      ),
    ),
    fieldSelect,
  ),
  lexeme(char(",")),
);

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

const ciChar = (c: string): P<string> => alt(char(c), char(c.toUpperCase()));
const ciString = (w: string): P<string> => map(seq([...w].map(ciChar)), join);
const seq = <T>(ps: P<T>[]): P<T[]> =>
  ps.reduce<P<T[]>>((acc, p) => bind(acc, (xs) => map(p, (x) => [...xs, x])), pure([] as T[]));

const listElement = alt(tryP(before(quotedValue, notFollowedBy(noneOf(",)")))), map(many(noneOf(",)")), join));
const listVal = before(after(lexeme(char("(")), sepBy1(listElement, char(","))), lexeme(char(")")));

const isVal = label(alt(...IS_VALUES_ORDER.map((v) => tryP(ciString(v)))), `isVal: (${IS_VALUES_ORDER.join(", ")})`);

const simpleOperator = label(alt(...SINGLE_VALUE_ORDER.map((o) => tryP(string(o)))), "unknown single value operator");
const quantOperator = label(alt(...QUANTIFIABLE_ORDER.map((o) => tryP(string(o)))), "unknown single value operator");

const opExpr = (singleVal: P<unknown>): P<unknown> => {
  const pIn = after(tryP(after(string("in"), delimiter)), listVal);
  const pIs = after(tryP(after(string("is"), delimiter)), isVal);
  const pIsDist = after(tryP(after(string("isdistinct"), delimiter)), singleVal);
  const pSimple = bind(simpleOperator, () => after(delimiter, singleVal));
  const pQuant = bind(quantOperator, () =>
    after(
      optionMaybe(tryP(between(char("("), char(")"), alt(tryP(string("any")), string("all"))))),
      after(delimiter, singleVal),
    ),
  );
  const pFts = bind(alt(...FTS_ORDER.map((o) => tryP(string(o)))), () =>
    after(optionMaybe(tryP(between(char("("), char(")"), identifier))), after(delimiter, singleVal)),
  );
  const operation = label(alt(pIn, pIs, pIsDist, tryP(pFts), tryP(pSimple), tryP(pQuant)), "operator (eq, gt, ...)");
  return after(alt(tryP(after(string("not"), delimiter)), pure("")), operation);
};
const singleVal = map(many(anyChar), join);

// ---------------------------------------------------------------------------
// order
// ---------------------------------------------------------------------------

const orderEnd = alt(tryP(lookAhead(char(","))), tryP(eof));
const orderNulls = alt(tryP(after(delimiter, string("nullsfirst"))), tryP(after(delimiter, string("nullslast"))));
const orderDir = alt(tryP(after(delimiter, string("asc"))), tryP(after(delimiter, string("desc"))));
const orderTail = after(
  optionMaybe(orderDir),
  alt(before(optionMaybe(orderNulls), orderEnd), after(orderEnd, pure(undefined))),
);
const orderTerm = after(field, orderTail);
const orderRelationTerm = after(fieldName, after(between(char("("), char(")"), field), orderTail));
const order = sepBy1(lexeme(alt(tryP(orderRelationTerm), orderTerm)), char(","));

// ---------------------------------------------------------------------------
// logic trees (`and=(…)`, `or=(…)`)
// ---------------------------------------------------------------------------

const pgArray = map(
  bind(string("{"), (a) => bind(many(noneOf("{}")), (b) => map(string("}"), (c) => a + join(b) + c))),
  (x) => x,
);
const logicSingleVal = alt(
  tryP(before(quotedValue, notFollowedBy(noneOf(",)")))),
  tryP(pgArray),
  map(many(noneOf(",)")), join),
);
const logicNot = label(
  alt(tryP(after(string("not"), after(delimiter, pure(true)))), pure(false)),
  "negation operator (not)",
);
const logicOp = label(alt(tryP(string("and")), string("or")), "logic operator (and, or)");
const logicFilter = after(field, after(delimiter, opExpr(logicSingleVal)));
const logicTree: P<unknown> = alt(
  tryP(logicFilter),
  bind(logicNot, () =>
    bind(logicOp, () =>
      after(
        lexeme(char("(")),
        before(
          sepBy1(
            lazy(() => logicTree),
            lexeme(char(",")),
          ),
          lexeme(char(")")),
        ),
      ),
    ),
  ),
);

// ---------------------------------------------------------------------------
// entry points
// ---------------------------------------------------------------------------

const fail = (what: string, input: string, f: { column: number; details: string }) =>
  new EngineError("invalid_input", `"failed to parse ${what} (${input})" (line 1, column ${f.column})`, f.details);

/** `select=`: returns where the parse stopped (PostgREST ignores anything after it), or the error. */
export const checkSelect = (input: string): number | EngineError => {
  const r = run(forest, input);
  return r.ok ? r.end : fail("select parameter", input, r.failure);
};

/** The right-hand side of a filter (`not.eq.1`); `undefined` when it parses. */
export const checkFilter = (input: string): EngineError | undefined => {
  const r = run(opExpr(singleVal), input);
  return r.ok ? undefined : fail("filter", input, r.failure);
};

/** An `order=` value; `undefined` when it parses. */
export const checkOrder = (input: string): EngineError | undefined => {
  const r = run(order, input);
  return r.ok ? undefined : fail("order", input, r.failure);
};

/** `and=`/`or=`: `op` is `and`, `or`, `not.and` or `not.or`; returns how much of `value` the tree uses. */
export const checkLogicTree = (op: string, value: string): number | EngineError => {
  const r = run(logicTree, op + value);
  // PostgREST ignores what follows a complete tree
  return r.ok ? Math.max(0, r.end - op.length) : fail("logic tree", value, r.failure);
};
