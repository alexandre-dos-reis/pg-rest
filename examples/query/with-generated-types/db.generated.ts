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
    defaults: never;
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
    defaults: "done" | "priority";
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

import type { SchemaDescriptor } from "@tsql/query";

export const schema: SchemaDescriptor = {
  "schemas": [
    "api"
  ],
  "relations": [
    {
      "schema": "api",
      "name": "tags",
      "kind": "table",
      "columns": [
        {
          "name": "id",
          "type": "bigint",
          "nullable": false,
          "hasDefault": true,
          "defaultExpr": null,
          "generated": false,
          "identity": "always",
          "comment": null,
          "position": 1
        },
        {
          "name": "todo_id",
          "type": "bigint",
          "nullable": false,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 2
        },
        {
          "name": "label",
          "type": "text",
          "nullable": false,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 3
        }
      ],
      "pk": [
        "id"
      ],
      "uniques": [],
      "insertable": true,
      "updatable": true,
      "deletable": true,
      "comment": null
    },
    {
      "schema": "api",
      "name": "todos",
      "kind": "table",
      "columns": [
        {
          "name": "id",
          "type": "bigint",
          "nullable": false,
          "hasDefault": true,
          "defaultExpr": null,
          "generated": false,
          "identity": "always",
          "comment": null,
          "position": 1
        },
        {
          "name": "title",
          "type": "text",
          "nullable": false,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 2
        },
        {
          "name": "done",
          "type": "boolean",
          "nullable": false,
          "hasDefault": true,
          "defaultExpr": "false",
          "generated": false,
          "comment": null,
          "position": 3
        },
        {
          "name": "priority",
          "type": "api.priority",
          "enumLabels": [
            "low",
            "normal",
            "high"
          ],
          "nullable": false,
          "hasDefault": true,
          "defaultExpr": "'normal'::api.priority",
          "generated": false,
          "comment": null,
          "position": 4
        },
        {
          "name": "due",
          "type": "date",
          "nullable": true,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 5
        },
        {
          "name": "at",
          "type": "api.place",
          "composite": {
            "schema": "api",
            "name": "place"
          },
          "nullable": true,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 6
        }
      ],
      "pk": [
        "id"
      ],
      "uniques": [],
      "insertable": true,
      "updatable": true,
      "deletable": true,
      "comment": null
    }
  ],
  "foreignKeys": [
    {
      "name": "tags_todo_id_fkey",
      "schema": "api",
      "table": "tags",
      "cols": [
        "todo_id"
      ],
      "fschema": "api",
      "ftable": "todos",
      "fcols": [
        "id"
      ]
    }
  ],
  "functions": [
    {
      "schema": "api",
      "name": "open_todos",
      "args": [],
      "returnType": "api.todos",
      "returnsSet": true,
      "returnsComposite": true,
      "returnsVoid": false,
      "volatility": "stable",
      "comment": null,
      "rows": 1000,
      "returnRelation": {
        "schema": "api",
        "name": "todos"
      }
    }
  ],
  "composites": [
    {
      "schema": "api",
      "name": "place",
      "attributes": [
        {
          "name": "room",
          "type": "text",
          "position": 1
        },
        {
          "name": "floor",
          "type": "integer",
          "position": 2
        }
      ],
      "comment": null
    }
  ],
  "mediaHandlers": []
};
