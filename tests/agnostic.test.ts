import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/** The library must not depend on any runtime or driver: callers pass an adapter. */
describe("runtime-agnostic library", () => {
  test("src/ does not reference Bun, node: builtins or a database driver", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      const text = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // ignore comments
      if (/from\s+["'](bun|bun:[^"']*|node:[^"']*|pg|postgres|@electric-sql\/pglite)["']|\bBun\.|\bprocess\.|require\(|import\(["']bun/.test(text)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every example ships the same schema.sql (they are independent copies)", async () => {
    const files: string[] = [];
    for await (const f of new Glob("examples/*/schema.sql").scan(".")) files.push(f);
    expect(files.length).toBeGreaterThanOrEqual(4);
    const texts = await Promise.all(files.map((f) => Bun.file(f).text()));
    expect(new Set(texts).size).toBe(1);
  });
});
