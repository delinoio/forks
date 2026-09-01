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

JavaScript `file:`, `link:`, and relative pnpm `workspace:` dependencies resolve
to discovered packages by canonical filesystem identity. A local path that
does not resolve to a discovered JavaScript package disables caching for the
declaring package and downstream hash scopes.

Cargo builds that receive pass-through arguments selecting another package,
release, profile, target, another manifest or alternate artifact layout, or an
unmodeled library, binary, example, test, or benchmark target execute without
cache reads or writes until those outputs are modeled explicitly. Pass-through
`--config` arguments and mismatched metadata/task `CARGO_TARGET_DIR` values also
disable Cargo build caching. Any effective Cargo-home configuration also
disables cacheable Cargo compilation tasks because those external controls are
not task-hash inputs. Mixed library and binary crates default to uncached
because binary-only output declarations cannot restore all of Cargo's default
artifacts. Source-free local path dependencies that do not resolve to a
same-workspace repository package also disable caching. Synthesized binary
outputs cover the extensionless executable plus `.exe` and `.pdb` variants.
Single-binary Cargo `run` and `dev` tasks also default to uncached
unless task configuration explicitly enables caching. Repository-root Cargo
packages reuse the loaded root task configuration. Unfiltered Cargo workspace
commands merge the effective environments of every grouped member and remain
package-scoped when any repository member excludes the requested verification
task.

Local and remote cache restoration is limited to 256 MiB compressed and 1 GiB
after decompression. Artifacts beyond either limit are rejected; invalid local
entries are removed with a warning and become misses, while remote entries use
the normal local-execution fallback. Existing-output scan failures likewise
warn and execute the task locally without cache reads. Decompressed archives
are parsed from scoped temporary storage, and cache writes independently limit
file content and tar metadata overhead to 64 MiB each. Cache publication is
serialized within a run to bound writer memory independently of task
concurrency. Remote downloads, signature verification, and decompression use
scoped files so concurrent cache hits do not retain or duplicate complete
compressed response bodies in memory.

Configured cache directories may be inside or outside the repository, but the
repository root, its ancestors, and directories containing discovered packages
are rejected because treating them as cache content would exclude source files
from task hashes. Explicit `dist/**` and `target/**` task inputs remain hashable
when Git metadata is unavailable.

uv task hashes always include the owning `pyproject.toml`. Explicitly cached uv
builds using `--out-dir` and uv packages with unresolved external editable path
dependencies bypass cache reads and writes until those inputs and outputs are
modeled.

## License and Attribution

The independent implementation is available under the Delino MIT license in
`LICENSE`. Turborepo's separate MIT attribution is retained in
`UPSTREAM-LICENSE`.
