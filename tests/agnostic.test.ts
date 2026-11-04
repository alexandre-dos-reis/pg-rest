import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

/** The library must not depend on any runtime or driver: callers pass an adapter. */
describe("runtime-agnostic library", () => {
  test("src/ does not reference Bun, node: builtins or a database driver", async () => {
    const offenders: string[] = [];
    for await (const file of new Glob("src/**/*.ts").scan(".")) {
      const text = (await Bun.file(file).text()).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""); // ignore comments
      if (
        /from\s+["'](bun|bun:[^"']*|node:[^"']*|pg|postgres|@electric-sql\/pglite)["']|\bBun\.|\bprocess\.|require\(|import\(["']bun/.test(
          text,
        )
      ) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  // with-better-auth differs on purpose: todos.owner_id references the Better Auth user (see its README)
  test("the examples ship the same schema.sql (they are independent copies)", async () => {
    const files: string[] = [];
    for await (const f of new Glob("examples/*/schema.sql").scan(".")) {
      if (!f.includes("with-better-auth")) files.push(f);
    }
    expect(files.length).toBeGreaterThanOrEqual(4);
    const texts = await Promise.all(files.map((f) => Bun.file(f).text()));
    expect(new Set(texts).size).toBe(1);
  });

  test("with-better-auth creates Better Auth's tables before the api schema", async () => {
    const dir = "examples/with-better-auth";
    expect(await Bun.file(`${dir}/schema.sql`).exists()).toBe(false);
    const auth = await Bun.file(`${dir}/1-better-auth.sql`).text();
    const api = await Bun.file(`${dir}/2-api.sql`).text();
    const compose = await Bun.file(`${dir}/docker-compose.yml`).text();
    expect(auth).toContain('CREATE TABLE "user"');
    expect(api).toContain('REFERENCES public."user"(id)');
    expect(compose).toContain("1-better-auth.sql");
    expect(compose).toContain("2-api.sql");
  });
});
