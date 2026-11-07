// Generated from the database catalog by @tsql/query. Do not edit.

/** The `api.place` composite type. */
type DatabasePgRestCompositeApiPlace = {
  room: string | null;
  floor: number | null;
};

/** A composite value being written or compared: any of its fields may be left out. */
type DatabasePgRestCompositeInput<T> = T extends ReadonlyArray<infer E>
  ? ReadonlyArray<DatabasePgRestCompositeInput<E>>
  : T extends object
    ? { readonly [K in keyof T]?: DatabasePgRestCompositeInput<T[K]> }
    : T;

type DatabasePgRestApiRelations = {
  tags: {
    row: {
      id: number;
      todo_id: number;
      label: string;
    };
    insert: {
      todo_id: number;
      label: string;
    };
    update: {
      todo_id?: number;
      label?: string;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      todo_id: { rel: "todos"; to: "one" };
      todos: { rel: "todos"; to: "one" };
    };
  };
  todos: {
    row: {
      id: number;
      title: string;
      done: boolean;
      priority: "low" | "normal" | "high";
      due: string | null;
      at: DatabasePgRestCompositeApiPlace | null;
    };
    insert: {
      title: string;
      done?: boolean;
      priority?: "low" | "normal" | "high";
      due?: string | null;
      at?: DatabasePgRestCompositeInput<DatabasePgRestCompositeApiPlace> | null;
    };
    update: {
      title?: string;
      done?: boolean;
      priority?: "low" | "normal" | "high";
      due?: string | null;
      at?: DatabasePgRestCompositeInput<DatabasePgRestCompositeApiPlace> | null;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      tags: { rel: "tags"; to: "many" };
    };
  };
};

type DatabasePgRestApiFunctions = {
  open_todos: [{ args: {}; returns: DatabasePgRestApiRelations["todos"]["row"]; set: true }];
};

export type DatabasePgRest = {
  default: "api";
  schemas: {
    api: { relations: DatabasePgRestApiRelations; functions: DatabasePgRestApiFunctions };
  };
};
