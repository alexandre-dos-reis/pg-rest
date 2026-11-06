// Generated from the database catalog by @adrdp/pg-rest. Do not edit.

/** The `api.address` composite type. */
type DatabasePgRestCompositeApiAddress = {
  city: string | null;
  zip: string | null;
};

/** The `api.contact` composite type. */
type DatabasePgRestCompositeApiContact = {
  name: string | null;
  home: DatabasePgRestCompositeApiAddress | null;
  tags: string[] | null;
};

/** A composite value being written or compared: any of its fields may be left out. */
type DatabasePgRestCompositeInput<T> = T extends ReadonlyArray<infer E>
  ? ReadonlyArray<DatabasePgRestCompositeInput<E>>
  : T extends object
    ? { readonly [K in keyof T]?: DatabasePgRestCompositeInput<T[K]> }
    : T;

type DatabasePgRestApiRelations = {
  big_orders: {
    row: {
      id: number | null;
      client_id: number | null;
      status: string | null;
      total: number | null;
      placed_at: string | null;
    };
    insert: {
      id?: number | null;
      client_id?: number | null;
      status?: string | null;
      total?: number | null;
      placed_at?: string | null;
    };
    update: {
      id?: number | null;
      client_id?: number | null;
      status?: string | null;
      total?: number | null;
      placed_at?: string | null;
    };
    pk: [];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      client_id: { rel: "clients"; to: "one" };
      clients: { rel: "clients"; to: "one" };
      order_items: { rel: "order_items"; to: "many" };
      orders: { rel: "orders"; to: "many" };
      products: { rel: "products"; to: "many" };
    };
  };
  client_totals: {
    row: {
      client_id: number | null;
      revenue: number | null;
    };
    insert: never;
    update: never;
    pk: [];
    insertable: false;
    updatable: false;
    deletable: false;
    rel: {
      client_id: { rel: "clients"; to: "one" };
      clients: { rel: "clients"; to: "one" };
    };
  };
  clients: {
    row: {
      id: number;
      name: string;
      email: string | null;
      meta: unknown;
      tags: string[] | null;
      created_at: string;
    };
    insert: {
      id?: number;
      name: string;
      email?: string | null;
      meta?: unknown;
      tags?: string[] | null;
      created_at?: string;
    };
    update: {
      id?: number;
      name?: string;
      email?: string | null;
      meta?: unknown;
      tags?: string[] | null;
      created_at?: string;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      big_orders: { rel: "big_orders"; to: "many" };
      client_profile: { rel: "profiles"; to: "one" };
      client_totals: { rel: "client_totals"; to: "many" };
      orders: { rel: "orders"; to: "many" };
      profiles: { rel: "profiles"; to: "one" };
      recent_orders: { rel: "orders"; to: "many" };
    };
  };
  employees: {
    row: {
      id: number;
      name: string;
      manager_id: number | null;
    };
    insert: {
      id?: number;
      name: string;
      manager_id?: number | null;
    };
    update: {
      id?: number;
      name?: string;
      manager_id?: number | null;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      manager_id: { rel: "employees"; to: "one" };
    };
  };
  moods: {
    row: {
      id: number;
      mood: "sad" | "ok" | "happy";
      seen: ("sad" | "ok" | "happy")[] | null;
      note: string | null;
    };
    insert: {
      mood?: "sad" | "ok" | "happy";
      seen?: ("sad" | "ok" | "happy")[] | null;
      note?: string | null;
    };
    update: {
      mood?: "sad" | "ok" | "happy";
      seen?: ("sad" | "ok" | "happy")[] | null;
      note?: string | null;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {};
  };
  notes: {
    row: {
      id: number;
      owner: string;
      body: string;
    };
    insert: {
      id?: number;
      owner?: string;
      body: string;
    };
    update: {
      id?: number;
      owner?: string;
      body?: string;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {};
  };
  order_items: {
    row: {
      order_id: number;
      product_id: number;
      qty: number;
    };
    insert: {
      order_id: number;
      product_id: number;
      qty?: number;
    };
    update: {
      order_id?: number;
      product_id?: number;
      qty?: number;
    };
    pk: ["order_id", "product_id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      big_orders: { rel: "big_orders"; to: "one" };
      order_id: { rel: "orders"; to: "one"; ambiguous: true; hints: ["order_items_order_id_fkey", "order_items_order_id_fkey"] };
      orders: { rel: "orders"; to: "one" };
      product_id: { rel: "products"; to: "one" };
      products: { rel: "products"; to: "one" };
    };
  };
  orders: {
    row: {
      id: number;
      client_id: number;
      status: string;
      total: number;
      placed_at: string | null;
    };
    insert: {
      id?: number;
      client_id: number;
      status?: string;
      total?: number;
      placed_at?: string | null;
    };
    update: {
      id?: number;
      client_id?: number;
      status?: string;
      total?: number;
      placed_at?: string | null;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      big_orders: { rel: "big_orders"; to: "many" };
      client_id: { rel: "clients"; to: "one" };
      clients: { rel: "clients"; to: "one" };
      order_client: { rel: "clients"; to: "one" };
      order_items: { rel: "order_items"; to: "many" };
      products: { rel: "products"; to: "many" };
    };
  };
  place_names: {
    row: {
      id: number | null;
      name: string | null;
    };
    insert: {
      id?: number | null;
      name?: string | null;
    };
    update: {
      id?: number | null;
      name?: string | null;
    };
    pk: [];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {};
  };
  places: {
    row: {
      id: number;
      name: string | null;
      geom: unknown;
      area: unknown;
    };
    insert: {
      id: number;
      name?: string | null;
      geom?: unknown;
      area?: unknown;
    };
    update: {
      id?: number;
      name?: string | null;
      geom?: unknown;
      area?: unknown;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {};
  };
  products: {
    row: {
      id: number;
      name: string;
      price: number;
    };
    insert: {
      id?: number;
      name: string;
      price: number;
    };
    update: {
      id?: number;
      name?: string;
      price?: number;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      big_orders: { rel: "big_orders"; to: "many" };
      order_items: { rel: "order_items"; to: "many" };
      orders: { rel: "orders"; to: "many" };
    };
  };
  profiles: {
    row: {
      client_id: number;
      bio: string | null;
    };
    insert: {
      client_id: number;
      bio?: string | null;
    };
    update: {
      client_id?: number;
      bio?: string | null;
    };
    pk: ["client_id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {
      client_id: { rel: "clients"; to: "one" };
      clients: { rel: "clients"; to: "one" };
    };
  };
  venues: {
    row: {
      id: number;
      label: string;
      owner: DatabasePgRestCompositeApiContact | null;
      branches: DatabasePgRestCompositeApiAddress[] | null;
      meta: unknown;
    };
    insert: {
      id?: number;
      label: string;
      owner?: DatabasePgRestCompositeInput<DatabasePgRestCompositeApiContact> | null;
      branches?: DatabasePgRestCompositeInput<DatabasePgRestCompositeApiAddress[]> | null;
      meta?: unknown;
    };
    update: {
      id?: number;
      label?: string;
      owner?: DatabasePgRestCompositeInput<DatabasePgRestCompositeApiContact> | null;
      branches?: DatabasePgRestCompositeInput<DatabasePgRestCompositeApiAddress[]> | null;
      meta?: unknown;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {};
  };
};

type DatabasePgRestApiFunctions = {
  add: [{ args: { a: number; b: number }; returns: number; set: false }];
  add_note: [{ args: { txt: string }; returns: number; set: false }];
  all_places: [{ args: {}; returns: DatabasePgRestApiRelations["places"]["row"]; set: true }];
  bin_hi: [{ args: {}; returns: unknown; set: false }];
  blob: [{ args: {}; returns: string; set: false }];
  boom: [{ args: {}; returns: null; set: false }];
  cheer_up: [{ args: { m: "sad" | "ok" | "happy" }; returns: "sad" | "ok" | "happy"; set: false }];
  city_of: [{ args: { who: DatabasePgRestCompositeInput<DatabasePgRestCompositeApiContact> }; returns: string; set: false }];
  client_summary: [{ args: { cid: number }; returns: Record<string, unknown>; set: true }];
  clients_fin: [{ args: { state: string }; returns: unknown; set: false }];
  clients_txt_t: [{ args: { state: string; c: unknown }; returns: string; set: false }];
  echo_json: [{ args: { body: unknown }; returns: unknown; set: false }];
  echo_unnamed: [{ args: unknown; returns: unknown; set: false; raw: true }];
  first_client: [{ args: {}; returns: DatabasePgRestApiRelations["clients"]["row"]; set: false }];
  greet: [{ args: { name?: string }; returns: string; set: false }];
  hello: [{ args: {}; returns: string; set: false }];
  join_all: [{ args: { sep: string; parts: string[] }; returns: string; set: false }];
  make_address: [{ args: { city: string; zip: string }; returns: DatabasePgRestCompositeApiAddress; set: false }];
  nothing: [{ args: {}; returns: null; set: false }];
  nums: [{ args: {}; returns: number; set: true }];
  nums_plain: [{ args: {}; returns: unknown; set: true }];
  orders_by_status: [{ args: { s: string }; returns: DatabasePgRestApiRelations["orders"]["row"]; set: true }];
  ovl: [{ args: { a: number }; returns: string; set: false }, { args: { a: string }; returns: string; set: false }];
  plain_hi: [{ args: {}; returns: unknown; set: false }];
  pre_check: [{ args: {}; returns: null; set: false }];
  req_info: [{ args: {}; returns: unknown; set: false }];
  sum_all: [{ args: { nums: number[] }; returns: number; set: false }];
  whoami: [{ args: {}; returns: unknown; set: false }];
  with_headers: [{ args: {}; returns: string; set: false }];
  xml_hi: [{ args: {}; returns: unknown; set: false }];
};

type DatabasePgRestV2Relations = {
  things: {
    row: {
      id: number;
      label: string;
    };
    insert: {
      id?: number;
      label: string;
    };
    update: {
      id?: number;
      label?: string;
    };
    pk: ["id"];
    insertable: true;
    updatable: true;
    deletable: true;
    rel: {};
  };
};

type DatabasePgRestV2Functions = {};

export type DatabasePgRest = {
  default: "api";
  schemas: {
    api: { relations: DatabasePgRestApiRelations; functions: DatabasePgRestApiFunctions };
    v2: { relations: DatabasePgRestV2Relations; functions: DatabasePgRestV2Functions };
  };
};
