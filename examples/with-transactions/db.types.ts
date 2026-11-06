// Generated from the database catalog by @adrdp/pg-rest. Do not edit.

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
