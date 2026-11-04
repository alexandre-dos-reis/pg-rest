# Changesets

A changeset is a note, committed with the change itself, saying what the release should do:

```sh
bun run changeset        # pick patch/minor/major, write one line for the CHANGELOG
```

`bun run version` consumes every note here: it bumps `package.json`, rewrites `CHANGELOG.md`, and
points the examples at the new version (they depend on `pg-rest` by version, so they have to move
with it). CI does that for you -- see `.github/workflows/release.yml`.

A change with nothing to release (tests, docs, CI) needs no changeset.
