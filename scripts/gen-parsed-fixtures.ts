// Writes `packages/core/tests/parsed.fixtures.json`: the `ParsedQuery` each shared case must produce,
// and the query string that produces it.
//
// This is the only place that reads both published packages, and it is a tool rather than a test:
// the expectation is derived from `@tspg/rest`'s grammar, because PostgREST's behaviour is the
// specification (see AGENTS.md), and committed. `@tspg/rest` is then pinned against it and
// `@tspg/query` is held to it, so neither package's suite has to know the other exists.
//
// Like `tests/support/fixture.types.ts`, the output is generated, committed and reviewed: the tests
// catch drift, not the first mistake. Read the diff before committing a regeneration.
import { parseQuery } from "../packages/rest/src/parse/query-string";
import { toParsed } from "../packages/query/src/query";
import { toParams } from "../packages/query/tests/support/render";
import { inputs } from "../packages/query/tests/support/cases";
import { normalizeParsed } from "../packages/core/tests/support/parsed";

const out: Record<string, { qs: string; parsed: unknown }> = {};

for (const [name, input] of inputs) {
  if (name in out) throw new Error(`two cases are called ${JSON.stringify(name)}`);
  const params = toParams(input);
  const qs = new URLSearchParams(params as Array<[string, string]>).toString();

  // The fixture holds a string, so a string has to be all `@tspg/rest` needs: if the round trip
  // through URLSearchParams changed what its grammar reads, the case could not be shared.
  const fromParams = normalizeParsed(parseQuery(params));
  const fromString = normalizeParsed(parseQuery([...new URLSearchParams(qs)]));
  if (!Bun.deepEquals(fromParams, fromString, true)) {
    throw new Error(`${name}: "${qs}" does not parse to what its parameters do`);
  }

  // and the builder has to agree with the grammar, which is the whole point of the boundary
  if (!Bun.deepEquals(normalizeParsed(toParsed(input)), fromString, true)) {
    throw new Error(
      `${name}: the object and "${qs}" do not meet at the same ParsedQuery -- fix the builder or the grammar, do not regenerate over it`,
    );
  }
  out[name] = { qs, parsed: fromString };
}

const file = new URL("../packages/core/tests/parsed.fixtures.json", import.meta.url);
await Bun.write(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(`parsed.fixtures.json: ${Object.keys(out).length} cases`);
