import { EngineError } from "./errors";

/** Quote an SQL identifier: `a"b` → `"a""b"`. */
export const quoteIdent = (name: string): string => `"${cString(name).replace(/"/g, '""')}"`;

/**
 * What the database sees of a text: it ends at the first NUL byte, as a C string does -- that is where
 * PostgREST's driver cuts a name or a value, so that is where the library does. A NUL is never sent on.
 */
export const cString = (text: string): string => {
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
};

export const quoteQualified = (schema: string, name: string): string => `${quoteIdent(schema)}.${quoteIdent(name)}`;

/**
 * Escape a string as an SQL literal of *unknown* type, so Postgres infers the
 * type from context (`int_col = '5'` works). Mirrors `pg.escapeLiteral`.
 *
 * We inline literals (like PostgREST does) instead of binding parameters
 * because some drivers (Bun.sql) re-encode string parameters as JSON when the
 * inferred type is json/jsonb.
 */
export const literal = (text: string): string => {
  const value = cString(text);
  let out = `'${value.replace(/'/g, "''")}'`;
  if (out.includes("\\")) out = `E${out.replace(/\\/g, "\\\\")}`;
  return out;
};

const ID = "[A-Za-z_][A-Za-z0-9_]*";
const MOD = "(?:\\(\\s*\\d+(?:\\s*,\\s*\\d+)?\\s*\\))?";
const ARR = "(?:\\[\\])*";
// Types made of several words are matched against a fixed list, so that a cast
// can never smuggle SQL keywords (`::int4 from secrets`) into the query.
const MULTI_WORD =
  "double precision|character varying|national character varying|national character|bit varying|" +
  "timestamp(?:\\(\\d+\\))? with(?:out)? time zone|time(?:\\(\\d+\\))? with(?:out)? time zone";
const TYPE_RE = new RegExp(`^(?:(?:${MULTI_WORD})|${ID}(?:\\.${ID})?)${MOD}${ARR}$`, "i");

/** Validate a user-supplied cast target (`::type`) and return it verbatim. */
export const safeType = (type: string): string => {
  const t = type.trim();
  if (t.length > 100 || !TYPE_RE.test(t)) {
    throw new EngineError("invalid_input", "Invalid type in cast", `"${type}" is not an allowed cast target`);
  }
  return t;
};
