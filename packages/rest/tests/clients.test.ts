import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PostgrestClient } from "@supabase/postgrest-js";
import { NeonPostgrestClient } from "@neondatabase/postgrest-js";
import type { RequestContext } from "../../../tests/support/pgrest";
import { hasDb } from "../../../tests/support/db";
import { authed, makeApi, type TestApi } from "../../../tests/support/api";

/**
 * The PostgREST client libraries, driving `handle()` directly: they take a `fetch`, so the whole
 * exchange happens in memory, with no port to bind.
 *
 * This is a different angle from the rest of the suite -- those requests are written by hand, these
 * are the ones a real client produces: `Accept: application/vnd.pgrst.object+json` for `single()`,
 * `Prefer: count=exact` and `return=representation`, `Range` for `range()`, `Accept-Profile` for
 * `schema()`, `on_conflict` for `upsert()`. If a client stops working against pg-rest, it fails here.
 */
describe.skipIf(!hasDb)("the PostgREST clients", () => {
  let t: TestApi;
  beforeAll(async () => {
    t = await makeApi();
  });
  afterAll(() => t.close());

  /** The handler, as a `fetch`: no port, no server, the exchange stays in memory. */
  const handleAsFetch = (ctx?: RequestContext) =>
    ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      t.api.handle(new Request(input as string, init), ctx)) as typeof fetch;

  const supabase = (ctx?: RequestContext) => new PostgrestClient("http://pg-rest", { fetch: handleAsFetch(ctx) });

  /** Neon's client extends Supabase's; what is worth checking is its own constructor. */
  const neon = (ctx?: RequestContext) =>
    new NeonPostgrestClient({ dataApiUrl: "http://pg-rest", options: { global: { fetch: handleAsFetch(ctx) } } });

  describe("@supabase/postgrest-js", () => {
    test("select, with an embed, a filter, an order and a limit", async () => {
      const r = await supabase().from("clients").select("name,orders(total)").eq("id", 1).limit(1);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([{ name: "Ada", orders: [{ total: 250 }, { total: 40.5 }] }]);
    });

    test("single, and maybeSingle on no row", async () => {
      const one = await supabase().from("clients").select("name").eq("id", 1).single();
      expect(one.data).toEqual({ name: "Ada" });
      const none = await supabase().from("clients").select("name").eq("id", 999).maybeSingle();
      expect([none.data, none.error]).toEqual([null, null]);
      // and the 406 a client reports when `single` matches more than one row
      const many = await supabase().from("clients").select("name").single();
      expect(many.error?.code).toBe("PGRST116");
    });

    test("count, and range as a partial answer", async () => {
      const counted = await supabase().from("orders").select("id", { count: "exact", head: true });
      expect(counted.count).toBe(4);
      // a range alone answers 200: a partial answer needs a total to be partial against
      const page = await supabase().from("orders").select("id").order("id").range(0, 1);
      expect(page.data).toEqual([{ id: 1 }, { id: 2 }]);
      expect([page.status, page.count]).toEqual([200, null]);
      // with a count, the same window is a 206 out of 4
      const partial = await supabase().from("orders").select("id", { count: "exact" }).order("id").range(0, 1);
      expect([partial.status, partial.count]).toEqual([206, 4]);
    });

    test("the filter builders", async () => {
      const or = await supabase().from("orders").select("id").or("status.eq.new,total.gte.400").order("id");
      expect(or.data).toEqual([{ id: 2 }, { id: 4 }]);
      const not = await supabase().from("orders").select("id").not("status", "in", "(paid,new)").order("id");
      expect(not.data).toEqual([{ id: 4 }]);
      const contains = await supabase().from("clients").select("name").contains("tags", ["vip"]).order("id");
      expect(contains.data).toEqual([{ name: "Ada" }, { name: "Grace" }]);
      const isNull = await supabase().from("clients").select("name").is("meta", null);
      expect(isNull.data).toEqual([{ name: "Grace" }]);
    });

    test("insert, update, upsert and delete", async () => {
      const client = supabase(authed());
      const inserted = await client.from("clients").insert({ name: "Hopper" }).select("id,name");
      expect(inserted.status).toBe(201);
      expect(inserted.data).toEqual([{ id: expect.any(Number), name: "Hopper" }]);
      const id = (inserted.data as Array<{ id: number }>)[0]!.id;

      const updated = await client.from("clients").update({ name: "Grace H" }).eq("id", id).select("name");
      expect(updated.data).toEqual([{ name: "Grace H" }]);

      // upsert sends on_conflict; email is unique in the fixture
      const upserted = await client
        .from("clients")
        .upsert({ email: "ada@example.com", name: "Ada L" }, { onConflict: "email" })
        .select("id,name");
      expect(upserted.data).toEqual([{ id: 1, name: "Ada L" }]);

      const deleted = await client.from("clients").delete().eq("id", id).select("id");
      expect(deleted.data).toEqual([{ id }]);
    });

    test("rpc, with arguments and with a set-returning function", async () => {
      expect((await supabase().rpc("add", { a: 2, b: 3 })).data).toBe(5);
      const rows = await supabase().rpc("orders_by_status", { s: "paid" }).select("total").order("total");
      expect(rows.data).toEqual([{ total: 99.99 }, { total: 250 }]);
    });

    test("composite columns: the object comes back, and the arrow forms go out", async () => {
      // `select("owner->>name")` is what a client sends for a field of a composite column; the
      // whole column arrives as the nested object Postgres returns
      const whole = await supabase().from("venues").select("label,owner").eq("id", 1).single();
      expect(whole.data).toEqual({
        label: "Concert hall",
        owner: { name: "Ada", home: { city: "Paris", zip: "75001" }, tags: ["music", "large"] },
      });
      const field = await supabase().from("venues").select("id,owner->>name,owner->home->>city").order("id");
      expect(field.data).toEqual([
        { id: 1, name: "Ada", city: "Paris" },
        { id: 2, name: "Grace", city: "Lyon" },
      ]);
      expect((await supabase().from("venues").select("id").eq("owner->>name", "Grace")).data).toEqual([{ id: 2 }]);

      // and a write carries the nested object, as it does for json
      const client = supabase(authed());
      const inserted = await client
        .from("venues")
        .insert({ label: "Client hall", owner: { name: "Barbara", home: { city: "Brussels" } } })
        .select("label,owner->>name,owner->home->>city")
        .single();
      expect(inserted.data).toEqual({ label: "Client hall", name: "Barbara", city: "Brussels" });
      await client.from("venues").delete().eq("label", "Client hall");
    });

    test("another schema, and csv", async () => {
      const v2 = await supabase().schema("v2").from("things").select("label").order("id");
      expect(v2.data).toEqual([{ label: "one" }, { label: "two" }]);
      const csv = await supabase().from("profiles").select("client_id,bio").order("client_id").csv();
      expect(csv.data).toBe('client_id,bio\n1,"First programmer"\n3,"Compiler pioneer"');
    });

    test("errors arrive as the client's error, with the PostgREST body", async () => {
      const unknown = await supabase().from("cients").select("id");
      expect(unknown.status).toBe(404);
      expect(unknown.error?.code).toBe("PGRST205");
      expect(unknown.error?.hint).toBe("Perhaps you meant the table 'api.clients'");

      const denied = await supabase().from("clients").insert({ name: "nope" });
      expect(denied.status).toBe(401);
      expect(denied.error?.code).toBe("42501");
    });

    test("row level security follows the caller the fetch was built with", async () => {
      await supabase(authed("alice")).from("notes").insert({ body: "alice only" });
      expect((await supabase(authed("alice")).from("notes").select("body")).data).toEqual([{ body: "alice only" }]);
      expect((await supabase(authed("bob")).from("notes").select("body")).data).toEqual([]);
    });
  });

  describe("@neondatabase/postgrest-js", () => {
    test("the same requests go through its own constructor", async () => {
      // a row no other test writes to, since they share one database
      const r = await neon().from("clients").select("name,orders(total)").eq("id", 2);
      expect(r.error).toBeNull();
      expect(r.data).toEqual([{ name: "Linus", orders: [{ total: 99.99 }] }]);
      expect((await neon().rpc("add", { a: 20, b: 22 })).data).toBe(42);
      const written = await neon(authed()).from("clients").insert({ name: "Neon" }).select("name");
      expect(written.data).toEqual([{ name: "Neon" }]);
      expect((await neon().from("cients").select("id")).error?.code).toBe("PGRST205");
    });
  });
});
