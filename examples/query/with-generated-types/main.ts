// Step 2: use them. Every property below is checked against db.generated.ts, and the result is inferred
// from the columns -- hover `todos` in your editor, or read the comments.
//   node main.ts
import { close, rest } from "./client.ts";

const {
  data: todos,
  count,
  error,
} = await rest.select({
  table: "todos", //                             the relations of the exposed schema: "todos" | "tags"
  columns: ["id", "title", "priority", { tags: ["label"] }], //  this table's columns, and `tags` because a foreign key leads there
  where: { done: false }, //                     this table's columns too, each with its own value type
  order: [{ column: "priority", desc: true }], //  a column again, so a typo is an error and not a silently unordered answer
  limit: 10, //                                  plain numbers: limit, offset
  count: "exact", //                             "exact" | "planned" | "estimated", and the mode decides count's type
});
// an operation never rejects: the failure is in the result, and checking it narrows the other three
if (error) throw error;
// todos: Array<{ id: number; title: string; priority: "low" | "normal" | "high"; tags: Array<{ label: string }> }>
// count: number, because this query asked for one -- it would be `undefined` without the line above
console.log(`open todos (${count} in total):`, todos);
for (const todo of todos) console.log(`  ${todo.title} (${todo.priority}) ${todo.tags.map((t) => t.label).join(", ")}`);

// The table is what restricts the columns -- including in your editor. Inside `columns` here, the
// completion offers id, todo_id, label and * : the three columns of `tags`, and nothing from `todos`.
const { data: labels } = await rest.select({
  table: "tags",
  columns: ["label", { todos: ["title"] }], //     `done` would be an error: it is a column of todos, not of tags
  order: ["id"], //                              a bare column name works too, as does "id.desc"
});
console.log("tags:", labels);

const { data: urgent } = await rest.select({
  table: "todos",
  columns: ["title"],
  where: { priority: { $in: ["high"] } }, //      an enum is a union of its labels: "urgent" would not compile
});
console.log("high priority:", urgent);

const { data: created, error: createFailed } = await rest.insert({
  table: "todos", //                           the table to insert into
  rows: { title: "Generated types", priority: "high", done: false }, //  the insert shape: `title` is required, `id` is generated and absent
  returning: ["id", "priority"], //                 what a write gives back, when it gives anything
});

if (createFailed) {
  console.log(createFailed);
}

// created: { id: number; priority: "low" | "normal" | "high" } -- one `rows` object, one row back
console.log(`created ${createFailed ? createFailed.kind : "ok"}:`, created);

// A composite column is an object, both ways: its fields are typed, and a value being written or
// compared may leave some out -- the ones left out are NULL, as they would be in a row literal.
const { data: placed } = await rest.select({
  table: "todos",
  columns: ["title", "at"], //                    `at` is api.place: { room: string | null; floor: number | null }
  where: { at: { room: "Lab", floor: 2 } }, //   the whole value; `{ room: "Lab" }` would compare floor against NULL
});
if (placed?.[0]) console.log(`in ${placed[0].at?.room} on floor ${placed[0].at?.floor}:`, placed[0].title);

const { data: toggledTodo1 } = await rest.update({
  table: "todos",
  // This is toggling `done`
  set: { done: { $not: { $col: "done" } } },
  where: { id: 2 },
  single: true,
});

console.log("toggle1:", toggledTodo1);

const { data: toggledTodo2 } = await rest.update({
  table: "todos",
  // This is toggling `done`
  set: { done: { $not: { $col: "done" } } },
  where: { id: 2 },
  single: true,
});

console.log("toggle2:", toggledTodo2);

const { data: moved } = await rest.update({
  table: "todos",
  set: { done: { $not: { $col: "done" } } },
  where: { title: "Try pg-rest" },
  returning: ["at"],
});
console.log("moved:", moved);
// Reaching a single field (`columns: ["at->>room"]`, `where: { "at->>floor": 3 }`) works at runtime
// and is not described by the types, like any other JSON path: use an untyped instance for those.

const { data: open } = await rest.rpc({
  name: "open_todos", //                         the functions of the schema, instead of `table`
  columns: ["title"], //                          its result is a row like any other: todos', here
});
// open: Array<{ title: string }>
console.log("rpc open_todos:", open);

const one = await rest.select({
  table: "todos",
  columns: ["title", { tags: { as: "some", columns: ["label"] } }],
  where: { id: 1 },
  single: true, //                               one object instead of an array (`not_single_row` if there is not exactly one)
});
if (one.error) throw one.error;
// one.data: { title: string }
console.log("single:", one.data.title);

await close();
