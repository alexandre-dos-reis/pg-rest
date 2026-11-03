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

Run on a small 2-vCPU sandbox (see *Setup* at the end), with the load generator, the servers and PostgreSQL sharing the same two cores. Every read scenario
returned identical results from all servers. Treat the numbers as indicative, and run the benchmark on your own hardware before drawing conclusions.

Columns are, in order: PostgREST 16; pg-rest on Bun; the same server compiled with `bun build --compile`; with `--compile --bytecode`; with `bun compile`
(experimental AOT, a canary Bun, since stable 1.4.4 ignores `--aot`); the previous pg-rest build that still used Effect (*baseline*); pg-rest on Node + `pg`.

### Throughput (requests/second, higher is better)

| scenario | what | PostgREST 16 | pg-rest (Bun + Bun.sql) | vs PostgREST | pg-rest (bun build --compile) | vs PostgREST | pg-rest (bun build --compile --bytecode) | vs PostgREST | pg-rest (bun compile, AOT) | vs PostgREST | pg-rest baseline (Bun) | vs PostgREST | pg-rest (Node + pg) | vs PostgREST |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pk-lookup | one row by primary key | 3693 | 3540 | 0.96× | 3908 | 1.06× | 3844 | 1.04× | 3651 | 0.99× | 3508 | 0.95× | 2899 | 0.79× |
| list-50 | 50 rows, 3 columns, ordered | 2742 | 3655 | 1.33× | 3581 | 1.31× | 3856 | 1.41× | 3513 | 1.28× | 3387 | 1.24× | 2867 | 1.05× |
| filter-index | two filters on an indexed pair, 20 rows | 2366 | 3106 | 1.31× | 3311 | 1.40× | 3400 | 1.44× | 3336 | 1.41× | 3126 | 1.32× | 2750 | 1.16× |
| search-ilike | ilike over 20k rows (seq scan), 20 rows | 2498 | 3484 | 1.39× | 3377 | 1.35× | 3102 | 1.24× | 3274 | 1.31× | 3244 | 1.30× | 2689 | 1.08× |
| embed-to-one | many-to-one embed, 50 rows | 1658 | 2218 | 1.34× | 2334 | 1.41× | 2346 | 1.42× | 2397 | 1.45× | 2235 | 1.35× | 1923 | 1.16× |
| embed-to-many | one-to-many embed, 20 parents | 1610 | 2336 | 1.45× | 2332 | 1.45× | 2482 | 1.54× | 2398 | 1.49× | 2143 | 1.33× | 1911 | 1.19× |
| embed-nested-m2m | orders -> items -> products, 20 rows | 385 | 2182 | 5.67× | 2273 | 5.91× | 2349 | 6.10× | 2191 | 5.69× | 2034 | 5.29× | 1894 | 4.92× |
| count-exact | page of 10 + exact count over 100k rows | 466 | 557 | 1.19× | 583 | 1.25× | 587 | 1.26× | 567 | 1.22× | 564 | 1.21× | 537 | 1.15× |
| aggregate | group by + sum/count over 100k rows | 65.0 | 119 | 1.83× | 121 | 1.86× | 128 | 1.97× | 125 | 1.92× | 126 | 1.94× | 124 | 1.90× |
| rpc-scalar | scalar function | 4558 | 6345 | 1.39× | 6214 | 1.36× | 6482 | 1.42× | 5929 | 1.30× | 5317 | 1.17× | 3372 | 0.74× |
| rpc-set | set-returning function, 20 rows | 2896 | 5669 | 1.96× | 5663 | 1.96× | 5351 | 1.85× | 5338 | 1.84× | 5018 | 1.73× | 2697 | 0.93× |
| auth-read-rls | authenticated read under RLS | 3402 | 4404 | 1.29× | 4482 | 1.32× | 4656 | 1.37× | 4106 | 1.21× | 3793 | 1.11× | 3157 | 0.93× |
| insert | single-row insert, authenticated | 4019 | 6703 | 1.67× | 6842 | 1.70× | 7036 | 1.75× | 6877 | 1.71× | 6018 | 1.50× | 3515 | 0.87× |
| update-pk | update one row by primary key, authenticated | 1954 | 4252 | 2.18× | 4098 | 2.10× | 4285 | 2.19× | 4225 | 2.16× | 3684 | 1.89× | 2024 | 1.04× |

### Latency (ms, p50 / p99, lower is better)

