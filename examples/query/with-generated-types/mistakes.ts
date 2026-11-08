// What the types refuse. Each line is a mistake, and `@ts-expect-error` is the assertion that it is
// one: `npm run typecheck` fails if any of them ever starts compiling. Remove a comment to see the
// message the compiler gives you.
import { pgRest } from "./client.ts";

// @ts-expect-error no such table ("todos" exists)
void pgRest.select({ table: "todoz", columns: ["id"] });

// @ts-expect-error no such column
void pgRest.select({ table: "todos", columns: ["titel"] });

// @ts-expect-error no such relationship (tags is one, todoz is not)
void pgRest.select({ table: "todos", columns: [{ todoz: ["label"] }] });

// @ts-expect-error `done` is a boolean
void pgRest.select({ table: "todos", where: { done: "false" } });

// @ts-expect-error "urgent" is not one of the enum's labels
void pgRest.select({ table: "todos", where: { priority: "urgent" } });

// @ts-expect-error `title` has no default and is NOT NULL
void pgRest.insert({ table: "todos", rows: { priority: "low" } });

// @ts-expect-error `id` is generated: it cannot be written
void pgRest.insert({ table: "todos", rows: { id: 42, title: "nope" } });

// @ts-expect-error order only takes real columns
void pgRest.select({ table: "todos", order: ["dew.desc"] });

// @ts-expect-error a misspelled field would be dropped in silence at runtime
void pgRest.select({ table: "todos", columns: ["id"], limitt: 10 });

// @ts-expect-error `floor` is an int: a field of a composite type is checked like any other value
void pgRest.select({ table: "todos", where: { at: { floor: "2" } } });

// @ts-expect-error api.place has no `building` field
void pgRest.insert({ table: "todos", rows: { title: "x", at: { building: "A" } } });

// @ts-expect-error no such function
void pgRest.rpc({ rpc: "closed_todos" });
