# `@delino/turbo-ts`

Private, clean-room TypeScript and Effect compatibility implementation targeting
Turborepo 2.10.12.

> `turbo-ts` is an unofficial independent implementation. It is not affiliated
> with, maintained by, or endorsed by Vercel.

## Status

Compatibility Gate 1 and substantial Gate 2 surfaces are implemented. In
addition to the identity,
schema, Effect, oracle, fixture, hosted-mock, normalizer, and ledger foundation,
`turbo-ts` now models JavaScript, Cargo, and uv workspaces; loads root and
package JSON/JSONC configuration; builds package and task graphs; selects
filters and affected packages; executes explicit or implicit tasks; controls
task environments and concurrency; and reads and writes compatible local and
remote cache archives. Only passing automated ledger rows are compatibility
claims; later commands and protocols remain planned. Gate 2 is not closed
because the independent composed task-hash serializer does not yet match the
official 2.10.12 keys. The bidirectional cache tests prove archive and artifact
transport compatibility using oracle-provided hashes, not end-to-end cache-key
identity.

Official `turbo@2.10.12` remains the repository task runner and black-box test
oracle. No upstream source, tests, fixtures, or diffs are included.

## Usage

```bash
pnpm --filter @delino/turbo-ts build
pnpm exec turbo --version
pnpm exec turbo-ts --version
pnpm exec turbo-ts run build
pnpm exec turbo-ts build --filter=@scope/package
```

The expected output is:

```text
turbo-ts 0.1.0 (compatible with turbo 2.10.12)
```

The package is private and must not be published or deployed. Its only supported
module exports are generated configuration types and `./schema.json`; internal
services and algorithms may change between repository revisions.

## Validation

```bash
pnpm --filter @delino/turbo-ts lint
pnpm --filter @delino/turbo-ts type-check
pnpm --filter @delino/turbo-ts test
pnpm --filter @delino/turbo-ts build
pnpm --filter @delino/turbo-ts check:generated
pnpm --filter @delino/turbo-ts check:runtime-dependencies
```

The tests use only independently authored fixtures and external black-box
executions. Mock hosted services bind to loopback addresses and tests use dummy
credentials. Tokens, unrestricted environments, and task payloads must never be
written to logs or committed evidence.

The core suite includes bidirectional official/Turbo TS local and remote cache
archive consumption, malformed configuration and lockfiles, graph failures,
filters and environments, process interruption, corrupt caches, traversal and
symlink attacks, signatures, command-injection arguments, and concurrent cache
writers. `futureFlags.experimentalCargoSccache: true` always fails before task
execution with a branded unsupported-compatibility diagnostic.

Cargo builds that receive pass-through arguments selecting release, profile,
target, or another alternate artifact layout execute without cache reads or
writes until those output layouts are modeled explicitly.

## License and Attribution

The independent implementation is available under the Delino MIT license in
`LICENSE`. Turborepo's separate MIT attribution is retained in
`UPSTREAM-LICENSE`.
