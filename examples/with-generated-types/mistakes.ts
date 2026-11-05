// What the types refuse. Each line is a mistake, and `@ts-expect-error` is the assertion that it is
// one: `npm run typecheck` fails if any of them ever starts compiling. Remove a comment to see the
// message the compiler gives you.
import { pgRest } from "./client.ts";

// @ts-expect-error no such table ("todos" exists)
void pgRest.query({ table: "todoz", select: ["id"] });

// @ts-expect-error no such column
void pgRest.query({ table: "todos", select: ["titel"] });

// @ts-expect-error no such relationship (tags is one, todoz is not)
void pgRest.query({ table: "todos", select: [{ todoz: ["label"] }] });

// @ts-expect-error `done` is a boolean
void pgRest.query({ table: "todos", where: { done: "false" } });

// @ts-expect-error "urgent" is not one of the enum's labels
void pgRest.query({ table: "todos", where: { priority: "urgent" } });

// @ts-expect-error `title` has no default and is NOT NULL
void pgRest.query({ table: "todos", action: "insert", rows: { priority: "low" } });

// @ts-expect-error `id` is generated: it cannot be written
void pgRest.query({ table: "todos", action: "insert", rows: { id: 42, title: "nope" } });

// @ts-expect-error order only takes real columns
void pgRest.query({ table: "todos", order: ["dew.desc"] });

// @ts-expect-error a misspelled field would be dropped in silence at runtime
void pgRest.query({ table: "todos", select: ["id"], limitt: 10 });

// @ts-expect-error no such function
void pgRest.query({ rpc: "closed_todos" });
