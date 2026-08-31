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
fails closed when explicit revisions are invalid, reads workspace declarations
from the resolved JavaScript package manager, applies ordered workspace
exclusions and brace/class-aware globs, and discovers the owning repository
from nested working directories, including explicit `--cwd` values. Only pnpm
uses `pnpm-workspace.yaml`; other JavaScript managers use `package.json`
workspaces. Every requested task must resolve before any task executes, and
strict entrypoint selection removes configured tasks without an executable
package script even when every selected entrypoint is commandless. Every
explicit `with` reference must resolve to an existing package task before its
owner can execute.
Package-level affected selection treats legacy `globalDependencies` and, when
task-aware selection is disabled, `global.inputs` as repository-global inputs.
Task-input selection uses the same effective global and task inputs as hashing,
evaluates task owners before Git-range package narrowing, applies negative Git
ranges after positive task matches, and includes `with` companions. Task hashes
preserve Git symlink and dependency semantics, exclude the resolved cache
directory, and use each task's owning ecosystem lockfile. Repository discovery
records the resolved root lockfile path without structurally parsing it;
lockfile parsing and pruning remain Gate 3 work. Without Git, explicit task
inputs under ordinary `dist` and `target` directories remain hashable.
Cache directories equal to or containing the repository are rejected before
cache access. Scheduled `with` groups preserve internal dependency order and
share one run-wide foreground concurrency budget. Non-interactive persistent
task output streams to the terminal and task log through bounded backpressure
while retaining only a bounded diagnostic tail and incomplete display line in
memory. Persistent companions must remain alive until their foreground owners
complete; any earlier natural exit fails the group, and foreground owners
sharing a companion remain subject to the run's concurrency limit.

Workspace task overrides merge with their effective package-qualified root
definition and the merged task invariants are revalidated before execution.
Workspace configuration inheritance accepts only the exact `["//"]` parent
list.
Cache policy values use comma-separated `(local|remote):(r|w|rw)` entries and
reject malformed entries. Remote artifact routes preserve configured API path
prefixes, remote restoration failures warn and fall back to task execution, and
remote upload failures warn without changing a successful task outcome. Remote
downloads are limited to 256 MiB compressed and 1 GiB after decompression.
Cache restoration validates every archive entry against the current task's
declared output globs or exact log path before clearing or writing files.
Companion task hashes participate in the owning task's cache key. Local eviction
accepts week-based ages, runs before cache restoration only when local cache
reads or writes are enabled, and counts archive and sidecar bytes, including
orphaned sidecars. Cache archives use PAX extensions for paths beyond ustar
limits, and interrupted or failed atomic writes remove their temporary files.
uv packages are discovered from the root
`pyproject.toml` workspace root and member globs after applying workspace
exclusions; unrelated Python projects and `.venv` trees are ignored.
Synthesized uv packages
expose `build` and `test`, and implicit builds default to uncached unless task
configuration explicitly enables caching. uv tasks execute from their project
directory, and `uv.lock` is parsed as TOML. JavaScript package-graph edges
require declared workspace or version-range compatibility, or a `file:` or
`link:` path that resolves to the named local package. Unfiltered Cargo `test`,
`check`, `lint`, and `format` tasks execute once per Cargo workspace and bypass
caching when any grouped member disables it; filtered and package-qualified
runs retain package targeting. Grouped Cargo commands receive the union of all
member task environments. Cargo package-graph edges require a source-free
metadata dependency path that resolves to the named member in the same
workspace; registry and Git dependencies remain external. Cargo `run` and
`dev` tasks are exposed only for binary crates, and pass-through arguments are
forwarded to Cargo without an implicit target-argument separator. Cargo builds
for mixed library and binary crates default to uncached. Builds with
pass-through arguments that select an alternate output layout or an unmodeled
library, binary, example, test, or benchmark target bypass caching until those
outputs are modeled explicitly.

Structured task input globs apply ordered inclusion and negation consistently
to task hashing and task-aware affected selection. Task-aware Git filters
preserve leading and trailing ellipses and traverse both task and package graphs
in the requested dependent or dependency direction. Ordinary root-file changes
select only tasks whose effective inputs match them; repository-global inputs
and Git discovery failures retain the all-task fallback.

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
