# Performance

[`bench/`](../bench) load-tests pg-rest against the real PostgREST 16 on the same database, the same data and the same
pool size, after checking that both return identical results. The numbers below come from **one run on a small 2-vCPU
sandbox**: they are indicative only, and [`bench/README.md`](../bench/README.md) has the scenarios, the caveats and how
to run it on your own hardware.

In that sandbox, pg-rest on Bun was on par with or faster than PostgREST in every scenario, and slower on a few of the
cheapest ones when run on Node, where it also uses more memory.

## Which runtime?

Throughput is relative to PostgREST 16.

| | Bun (`bun run`) | Bun, compiled (`bun compile`, experimental) | Node + `pg` |
| --- | --- | --- | --- |
| Throughput | 1.2–1.5× on most reads, ~2× on writes | same as plain Bun (within noise) | 0.7–0.9× on the cheapest queries, ahead on heavier ones |
| Peak memory | ~80 MB | ~50 MB | ~125 MB |
| Setup | nothing extra | a single executable; needs a recent (canary) Bun | Node (tested on 22) |
| Pick it when | you can run Bun — the default choice | memory or deployment size matters and you accept an experimental feature | Bun is not an option |

`bun build --compile` and `--bytecode` performed like plain Bun, so they are only worth it for the single binary.
PostgREST itself uses the least memory of all (about 40–47 MB).

## Why it is in that range at all

- **One statement per request.** The plan builds the body, the page total, the count and the response GUCs in a single
  statement, and Postgres renders the JSON (or CSV, or GeoJSON). The handler forwards text instead of walking rows.
- **One transaction per request**, on one connection, with one `set_config` statement for the role, the claims and the
  `search_path`.
- **The catalog is read once.** Relationship resolution, column lookups and function overload selection all happen
  against the in-memory cache. → [`architecture.md`](architecture.md#the-schema-cache)
- **No runtime dependencies**, and the adapters never import their driver, so a deployment carries only what it imports.

## In-process is cheaper than a loopback

The in-process operations skip the socket, the HTTP parse and the response parse, but it is the *same* SQL: the win is the envelope, not
the database. If you are reaching for it to make a slow query fast, look at the plan instead — `planEnabled` and
`Accept: application/vnd.pgrst.plan` give you Postgres's own.
