# pg-rest

## 0.1.3

### Patch Changes

- d870849: fix package name ref is docs and examples

## 0.1.2

### Patch Changes

- 4de8a7d: confirm github and npm trust

## 0.1.1

### Patch Changes

- confirm trust between github and npm

## 0.1.0

### Minor Changes

- 5b2f874: First release. A PostgREST-compatible REST layer for PostgreSQL, used as a library: you hand
  `createPgRest` a `DbAdapter` over your own driver (Bun.sql, node-postgres, postgres.js, PGlite) and
  mount `handle(Request) => Response` in any web-standard server. There is no JWT layer — `resolveContext`
  decides who is calling, and Row Level Security does the rest.

  Request/response behaviour is compared against the real PostgREST 16 binary on the same database: of
  339 cases, 338 match byte-for-byte and one differs on purpose (cast targets outside a strict allowlist
  are rejected up front rather than forwarded to PostgreSQL). See PARITY.md.
