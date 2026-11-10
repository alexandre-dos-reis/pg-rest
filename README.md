# tspg

Sharp TypeScript tools for Postgres

| package                                       | what it is                                                                                                       |                                                  |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **[`@tspg/rest`](packages/rest/README.md)**   | **PostgREST as a library.** `handle(Request) => Promise<Response>`, using web-standard `Request` and `Response`. | [npm](https://www.npmjs.com/package/@tspg/rest)  |
| **[`@tspg/query`](packages/query/README.md)** | **Postgres type-safe query client.** `select()`, `insert()`, `update()`…                                         | [npm](https://www.npmjs.com/package/@tspg/query) |

## Documentation

Each package's README is the short version. Beyond them:

| | |
| --- | --- |
| [`docs/query.md`](docs/query.md) | the operations, with an example for every field |
| [`docs/types.md`](docs/types.md) | generating types, the typed instance, and what it cannot describe |
| [`docs/options.md`](docs/options.md) | every `createRest` and `createQuery` option, and what they give back |
| [`docs/adapters.md`](docs/adapters.md) | `DbAdapter`, the four that ship, and writing your own |
| [`docs/architecture.md`](docs/architecture.md) | how a request becomes SQL, and where each piece lives |
| [`docs/security.md`](docs/security.md) | the role and RLS model, and how request values reach SQL |
| [`docs/design.md`](docs/design.md) | what it does, and what it will never do because it is a library |
| [`docs/proposals.md`](docs/proposals.md) | the additions under consideration, and what each would cost |
| [`docs/performance.md`](docs/performance.md) | measured against PostgREST 16, and which runtime to pick |
| [`docs/development.md`](docs/development.md) | running the tests, the examples and the differential suite |
| [`packages/rest/PARITY.md`](packages/rest/PARITY.md) | PostgREST v16 feature by feature |

Runnable projects, one folder per package, in [`examples/`](examples).
