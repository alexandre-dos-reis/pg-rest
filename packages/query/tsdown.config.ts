import { defineConfig } from "tsdown";
import { getAdapterEntries } from "../adapters/build.ts";

// `@tspg/core` is a devDependency on purpose: tsdown bundles what is not a dependency, so the
// published package carries its share of the core and asks for nothing else.
export default defineConfig({
  entry: {
    index: "src/index.ts",
    types: "src/types.ts",
    ...(await getAdapterEntries()),
  },
  format: "esm",
  dts: true,
  platform: "neutral",
  exports: true,
});
