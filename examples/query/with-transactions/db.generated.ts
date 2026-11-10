// Generated from the database catalog by @tspg/query. Do not edit.

type DatabasePgRestApiRelations = {
  accounts: {
    row: {
      id: string;
      owner: string;
      balance: number;
    };
    insert: {
      id: string;
      owner: string;
      balance: number;
    };
    update: {
      id?: string;
      owner?: string;
      balance?: number;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      ledger: { rel: "ledger"; to: "many"; ambiguous: true; hints: ["ledger_payer_fkey", "ledger_payee_fkey"] };
    };
  };
  ledger: {
    row: {
      id: number;
      payer: string;
      payee: string;
      amount: number;
      memo: string | null;
      at: string;
    };
    insert: {
      payer: string;
      payee: string;
      amount: number;
      memo?: string | null;
      at?: string;
    };
    update: {
      payer?: string;
      payee?: string;
      amount?: number;
      memo?: string | null;
      at?: string;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      accounts: { rel: "accounts"; to: "one"; ambiguous: true; hints: ["ledger_payer_fkey", "ledger_payee_fkey"] };
      payee: { rel: "accounts"; to: "one" };
      payer: { rel: "accounts"; to: "one" };
    };
  };
};

type DatabasePgRestApiFunctions = {};

export type DatabasePgRest = {
  default: "api";
  schemas: {
    api: { relations: DatabasePgRestApiRelations; functions: DatabasePgRestApiFunctions };
  };
};

import type { SchemaDescriptor } from "@tspg/query";

export const schema: SchemaDescriptor = {
  "schemas": [
    "api"
  ],
  "relations": [
    {
      "schema": "api",
      "name": "accounts",
      "kind": "table",
      "columns": [
        {
          "name": "id",
          "type": "text",
          "nullable": false,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 1
        },
        {
          "name": "owner",
          "type": "text",
          "nullable": false,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 2
        },
        {
          "name": "balance",
          "type": "integer",
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
      "name": "ledger",
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
          "name": "payer",
          "type": "text",
          "nullable": false,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 2
        },
        {
          "name": "payee",
          "type": "text",
          "nullable": false,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 3
        },
        {
          "name": "amount",
          "type": "integer",
          "nullable": false,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 4
        },
        {
          "name": "memo",
          "type": "text",
          "nullable": true,
          "hasDefault": false,
          "defaultExpr": null,
          "generated": false,
          "comment": null,
          "position": 5
        },
        {
          "name": "at",
          "type": "timestamp with time zone",
          "nullable": false,
          "hasDefault": true,
          "defaultExpr": "now()",
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
      "name": "ledger_payer_fkey",
      "schema": "api",
      "table": "ledger",
      "cols": [
        "payer"
      ],
      "fschema": "api",
      "ftable": "accounts",
      "fcols": [
        "id"
      ]
    },
    {
      "name": "ledger_payee_fkey",
      "schema": "api",
      "table": "ledger",
      "cols": [
        "payee"
      ],
      "fschema": "api",
      "ftable": "accounts",
      "fcols": [
        "id"
      ]
    }
  ],
  "functions": [],
  "composites": [],
  "mediaHandlers": []
};
