import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
    "adapters/bun": "src/adapters/bun.ts",
    "adapters/node-postgres": "src/adapters/node-postgres.ts",
    "adapters/postgres-js": "src/adapters/postgres-js.ts",
    "adapters/pglite": "src/adapters/pglite.ts",
  },
  format: "esm",
  dts: true,
  platform: "neutral",
});
