// Generated from the database catalog by @adrdp/pg-rest. Do not edit.

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
    };
    insert: {
      title: string;
      done?: boolean;
      priority?: "low" | "normal" | "high";
      due?: string | null;
    };
    update: {
      title?: string;
      done?: boolean;
      priority?: "low" | "normal" | "high";
      due?: string | null;
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
