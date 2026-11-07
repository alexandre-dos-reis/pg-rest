import { afterAll, describe, expect, test } from "bun:test";
import { virtualProject } from "./support/tsapi";

/**
 * What an editor offers inside a typed query, asked of the TypeScript compiler itself.
 *
 * This is not a detail of taste: TypeScript only narrows the contextual type of a nested property
 * (the items of `select`, the keys of `where`) when the discriminant picks **exactly one** member of
 * the union. Two things are needed for that, and both are easy to undo by accident --
 * `src/typed.ts` must keep one member per table (reads and writes merged, their payloads enforced
 * by `WriteRules`) and every member must *declare* `table`, the function calls included (`table?:
 * never`). Without them the editor proposes every table's columns, which is what this pins.
 */

const dir = new URL(".", import.meta.url).pathname;
const file = `${dir}_completions.ts`;

interface Asked {
  /** The names the completion list offers, the trailing `?` of an optional property removed. */
  readonly entries: string[];
  /** The documentation the completion list carries for one entry, as the editor shows it. */
  readonly docOf: (name: string) => string;
  /** The documentation a hover over the marked position shows. */
  readonly doc: string;
  /** The type a hover over the marked position shows. */
  readonly type: string;
}

/**
 * One project for the whole file, with the snippet swapped in between questions: a snapshot that
 * reports the file as changed costs a re-check of it, where a project per question would start a
 * compiler process and read lib.d.ts again. See `support/tsapi.ts` for why it is a project at all.
 */
const project = virtualProject({
  root: new URL("..", import.meta.url).pathname,
  configFileName: `${dir}_completions.tsconfig.json`,
  sources: new Map([[file, ""]]),
});
afterAll(() => project.dispose());

const ask = async (snippet: string): Promise<Asked> => {
  const marked = `
import { createPgRest } from "./support/pgrest";
import type { DatabasePgRest } from "./support/fixture.types";
declare const pgRest: Awaited<ReturnType<typeof createPgRest<DatabasePgRest>>>;
${snippet}
`;
  const pos = marked.indexOf("#");
  if (pos < 0) throw new Error("the snippet needs a # marker");
  const { checker, languageService } = await project.update(file, marked.slice(0, pos) + marked.slice(pos + 1));

  const entries = (await languageService.getCompletionsAtPosition(file, pos, { includeSymbol: true }))?.entries ?? [];
  /** The list names an optional property `select?`; the tests are written about `select`. */
  const nameOf = (entry: { name: string }) => entry.name.replace(/\?$/, "");
  const docs = new Map<string, string>();
  for (const entry of entries) {
    if (entry.symbol) docs.set(nameOf(entry), await entry.symbol.getDocumentationComment(checker));
  }

  // the API has no quick info: a hover is the symbol's documentation over its type at the position
  const symbol = await checker.getSymbolAtPosition(file, pos);
  const type = await checker.getTypeAtPosition(file, pos);
  return {
    entries: entries.map(nameOf).sort(),
    docOf: (name: string) => docs.get(name) ?? "",
    doc: symbol === undefined ? "" : await symbol.getDocumentationComment(checker),
    type: type === undefined ? "" : await checker.typeToString(type),
  };
};

/** Completion entries at `#` in `snippet`, with the marker removed. */
const completionsAt = async (snippet: string): Promise<string[]> => (await ask(snippet)).entries;

