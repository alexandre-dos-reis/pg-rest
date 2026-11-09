import { join } from "node:path";
import { readdir } from "node:fs/promises";

export const getAdapterEntries = async () =>
  Object.fromEntries(
    (await readdir("../adapters/src")).map((f) => [`adapters/${f.replace(".ts", "")}`, join(`../adapters/src`, f)]),
  );
