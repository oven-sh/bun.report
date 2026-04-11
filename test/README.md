# Stack-trace tests

Snapshot tests for the bun.report trace pipeline. Two layers, both fixture-driven:

| layer | input fixture | what it locks |
|---|---|---|
| `parse.test.ts` | `fixtures/parse/*.json` — `{description, input}` where `input` is a raw trace string/URL | URL → `Parse`: VLQ addresses, platform, features, reason decoding |
| `symbolize.test.ts` | `fixtures/symbolize/*.json` — `{description, os, addresses, stdout}` where `stdout` is recorded symbolizer output | symbolizer stdout → `Address[]`: function-name cleaning, path normalization, frame filtering, frame **order** |

Expected output lives in `__snapshots__/`. Fixtures hold inputs only.

## Scope

v1 and v2 trace formats only. v3 has not shipped; do not add v3 fixtures.

## Adding a fixture

### From a real crash URL (preferred)

```sh
bun scripts/capture-fixture.ts <name> '<bun.report URL or trace string>' [--symbolize]
bun test --update-snapshots
```

`--symbolize` resolves the commit, downloads debug info, runs the real
`llvm-symbolizer` / `pdb-addr2line`, and records its stdout. **Review the new
snapshot by hand once** — that review is what certifies "these lines are
correct." After that the snapshot guards against regression.

### Regenerating constructed seed fixtures

```sh
bun scripts/seed-parse-fixtures.ts
```

These are synthetic inputs that cover the platform × trace-version matrix.
They prove decoding is stable, not that any specific build's symbols are
accurate.

## When a snapshot fails

A failing snapshot means behavior changed. If the change is intentional (e.g.
inline-frame support landed), inspect the diff and run `bun test
--update-snapshots`. If it's not intentional, you found a regression.
