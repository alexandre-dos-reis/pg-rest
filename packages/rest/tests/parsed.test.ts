import { describe, expect, test } from "bun:test";
import { parseQuery } from "../src/parse/query-string";
import { normalizeParsed, type ParsedCase } from "../../core/tests/support/parsed";
import fixtures from "../../core/tests/parsed.fixtures.json";

/**
 * The query string reaches `@tsql/core`'s `ParsedQuery`, and this is what it has to reach: the cases
 * committed in `parsed.fixtures.json`, which `@tsql/query` is held to from the object side. Both
 * meeting the same expectation is what makes them answer the same thing, so neither suite has to
 * run the other package.
 *
 * The file is generated from this grammar (`bun run gen:parsed`), PostgREST's behaviour being the
 * specification, so what fails here is a *change* to what a query string means. That is either a
 * parity bug or a deliberate change to be regenerated and reviewed -- never regenerated blindly.
 */
describe("query string -> ParsedQuery", () => {
  for (const [name, { qs, parsed }] of Object.entries(fixtures as Record<string, ParsedCase>)) {
    test(name, () => {
      expect(normalizeParsed(parseQuery([...new URLSearchParams(qs)]))).toEqual(parsed);
    });
  }
});