describe("what an editor offers in a typed query", () => {
  test("the table restricts the columns of select", async () => {
    expect(await completionsAt(`void pgRest.query({ table: "profiles", select: ["#"] });`)).toEqual([
      "*",
      "bio",
      "client_id",
    ]);
    // not the columns of every other table
    expect(await completionsAt(`void pgRest.query({ table: "profiles", select: ["#"] });`)).not.toContain("placed_at");
  });

  test("... and the keys of where, with $and/$or/$not alongside them", async () => {
    expect(await completionsAt(`void pgRest.query({ table: "profiles", where: { # } });`)).toEqual([
      "$and",
      "$not",
      "$or",
      "bio",
      "client_id",
    ]);
  });

  test("... and the embeddable relationships", async () => {
    const items = await completionsAt(`void pgRest.query({ table: "profiles", select: [{ # }] });`);
    // profiles(client_id) -> clients, and what clients leads back to
    expect(items).toContain("clients");
    expect(items).toContain("client_id");
    expect(items).not.toContain("order_items");
  });

  test("a function that returns a table's rows offers that table's columns", async () => {
    expect(await completionsAt(`void pgRest.query({ rpc: "orders_by_status", select: ["#"] });`)).toEqual([
      "*",
      "client_id",
      "id",
      "placed_at",
      "status",
      "total",
    ]);
    expect(await completionsAt(`void pgRest.query({ rpc: "#" });`)).toContain("orders_by_status");
    // a TABLE(...) function is the known gap: the catalog does not carry its output columns, so
    // there is nothing to offer and any name is accepted (the request path knows no more)
    expect(await completionsAt(`void pgRest.query({ rpc: "client_summary", select: ["#"] });`)).toEqual([""]);
  });

  test("the properties carry their documentation, in the list and on hover", async () => {
    // what you read when the completion list opens on an empty query
    const keys = await ask(`void pgRest.query({ # });`);
    expect(keys.entries).toContain("select");
    expect(keys.docOf("table")).toContain("restricts everything below");
    expect(keys.docOf("select")).toContain("columns to return");
    expect(keys.docOf("where")).toContain("Which rows, by column");
    expect(keys.docOf("single")).toContain("one object instead of an array");
    expect(keys.docOf("rpc")).toContain("Never both");

    // hovering the method gives the orientation, failures included
    const method = (await ask(`void pgRest.qu#ery({ table: "profiles" });`)).doc;
    expect(method).toContain("decides what the rest may say");
    expect(method).toContain("It never rejects");

    /*
     * Hovering a property you have already written shows its *inferred* type and no documentation:
     * the parameter is the inferred `Q`, so there is no declared property for the editor to point
     * at. Intersecting the union back in (`Q & TypedQuery<Db>`) restores nothing and makes the
     * union too complex to represent (TS2590), so this is the price of inferring `data` from the
     * `select`. The completion list above is where the documentation lands.
     */
    const written = await ask(`void pgRest.query({ table: "profiles", sel#ect: ["bio"] });`);
    expect(written.type).toBe('["bio"]');
    expect(written.doc).toBe("");

    // inside an embed, the long form documents itself too -- and `spread` is *declared*, which a
    // test of its inferred shape alone would not have caught
    const embed = await ask(`void pgRest.query({ table: "clients", select: [{ orders: { # } }] });`);
    expect(embed.entries).toEqual(["as", "hint", "inner", "limit", "offset", "order", "select", "spread", "where"]);
    expect(embed.docOf("spread")).toContain("merge these columns into the parent row");
    expect(embed.docOf("inner")).toContain("drop the parent rows");
  });

  test("a query bound to a context offers exactly what query() offers", async () => {
    // setContextQuery only drops `ctx`, so a bound call must keep the whole typed surface
    const bound = `const db = pgRest.setContextQuery(() => undefined);`;
    expect(await completionsAt(`${bound}\nvoid db({ table: "profiles", select: ["#"] });`)).toEqual([
      "*",
      "bio",
      "client_id",
    ]);
    expect(await completionsAt(`${bound}\nvoid db({ table: "profiles", where: { # } });`)).toEqual([
      "$and",
      "$not",
      "$or",
      "bio",
      "client_id",
    ]);
    expect(await completionsAt(`${bound}\nvoid db({ table: "#" });`)).toContain("clients");

    const method = (await ask(`void pgRest.setContext#Query(() => undefined);`)).doc;
    expect(method).toContain("AsyncLocalStorage");
  });

  test("the table names are the exposed ones", async () => {
    const tables = await completionsAt(`void pgRest.query({ table: "#" });`);
    expect(tables).toContain("clients");
    expect(tables).toContain("profiles");
    // v2.things lives in another schema, which has to be named first
    expect(tables).not.toContain("things");
    expect(await completionsAt(`void pgRest.query({ schema: "v2", table: "#" });`)).toEqual(["things"]);
  });
});
