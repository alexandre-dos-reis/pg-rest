import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";

/**
 * What an editor offers inside a typed query, asked of the TypeScript language service itself.
 *
 * This is not a detail of taste: TypeScript only narrows the contextual type of a nested property
 * (the items of `select`, the keys of `where`) when the discriminant picks **exactly one** member of
 * the union. Two things are needed for that, and both are easy to undo by accident --
 * `src/typed.ts` must keep one member per table (reads and writes merged, their payloads enforced
 * by `WriteRules`) and every member must *declare* `table`, the function calls included (`table?:
 * never`). Without them the editor proposes every table's columns, which is what this pins.
 */
import type * as TS from "typescript";

const ts = createRequire(import.meta.url)("typescript") as typeof TS;

const dir = new URL(".", import.meta.url).pathname;
const file = `${dir}_completions.ts`;

interface Asked {
  readonly entries: string[];
  /** The documentation the completion list carries for one entry, as the editor shows it. */
  readonly docOf: (name: string) => string;
  /** What a hover over the marked position says. */
  readonly hover: string;
}

/**
 * One language service for the whole file, with the snippet swapped in between questions. Creating
 * one per question meant re-reading lib.d.ts and the fixture's types for each of them.
 */
const options: TS.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};
let content = "";
let version = 0;
const host: TS.LanguageServiceHost = {
  getScriptFileNames: () => [file],
  getScriptVersion: (f: string) => (f === file ? String(version) : "1"),
  getScriptSnapshot: (f: string) =>
    f === file
      ? ts.ScriptSnapshot.fromString(content)
      : existsSync(f)
        ? ts.ScriptSnapshot.fromString(readFileSync(f, "utf8"))
        : undefined,
  getCurrentDirectory: () => dir,
  getCompilationSettings: () => options,
  getDefaultLibFileName: (o: TS.CompilerOptions) => ts.getDefaultLibFilePath(o),
  fileExists: (f: string) => f === file || ts.sys.fileExists(f),
  readFile: (f: string) => (f === file ? content : ts.sys.readFile(f)),
  readDirectory: ts.sys.readDirectory,
  directoryExists: ts.sys.directoryExists,
  getDirectories: ts.sys.getDirectories,
  realpath: ts.sys.realpath,
};
const service = ts.createLanguageService(host, ts.createDocumentRegistry());
const text = (parts: TS.SymbolDisplayPart[] | undefined) => (parts ?? []).map((d) => d.text).join("");

const ask = (snippet: string): Asked => {
  const marked = `
import { createPgRest } from "../src/index";
import type { DatabasePgRest } from "./support/fixture.types";
declare const pgRest: Awaited<ReturnType<typeof createPgRest<DatabasePgRest>>>;
${snippet}
`;
  const pos = marked.indexOf("#");
  if (pos < 0) throw new Error("the snippet needs a # marker");
  content = marked.slice(0, pos) + marked.slice(pos + 1);
  version++;

  const info = service.getQuickInfoAtPosition(file, pos);
  return {
    entries: (service.getCompletionsAtPosition(file, pos, {})?.entries ?? []).map((e) => e.name).sort(),
    docOf: (name: string) =>
      text(
        service.getCompletionEntryDetails(file, pos, name, undefined, undefined, undefined, undefined)?.documentation,
      ),
    hover: `${text(info?.displayParts)}\n${text(info?.documentation)}`,
  };
};

/** Completion entries at `#` in `snippet`, with the marker removed. */
const completionsAt = (snippet: string): string[] => ask(snippet).entries;