| scenario | PostgREST 16 | pg-rest (Bun + Bun.sql) | pg-rest (bun build --compile) | pg-rest (bun build --compile --bytecode) | pg-rest (bun compile, AOT) | pg-rest baseline (Bun) | pg-rest (Node + pg) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| pk-lookup | 7 / 23 | 8 / 18 | 7 / 14 | 7 / 14 | 8 / 16 | 8 / 17 | 10 / 20 |
| list-50 | 10 / 28 | 8 / 16 | 8 / 17 | 8 / 14 | 8 / 16 | 9 / 17 | 10 / 19 |
| filter-index | 12 / 36 | 9 / 17 | 9 / 16 | 9 / 16 | 9 / 18 | 9 / 19 | 11 / 20 |
| search-ilike | 11 / 33 | 8 / 16 | 9 / 18 | 9 / 17 | 9 / 16 | 9 / 18 | 11 / 22 |
| embed-to-one | 17 / 53 | 14 / 23 | 13 / 22 | 13 / 21 | 13 / 22 | 14 / 25 | 16 / 27 |
| embed-to-many | 17 / 55 | 13 / 22 | 13 / 23 | 12 / 22 | 13 / 21 | 14 / 24 | 16 / 25 |
| embed-nested-m2m | 65 / 286 | 14 / 24 | 13 / 23 | 13 / 24 | 14 / 25 | 15 / 27 | 16 / 27 |
| count-exact | 54 / 245 | 56 / 85 | 54 / 79 | 54 / 78 | 55 / 84 | 55 / 84 | 59 / 90 |
| aggregate | 371 / 1511 | 260 / 371 | 257 / 344 | 245 / 325 | 251 / 320 | 251 / 295 | 258 / 295 |
| rpc-scalar | 6 / 19 | 4 / 9 | 4 / 10 | 4 / 11 | 5 / 10 | 5 / 12 | 9 / 16 |
| rpc-set | 10 / 27 | 5 / 10 | 5 / 12 | 5 / 12 | 5 / 11 | 5 / 12 | 11 / 21 |
| auth-read-rls | 8 / 23 | 7 / 12 | 6 / 13 | 6 / 12 | 7 / 13 | 8 / 16 | 9 / 19 |
| insert | 7 / 20 | 4 / 8 | 4 / 8 | 4 / 8 | 4 / 8 | 4 / 11 | 8 / 15 |
| update-pk | 11 / 67 | 7 / 15 | 7 / 16 | 7 / 15 | 7 / 16 | 8 / 19 | 15 / 28 |

### Peak memory (RSS, MB)

- PostgREST 16: 46.8
- pg-rest (Bun + Bun.sql): 79.1
- pg-rest (bun build --compile): 80.8
- pg-rest (bun build --compile --bytecode): 75.7
- pg-rest (bun compile, AOT): 54.2
- pg-rest baseline (Bun): 92.1
- pg-rest (Node + pg): 125

### Setup

- 2 × Intel(R) Xeon(R) Processor @ 2.10GHz, 7.8 GiB RAM (load generator, servers and PostgreSQL share this machine)
- 32 concurrent connections, 8s per run after 2s warm-up, pool of 10 database connections per server
- data: 20000 clients, 100000 orders, 1000 products
- Bun 1.4.4, Node v22.23.4
- ⚠ next to a scenario: the targets returned different results, or some responses were not 2xx

### Reading this run

- **Removing Effect:** pg-rest now has no runtime dependency. Against the Effect-based build (*baseline*) the plain Bun server was 1–19% faster in 13 of 14 scenarios
  (about 8–19% on `list-50`, RPC, `auth-read-rls` and writes) and 6% slower on `aggregate`, which is within noise. Peak RSS under load fell from 92 to 79 MB on Bun.
  Idle RSS, measured separately, fell from about 28 to 22 MB on Bun and stayed around 43 MB on Node.
- **Compiled executables are not meaningfully faster here.** `--compile`, `--bytecode` and `bun compile` land within about ±8% of plain `bun` in every scenario,
  which is within run-to-run noise: the time is spent in PostgreSQL, JSON and the socket, not in JS start-up or tier-up. Bytecode would help cold start, which this
  benchmark does not measure (it warms up first). The AOT build is the exception on memory: **54 MB peak against 79 MB** (47 against 68 MB in the short smoke run).
- **`bun compile --explain`:** the AOT compiler reports that only about 41% of property accesses in the bundle are "free" (typed). Most of the cost comes from
  compiling the *built* `dist/` JavaScript, whose exported functions count as "called by code the compiler can't see". Compiling the TypeScript source of the library
  instead lowers the largest entry from 59% to 19% of the estimated untyped time. That suggests the AOT result could improve if a consumer compiles pg-rest from source
  with tighter types; I have not benchmarked that.
- **pg-rest on Bun vs PostgREST:** at least as fast in 13 of 14 scenarios, 1.2–1.5× for most reads, about 1.9–2.2× for writes and `aggregate`, and 5–6× for
  `embed-nested-m2m`. `pk-lookup` is a tie (0.95–1.06×). Results were verified identical; I did not investigate why the nested embed differs so much (likely the SQL each generates),
  so don't treat it as a guarantee for your queries.
- **pg-rest on Node with `pg` is slower than PostgREST on the cheapest scenarios** (`rpc-scalar` 0.74×, `insert` 0.87×, `pk-lookup` 0.79×) and ahead on heavier ones.
- **Memory:** PostgREST still uses the least (47 MB peak, against 79 MB for Bun and 125 MB for Node).
- p99 latency was lower for pg-rest on Bun than for PostgREST in all 14 scenarios, but with 2 shared cores the tails partly reflect CPU contention.
