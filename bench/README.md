# Benchmarks: pg-rest vs PostgREST 16

Load test of the real PostgREST 16 binary against pg-rest (on Bun with `Bun.sql`, and on Node with `pg`), on the **same
PostgreSQL database**, with the same data, the same connection-pool size and the same requests.

```sh
bun run build                      # the benchmark uses the built package, as a consumer would
POSTGREST_BIN=/path/to/postgrest \
BENCH_ADMIN_URL=postgres://postgres@localhost:5432/postgres \
bun run bench                      # writes bench/results/latest.md and latest.json
```

`BENCH_ADMIN_URL` must be a superuser URL of a throwaway server (the runner creates and drops its own database).
The GitHub workflow *Benchmark* runs the same thing on demand (manual trigger only: shared CI runners are too noisy to gate PRs on).

| env | default | meaning |
| --- | --- | --- |
| `DURATION` / `WARMUP` | 8 / 2 | seconds measured / warm-up per scenario and target |
| `CONNECTIONS` | 32 | concurrent HTTP connections from the load generator ([autocannon](https://github.com/mcollina/autocannon)) |
| `POOL` | 10 | database connections per server (`db-pool` for PostgREST) |
| `CLIENTS` / `ORDERS` / `PRODUCTS` | 20000 / 100000 / 1000 | data volume |
| `TARGETS` | `postgrest,pg-rest-bun,pg-rest-bun-compiled,pg-rest-bun-bytecode,pg-rest-bun-aot,pg-rest-node` | which servers to run. The three `pg-rest-bun-*` executables are the Bun server built with `bun build --compile`, `... --bytecode`, and `bun compile` (experimental AOT) |
| `AOT_BUN` | the running `bun` | path to a Bun that has the `bun compile` command (stable 1.4.4 does not; the canary does) |
| `BASELINE_DIR` | unset | another built checkout of this repo; adds a `baseline` target running its `bench/servers/bun.ts` (to compare two versions of pg-rest) |
| `ONLY` | all | comma-separated scenario names (see `scenarios.ts`) |
| `VERBOSE` | off | print the diverging bodies when results differ |
| `KEEP` | off | keep the benchmark database |

## What it does

1. Loads `tests/support/fixture.sql` plus bulk data (`bench/data.sql`) and starts each server on its own port.
2. **Checks that every target returns the same status and JSON body for every read scenario.** Timing different work would be meaningless, so a mismatch is flagged with ⚠ in the report.
3. For every scenario, warms up, then measures each target back to back (rotating the order to avoid order bias).
4. Reports requests/second, p50/p99 latency and peak memory, and writes the setup (CPU, data volume, versions) next to the numbers.

## How to read the numbers

- **Compare ratios, not absolute values.** Everything shares one machine: the load generator, the servers and PostgreSQL compete for the same cores.
  On a machine with few cores the database and the load generator are the bottleneck, which hides differences between servers. Run it on hardware like yours.
- **Authentication is not the same work.** PostgREST verifies an HS256 JWT on every request; the pg-rest servers read a header, because choosing the
  caller is the library consumer's job (a real application would do its own session lookup, which costs something too). The authenticated scenarios
  (`auth-read-rls`, `insert`, `update-pk`) therefore favour pg-rest slightly. The anonymous scenarios are the cleanest comparison.
- **HTTP layers differ.** PostgREST ships Warp (Haskell); pg-rest is only a handler, so its numbers include whichever server you put in front
  (here `Bun.serve`, and `@hono/node-server` on Node). That is the real cost of using the library, but it is not pg-rest alone.
- **Single run, no confidence intervals.** Expect a few percent of noise between runs; differences smaller than ~10% are not meaningful.
- Writes (`insert`, `update-pk`) are not compared for equality and are committed, so the data grows during the run.

## Results of one run

Run on a small 2-vCPU sandbox (see *Setup* at the end); every read scenario returned identical results from all three servers.
Treat these as indicative, and run the benchmark on your own hardware before drawing conclusions.

### Throughput (requests/second, higher is better)

| scenario | what | PostgREST 16 | pg-rest (Bun + Bun.sql) | vs PostgREST | pg-rest (Node + pg) | vs PostgREST |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| pk-lookup | one row by primary key | 3393 | 3113 | 0.92× | 2503 | 0.74× |
| list-50 | 50 rows, 3 columns, ordered | 2527 | 3264 | 1.29× | 2365 | 0.94× |
| filter-index | two filters on an indexed pair, 20 rows | 2237 | 2917 | 1.30× | 2203 | 0.99× |
| search-ilike | ilike over 20k rows (seq scan), 20 rows | 2125 | 2429 | 1.14× | 1947 | 0.92× |
| embed-to-one | many-to-one embed, 50 rows | 1508 | 1895 | 1.26× | 1640 | 1.09× |
| embed-to-many | one-to-many embed, 20 parents | 1498 | 1916 | 1.28× | 1553 | 1.04× |
| embed-nested-m2m | orders -> items -> products, 20 rows | 327 | 1820 | 5.56× | 1461 | 4.46× |
| count-exact | page of 10 + exact count over 100k rows | 431 | 520 | 1.21× | 501 | 1.16× |
| aggregate | group by + sum/count over 100k rows | 58.9 | 108 | 1.84× | 107 | 1.81× |
| rpc-scalar | scalar function | 3705 | 4634 | 1.25× | 2136 | 0.58× |
| rpc-set | set-returning function, 20 rows | 2381 | 3643 | 1.53× | 1954 | 0.82× |
| auth-read-rls | authenticated read under RLS | 3023 | 2863 | 0.95× | 2318 | 0.77× |
| insert | single-row insert, authenticated | 3454 | 4676 | 1.35× | 2218 | 0.64× |
| update-pk | update one row by primary key, authenticated | 1523 | 2968 | 1.95× | 1484 | 0.97× |

### Latency (ms, p50 / p99, lower is better)

| scenario | PostgREST 16 | pg-rest (Bun + Bun.sql) | pg-rest (Node + pg) |
| --- | ---: | ---: | ---: |
| pk-lookup | 8 / 22 | 9 / 19 | 12 / 26 |
| list-50 | 11 / 31 | 9 / 19 | 12 / 24 |
| filter-index | 13 / 37 | 10 / 20 | 14 / 26 |
| search-ilike | 13 / 40 | 12 / 25 | 15 / 30 |
| embed-to-one | 19 / 58 | 16 / 29 | 18 / 34 |
| embed-to-many | 18 / 60 | 16 / 29 | 19 / 40 |
| embed-nested-m2m | 74 / 355 | 17 / 29 | 21 / 39 |
| count-exact | 59 / 264 | 60 / 87 | 62 / 94 |
| aggregate | 408 / 1684 | 287 / 382 | 295 / 383 |
| rpc-scalar | 8 / 20 | 6 / 14 | 14 / 26 |
| rpc-set | 12 / 34 | 8 / 18 | 15 / 29 |
| auth-read-rls | 9 / 28 | 10 / 21 | 13 / 25 |
| insert | 8 / 23 | 6 / 14 | 13 / 26 |
| update-pk | 16 / 81 | 10 / 24 | 20 / 39 |

### Peak memory (RSS, MB)

- PostgREST 16: 43.0
- pg-rest (Bun + Bun.sql): 94.2
- pg-rest (Node + pg): 215

### Setup

- 2 × Intel(R) Xeon(R) Processor @ 2.10GHz, 7.8 GiB RAM (load generator, servers and PostgreSQL share this machine)
- 32 concurrent connections, 8s per run after 2s warm-up, pool of 10 database connections per server
- data: 20000 clients, 100000 orders, 1000 products
- Bun 1.4.4, Node v22.23.4
- ⚠ next to a scenario: the targets returned different results, or some responses were not 2xx

### Reading this run

- **pg-rest on Bun is faster than PostgREST in 12 of 14 scenarios** (1.14–1.55× for most reads; 1.95× for `update-pk`), with two small exceptions on the simplest
  queries, `pk-lookup` (0.92×) and `auth-read-rls` (0.95×), where per-request overhead dominates and the difference is close to the noise.
- **Nested and aggregate queries differ the most:** `embed-nested-m2m` (4.5–5.6×) and `aggregate` (about 1.8×). Results were verified identical, so
  this is the same work done faster; I have not investigated why (it is likely down to the SQL each one generates), so don't treat it as a guarantee for your queries.
- **pg-rest on Node with `pg` is about even with PostgREST on heavier queries but slower on the cheapest ones** (`rpc-scalar` 0.58×, `insert` 0.64×).
  That includes the `@hono/node-server` adapter and node-postgres; the cheaper the query, the more the fixed per-request cost shows.
- **Memory:** PostgREST uses less (about 43 MB, against 94 MB for Bun and 215 MB for Node in this run).
- p99 latency was lower for pg-rest on Bun than for PostgREST in all 14 scenarios, but with 2 shared cores the tails partly reflect CPU contention, so I would not read much into them.