describe("what an editor offers in a typed query", () => {
  test("the table restricts the columns of select", () => {
    expect(completionsAt(`void pgRest.query({ table: "profiles", select: ["#"] });`)).toEqual([
      "*",
      "bio",
      "client_id",
    ]);
    // not the columns of every other table
    expect(completionsAt(`void pgRest.query({ table: "profiles", select: ["#"] });`)).not.toContain("placed_at");
  });

  test("... and the keys of where, with $and/$or/$not alongside them", () => {
    expect(completionsAt(`void pgRest.query({ table: "profiles", where: { # } });`)).toEqual([
      "$and",
      "$not",
      "$or",
      "bio",
      "client_id",
    ]);
  });

  test("... and the embeddable relationships", () => {
    const items = completionsAt(`void pgRest.query({ table: "profiles", select: [{ # }] });`);
    // profiles(client_id) -> clients, and what clients leads back to
    expect(items).toContain("clients");
    expect(items).toContain("client_id");
    expect(items).not.toContain("order_items");
  });

  test("a function that returns a table's rows offers that table's columns", () => {
    expect(completionsAt(`void pgRest.query({ rpc: "orders_by_status", select: ["#"] });`)).toEqual([
      "*",
      "client_id",
      "id",
      "placed_at",
      "status",
      "total",
    ]);
    expect(completionsAt(`void pgRest.query({ rpc: "#" });`)).toContain("orders_by_status");
    // a TABLE(...) function is the known gap: the catalog does not carry its output columns, so
    // there is nothing to offer and any name is accepted (the request path knows no more)
    expect(completionsAt(`void pgRest.query({ rpc: "client_summary", select: ["#"] });`)).toEqual([""]);
  });

  test("the properties carry their documentation, in the list and on hover", () => {
    // what you read when the completion list opens on an empty query
    const keys = ask(`void pgRest.query({ # });`);
    expect(keys.entries).toContain("select");
    expect(keys.docOf("table")).toContain("restricts everything below");
    expect(keys.docOf("select")).toContain("columns to return");
    expect(keys.docOf("where")).toContain("Which rows, by column");
    expect(keys.docOf("single")).toContain("one object instead of an array");
    expect(keys.docOf("rpc")).toContain("Never both");

    // hovering the method gives the orientation, failures included
    const method = ask(`void pgRest.qu#ery({ table: "profiles" });`).hover;
    expect(method).toContain("decides what the rest may say");
    expect(method).toContain("It never rejects");

    /*
     * Hovering a property you have already written shows its *inferred* type and no documentation:
     * the parameter is the inferred `Q`, so there is no declared property for the editor to point
     * at. Intersecting the union back in (`Q & TypedQuery<Db>`) restores nothing and makes the
     * union too complex to represent (TS2590), so this is the price of inferring `data` from the
     * `select`. The completion list above is where the documentation lands.
     */
    const written = ask(`void pgRest.query({ table: "profiles", sel#ect: ["bio"] });`);
    expect(written.hover).toContain('(property) select: readonly ["bio"]');

    // inside an embed, the long form documents itself too -- and `spread` is *declared*, which a
    // test of its inferred shape alone would not have caught
    const embed = ask(`void pgRest.query({ table: "clients", select: [{ orders: { # } }] });`);
    expect(embed.entries).toEqual(["as", "hint", "inner", "limit", "offset", "order", "select", "spread", "where"]);
    expect(embed.docOf("spread")).toContain("merge these columns into the parent row");
    expect(embed.docOf("inner")).toContain("drop the parent rows");
  });

  test("a query bound to a context offers exactly what query() offers", () => {
    // setContextQuery only drops `ctx`, so a bound call must keep the whole typed surface
    const bound = `const db = pgRest.setContextQuery(() => undefined);`;
    expect(completionsAt(`${bound}\nvoid db({ table: "profiles", select: ["#"] });`)).toEqual([
      "*",
      "bio",
      "client_id",
    ]);
    expect(completionsAt(`${bound}\nvoid db({ table: "profiles", where: { # } });`)).toEqual([
      "$and",
      "$not",
      "$or",
      "bio",
      "client_id",
    ]);
    expect(completionsAt(`${bound}\nvoid db({ table: "#" });`)).toContain("clients");

    const method = ask(`void pgRest.setContext#Query(() => undefined);`).hover;
    expect(method).toContain("AsyncLocalStorage");
  });

  test("the table names are the exposed ones", () => {
    const tables = completionsAt(`void pgRest.query({ table: "#" });`);
    expect(tables).toContain("clients");
    expect(tables).toContain("profiles");
    // v2.things lives in another schema, which has to be named first
    expect(tables).not.toContain("things");
    expect(completionsAt(`void pgRest.query({ schema: "v2", table: "#" });`)).toEqual(["things"]);
  });
});
