import { cString, literal } from "../quote";

/**
 * How a value from a filter gets into the SQL. `rest` writes it as a literal (`'paid'`), which is
 * what PostgREST's own statements look like in its logs and what `tests/compare` has always pinned.
 * `query` binds it (`$2`): the statement text then depends on the shape of the query and not on its
 * values, so the driver and the server reuse the prepared statement and its plan instead of parsing
 * a new text for every value -- and a value is never part of the SQL at all.
 */
export interface Values {
  /** The SQL for a value: a literal, or a placeholder for a parameter this sink hands to the driver. */
  readonly sql: (value: string) => string;
  /** The parameters the placeholders stand for, in order; the first is `$` (`taken` + 1). */
  readonly bound: string[];
}

/** Values are literals in the SQL. */
export const inlined: Values = { sql: literal, bound: [] };

/** Values are parameters, numbered after the `taken` the statement already has (its JSON body, say). */
export const bindFrom = (taken: number): Values => {
  const bound: string[] = [];
  return {
    bound,
    sql: (value) => {
      return `$${taken + bound.push(cString(value))}`;
    },
  };
};
