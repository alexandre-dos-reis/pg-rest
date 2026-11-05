// Step 2: use them. Every field below is checked against db.types.ts, and the result is inferred
// from the select -- hover `todos` in your editor, or read the comments.
//   node main.ts
import { createPgRest } from "@adrdp/pg-rest";
import { options, pglite } from "./db.ts";
import type { DatabasePgRest } from "./db.types.ts";

const pgRest = await createPgRest<DatabasePgRest>(options);

const { data: todos } = await pgRest.query({
  table: "todos", // <- typed: only a relation of the exposed schema
  select: ["id", "title", "priority", { tags: ["label"] }], // <- typed: real columns, real relationship
  where: { done: false }, // <- typed: its own columns, with the right value type
  order: [{ column: "priority", desc: true }],
  limit: 10,
});
// todos: Array<{ id: number; title: string; priority: "low" | "normal" | "high"; tags: Array<{ label: string }> }>
console.log("open todos:", todos);
for (const todo of todos) console.log(`  ${todo.title} (${todo.priority}) ${todo.tags.map((t) => t.label).join(", ")}`);

// An enum is a union of its labels, so the filter only takes a real one.
const { data: urgent, count } = await pgRest.query({
  table: "todos",
  select: ["title"],
  where: { priority: ["in", ["high"]] },
  count: "exact",
});
console.log("high priority:", urgent, `(${count} in total)`);

// A write takes the insert shape: `id` is generated, `title` is required, the rest has defaults.
const { data: created, status } = await pgRest.query({
  table: "todos",
  action: "insert",
  rows: { title: "Generated types", priority: "high" },
  select: ["id", "priority"],
});
// created: Array<{ id: number; priority: "low" | "normal" | "high" }>
console.log(`created ${status}:`, created);

// A function's result is a row like any other: its select narrows it the same way.
const { data: open } = await pgRest.query({ rpc: "open_todos", select: ["title"] });
// open: Array<{ title: string }>
console.log("rpc open_todos:", open);

// One object instead of an array, and nothing comes back from a minimal write.
const { data: one } = await pgRest.query({ table: "todos", select: ["title"], where: { id: 1 }, single: true });
// one: { title: string }
console.log("single:", one.title);

await pgRest.close();
await pglite.close();
