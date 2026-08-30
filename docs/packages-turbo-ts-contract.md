# Turbo TS Package Contract

## Package Boundary

`packages/turbo-ts` owns the private `@delino/turbo-ts@0.1.0` package and the
`turbo-ts` executable. It targets Node.js 24, builds ESM with `tsc`, and does
not replace the repository's official `turbo@2.10.12` tooling.

The executable's version output is exactly:

```text
turbo-ts 0.1.0 (compatible with turbo 2.10.12)
```

The only supported package exports are generated named configuration types and
the distributed `schema.json`. Internal CLI, graph, scheduler, cache, process,
and protocol modules are not stable APIs.
The named configuration surface includes `TagRules`, synchronized with the
authoritative `TagRulesSchema` and distributed `TagRules` definition.

## Clean-Room Compatibility

The package targets the black-box behavior of Turborepo `v2.10.12` at commit
`53752d452049bdda47698354b16a83d7ce92ced0`. Upstream source, tests, fixtures,
and diffs are prohibited. Public documentation, distributed schemas and type
artifacts, independently authored fixtures, and external oracle executions are
allowed. This restriction is policy-only and does not require attestations.

The compatibility ledger is the exhaustive inventory of commands, options,
environment variables, configuration, protocols, package managers, success
paths, and failures. A row can be marked passing only with automated evidence.
Normalizers are limited to approved compatibility differences or repeated-run
evidence of reference nondeterminism. Gate 1 approves branding and version
normalization only for exact CLI identity and version diagnostics; arbitrary
output and paths are not rewritten. Path normalization remains disabled until
supported by repeated black-box evidence.

## Runtime and Architecture

Every effectful boundary uses Effect services and Layers. Scoped resources use
acquisition and finalization, concurrent work uses fibers and interruption, and
transient idempotent failures use typed retry schedules. Errors are tagged and
schema validated. Deterministic parsing, comparison, normalization,
serialization, and generation remain pure.

Runtime dependencies must be pure JavaScript. Native development dependencies
required by TypeScript and Rstest and the native official Turbo oracle are
explicit exceptions; they are never part of the `turbo-ts` production closure.
No additional parsing or protocol dependency may be added unless it is pure
JavaScript and exact-pinned.

Effect Schema is authoritative for runtime configuration validation and for
the generated named types and `schema.json`. Runtime-only hidden configuration
remains internal. Generated artifacts must pass byte-for-byte synchronization
checks. The runtime `Schema` type preserves the complete nondiscriminated
distributed configuration shape, while `RootSchema` and `WorkspaceSchema`
remain narrower named projections.

## Compatibility Gate Status

Gate 1 establishes identity, version behavior, schemas and types, Effect
boundaries, the external oracle, synthetic fixtures, mock hosted services,
normalizers, nondeterminism evidence, and the exhaustive ledger.

Gate 2 work implements root and package JSON/JSONC configuration, inheritance,
repository and lockfile discovery, package and task graphs, filters, affected
selection, Git-compatible file hashing, environment selection, framework
inference, scheduling, subprocess cleanup, `run`, implicit task invocation,
and local and remote cache archives. npm, pnpm, Yarn Classic and Berry/PnP,
Bun, Aube, Nub, Cargo, and uv identities are represented by the repository
model. Gate 2 cache archives and Vercel-compatible artifact transport are
tested bidirectionally against the external official binary when addressed by
an oracle-provided hash.

Gate 2 selection resolves package-qualified tasks and explicit Git ranges,
fails closed when explicit revisions are invalid, applies ordered workspace
exclusions and brace/class-aware globs, and discovers the owning repository
from nested working directories. Task-input selection and hashes include `with`
companions. Task hashes preserve Git symlink and dependency semantics, exclude
the resolved cache directory, and use each task's owning ecosystem lockfile.
Scheduled `with` groups preserve internal dependency order.

Workspace task overrides merge with their effective package-qualified root
definition and the merged task invariants are revalidated before execution.
Cache policy values use comma-separated `(local|remote):(r|w|rw)` entries and
reject malformed entries. Companion task hashes participate in the owning
task's cache key. Local age eviction runs before cache restoration, and cache
archives use PAX extensions for paths beyond ustar limits. Standalone uv tasks
execute from their project directory. Unfiltered Cargo `test`, `check`, `lint`,
and `format` tasks execute once per Cargo workspace; filtered and
package-qualified runs retain package targeting. Cargo builds with pass-through
arguments that select an alternate output layout bypass caching until those
layouts are modeled explicitly.

Gate 2 is not closed: the composed task-hash serializer does not yet reproduce
the official 2.10.12 task hashes. Individual source-file hashes match Git and
the oracle, but the official binary does not distribute the serialization
contract that combines global and task inputs. End-to-end cache-key
interoperability therefore remains planned; archive and HTTP interoperability
must not be presented as evidence that task hashes match.
Structured `dependencyOutputs` task inputs are rejected during configuration
validation until their dependency graph and output-hash semantics are
implemented; they are never treated as ordinary local globs.

Only Gate 2 behavior with automated ledger evidence is a compatibility claim.
Gate 3 through Gate 5 commands, UI and profile formats, daemon/watch/query
protocols, hosted authentication workflows, and platform matrices remain
planned.

The approved compatibility differences are branding and version, Node-only
distribution, hosted identity, default-disabled updates, V8 heap/trace output,
no internal LSP or embedded sccache dispatch, an unsupported error for
`experimentalCargoSccache`, Node's documented Windows signal limitation,
visibility-only benchmarks, and manual ARM64 smoke testing.

`futureFlags.experimentalCargoSccache: true` is rejected immediately after
configuration resolution and before repository discovery, cache access,
network requests, or task execution. Schema-hidden and deprecated runtime
configuration stays internal and does not change the distributed schema or
generated public types.

## Operations and Maintenance

The package is repository-only and must not be published or deployed. Opt-in
invocation keeps official Turbo available side by side. Rollback is stopping
`turbo-ts` invocation; there is no migration or cleanup because implemented
and later gates preserve official shared-state formats.

Package validation consists of lint, type-check, Rstest, build, generated-file
verification, production dependency auditing, and repository `pnpm check`.
