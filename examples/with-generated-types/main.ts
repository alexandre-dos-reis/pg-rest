// Step 2: use them. Every property below is checked against db.types.ts, and the result is inferred
// from the select -- hover `todos` in your editor, or read the comments.
//   node main.ts
import { close, pgRest } from "./client.ts";

const { data: todos, count, error } = await pgRest.query({
  table: "todos", //                             the relations of the exposed schema: "todos" | "tags"
  select: ["id", "title", "priority", { tags: ["label"] }], //  this table's columns, and `tags` because a foreign key leads there
  where: { done: false }, //                     this table's columns too, each with its own value type
  order: [{ column: "priority", desc: true }], //  a column again, so a typo is an error and not a silently unordered answer
  limit: 10, //                                  plain numbers: limit, offset
  count: "exact", //                             "exact" | "planned" | "estimated", and the mode decides count's type
});
// query() never rejects: the failure is in the result, and checking it narrows the other three
if (error) throw error;
// todos: Array<{ id: number; title: string; priority: "low" | "normal" | "high"; tags: Array<{ label: string }> }>
// count: number, because this query asked for one -- it would be `undefined` without the line above
console.log(`open todos (${count} in total):`, todos);
for (const todo of todos) console.log(`  ${todo.title} (${todo.priority}) ${todo.tags.map((t) => t.label).join(", ")}`);

// The table is what restricts the columns -- including in your editor. Inside `select` here, the
// completion offers id, todo_id, label and * : the three columns of `tags`, and nothing from `todos`.
const { data: labels } = await pgRest.query({
  table: "tags",
  select: ["label", { todos: ["title"] }], //     `done` would be an error: it is a column of todos, not of tags
  order: ["id"], //                              a bare column name works too, as does "id.desc"
});
console.log("tags:", labels);

const { data: urgent } = await pgRest.query({
  table: "todos",
  select: ["title"],
  where: { priority: ["in", ["high"]] }, //      an enum is a union of its labels: "urgent" would not compile
});
console.log("high priority:", urgent);

const { data: created, status } = await pgRest.query({
  table: "todos",
  action: "insert", //                           "select" (the default) | "insert" | "upsert" | "update" | "delete"
  rows: { title: "Generated types", priority: "high" }, //  the insert shape: `title` is required, `id` is generated and absent
  select: ["id", "priority"], //                 what a write gives back, when it gives anything
});
// created: Array<{ id: number; priority: "low" | "normal" | "high" }>
console.log(`created ${status}:`, created);

// A composite column is an object, both ways: its fields are typed, and a value being written or
// compared may leave some out -- the ones left out are NULL, as they would be in a row literal.
const { data: placed } = await pgRest.query({
  table: "todos",
  select: ["title", "at"], //                    `at` is api.place: { room: string | null; floor: number | null }
  where: { at: { room: "Lab", floor: 2 } }, //   the whole value; `{ room: "Lab" }` would compare floor against NULL
});
if (placed?.[0]) console.log(`in ${placed[0].at?.room} on floor ${placed[0].at?.floor}:`, placed[0].title);

const { data: moved } = await pgRest.query({
  table: "todos",
  action: "update",
  set: { at: { room: "Lab", floor: 3 } }, //     a nested object is the composite value
  where: { title: "Try pg-rest" },
  select: ["at"],
});
console.log("moved:", moved);
// Reaching a single field (`select: ["at->>room"]`, `where: { "at->>floor": 3 }`) works at runtime
// and is not described by the types, like any other JSON path: use an untyped instance for those.

const { data: open } = await pgRest.query({
  rpc: "open_todos", //                          the functions of the schema, instead of `table`
  select: ["title"], //                          its result is a row like any other: todos', here
});
// open: Array<{ title: string }>
console.log("rpc open_todos:", open);

const one = await pgRest.query({
  table: "todos",
  select: ["title", { tags: { as: "some", select: ["label"] } }],
  where: { id: 1 },
  single: true, //                               one object instead of an array (406 PGRST116 if there is not exactly one)
});
if (one.error) throw one.error;
// one.data: { title: string }
console.log("single:", one.data.title);

await close();
