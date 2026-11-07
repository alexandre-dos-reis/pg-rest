import { defineConfig } from "tsdown";

// `@tsql/core` is a devDependency on purpose: tsdown bundles what is not a dependency, so the
// published package carries its share of the core and asks for nothing else.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    "adapters/bun": "../core/src/adapters/bun.ts",
    "adapters/node-postgres": "../core/src/adapters/node-postgres.ts",
    "adapters/postgres-js": "../core/src/adapters/postgres-js.ts",
    "adapters/pglite": "../core/src/adapters/pglite.ts",
  },
  format: "esm",
  dts: true,
  platform: "neutral",
});
