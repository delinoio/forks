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
workspaces. An existing pnpm workspace file never falls back to `package.json`:
an absent `packages` declaration selects no JavaScript workspace members, and
an invalid declaration fails discovery. Declared workspace members remain
discoverable beneath directories named `dist` or `target`. JavaScript workspace
traversal prunes subtrees that cannot match a positive workspace pattern before
listing them; ordered exclusions are applied to the resulting candidates.
Matching directory symlinks are traversed by their declared logical path only
when their canonical target is a directory inside the repository; canonical
ancestor tracking prevents symlink cycles.
Git changes beneath a contained workspace symlink's canonical target map back
to that workspace for package and task-aware affected selection.
Tasks owned by a logical workspace path containing a symlink component execute
without local or remote caching because restoration intentionally rejects
symlink parents. Task scopes whose hashes depend on those tasks, including
`with` companions, also bypass caching transitively.
Every requested task
must resolve before any task executes, and
strict entrypoint selection removes configured tasks without an executable
package script even when every selected entrypoint is commandless. Every
explicit `with` reference must resolve to an existing package task before its
owner can execute. Requested task names are validated after ordinary package
filters but before Git-range and affected filters are applied, so a valid task
with no affected packages is a successful no-op. An explicit `--cwd` must exist
and resolve to a directory before nested repository discovery begins from its
canonical target, including when the requested path is a symlink.
Task-aware Git selectors retain union semantics with positive package
selectors; negative Git selectors are applied after that union.
Package-level affected selection treats legacy `globalDependencies` and, when
task-aware selection is disabled, `global.inputs` as repository-global inputs.
Task-input selection uses the same effective global and task inputs as hashing,
evaluates task owners before Git-range package narrowing, applies negative Git
ranges after positive task matches, and includes `with` companions. Owning
manifests and package task configurations participate in task-aware selection
independently of user input globs. Owning lockfiles and Cargo control or
toolchain files participate in both task-aware selection and hashing. A changed
workspace gitlink path is treated as the package-relative `.` input. Task
hashes preserve Git symlink, gitlink, and dependency semantics, exclude the
resolved cache directory, and use each task's owning ecosystem lockfile.
Only indexed mode `160000` directories are hashed as gitlinks; an indexed
regular file replaced by a working-tree directory is omitted while its
discovered descendants remain task inputs.
Regular input files are streamed through bounded-memory Git blob digests, and
owning lockfiles are streamed through bounded-memory xxHash64 digests.
NUL-delimited Git discovery output is consumed as bytes and filenames that are
not valid UTF-8 fail affected selection and hashing instead of being silently
omitted. Git-discovered POSIX filenames preserve literal backslashes as
filename characters. Cargo
task hashes additionally include repository-contained
ancestor manifests, Cargo configuration, and Rust toolchain files that can
change task execution. Environment-name selection follows Windows
case-insensitive semantics for both hashing and strict task execution.
Repository discovery records the resolved root lockfile path without
structurally parsing it;
lockfile parsing and pruning remain Gate 3 work. Without Git, explicit task
inputs under ordinary `dist` and `target` directories remain hashable.
Cache directories equal to or containing the repository are rejected by
canonical filesystem location before cache access, including through symlinks.
Scheduled `with` groups preserve internal dependency order and share one
run-wide foreground concurrency budget. Simultaneously ready non-persistent
companions acquire foreground permits as an indivisible cohort, and a
concurrency limit that cannot fit the cohort is rejected. Ready groups are
refilled as individual groups finish rather than waiting for a whole scheduling
wave. Foreground owners wait until their complete non-persistent companion
cohort is dependency-ready; prerequisite companions may run first to unlock
the cohort. All non-interactive task output streams to the task log through
bounded backpressure while retaining only a bounded diagnostic tail and
incomplete display line in memory.
Persistent companions must remain alive until their foreground owners
complete; any earlier natural exit fails the group, and foreground owners
sharing a companion remain subject to the run's concurrency limit.
Persistent task scopes always bypass local and remote caching, regardless of
their configured cache value.
On Windows, npm, pnpm, and Yarn task commands use their standard command shims
through a narrowly escaped command-interpreter adapter; POSIX task execution
does not use a shell. Scope finalization terminates the Windows wrapper and its
descendant process tree.

Workspace task overrides merge with their effective package-qualified root
definition and the merged task invariants are revalidated before execution.
Task-level `extends: false` is package-only: without other fields it removes
the inherited task, including synthesized Cargo and uv tasks, while additional
fields create a fresh definition without root-task inheritance.
Workspace configuration inheritance accepts only the exact `["//"]` parent
list.
Cache policy values use comma-separated `(local|remote):(r|w|rw)` entries and
reject malformed entries. Remote artifact routes preserve configured API path
prefixes. Active remote URLs must use HTTP or HTTPS, and URLs and timeout values
are validated before cache or task work begins. Signature-key requirements
apply only when a remote transport is active; disabled remotes and
configurations without an API URL do not require a signing key. Every active
signed remote requires a non-empty key, while the 32-character minimum applies
only when `futureFlags.longerSignatureKey` is enabled. Local and remote
restoration failures warn and fall back to task execution, except that a failed
restoration rollback aborts execution. Failure to enumerate existing outputs
while preparing restoration warns, disables local and remote reads for that
task scope, and executes the task locally. Local cache write and remote upload
failures warn without changing a successful task outcome, and a local failure
does not suppress a configured remote upload. Local and remote cache restoration
is limited to 256 MiB compressed and 1 GiB after decompression; preflight and
upload response bodies have an independent 64 KiB limit.
Restored task logs replay through scoped, bounded text chunks with terminal
backpressure instead of loading the complete log into another string. A task-log
replay I/O failure warns without changing the successful cache-hit outcome.
Local cache artifacts are streamed from their compressed files into scoped
temporary storage. Local and remote archives are decompressed there, and
regular-file payloads are restored through bounded range copies instead of
materializing the complete decompressed archive in memory. PAX metadata is
limited to 64 KiB per extended header, and cumulative tar headers, padding, and
PAX metadata are limited to 64 MiB while parsing. Temporary archive cleanup is
part of the restoration transaction, so cleanup failures roll back installed
outputs before task execution falls back.
Remote artifact response bodies are streamed directly into scoped temporary
storage; signature verification and decompression consume the compressed file
without materializing or duplicating the complete response in memory.
Cache restoration validates every archive entry against the current task's
declared output globs or exact literal log path before clearing or writing
files. It rejects duplicate destinations and any non-directory archive entry
that is an ancestor of another destination. Output negations are deny rules
during both collection and restoration, regardless of their order relative to
positive patterns. Task identifiers are
encoded into portable single-component log filenames; lowercase portable task
names retain their existing filenames, and
uppercase code points are encoded to prevent case-insensitive collisions.
When co-located package scopes share an execution directory and task name, the
encoded package-qualified task identifier keeps their logs and cached replay
separate.
Encoded names that would exceed a 255-byte filename component retain a bounded
encoded prefix and append a deterministic task-name hash.
Restoration rejects symlink parents even when their targets remain inside the
repository, preventing declared output paths from redirecting writes elsewhere.
Restored symlink targets must remain within the same declared output group that
authorized the symlink path, and every existing target component must resolve
inside the repository without traversing another symlink.
Cache collection applies the same validation before publication, so artifacts
with non-restorable symlink targets are skipped. Restoration rejects duplicate
comparable destinations before clearing outputs, including paths that differ
only by case on case-insensitive target filesystems.
Every archive must contain exactly one regular task-log entry. Cache writes
whose aggregate uncompressed file content exceeds 64 MiB are skipped before
contents are read, with a warning that preserves the successful task result.
Output collection and cache publication are serialized within a run so
concurrent task completion cannot multiply the archive writer's bounded memory
footprint.
Tar headers, padding, PAX metadata, and end markers have an independent 64 MiB
preflight limit that is enforced before archive chunks are constructed.
Companion task hashes participate in the owning task's cache key. Local eviction
accepts week-based ages, runs before cache restoration only when local cache
reads or writes are enabled, and counts archive and sidecar bytes, including
orphaned sidecars. Startup eviction failures warn and continue without making
cache maintenance a prerequisite for task execution. Eviction acquires the
per-entry writer lock before removal so it cannot expose a partially published
entry; selected-entry removal failures are aggregated after all of its archive
and sidecar paths are tried.
Cache archives use PAX
extensions for paths beyond ustar limits. Tar header paths, link targets, and
PAX metadata must be valid UTF-8; unsupported raw-byte names reject the
artifact. Interrupted or failed atomic writes attempt to remove their temporary
files. An atomic-write cleanup failure is surfaced as a local cache
write failure, including when the write or rename also failed. A cache
writer-lock release failure is likewise surfaced and preserves any preceding
write or eviction failure.
Archives preserve empty declared output directories. Failed restoration removes
every partially restored output before local execution, and rollback failure
aborts execution instead of exposing partial cache state.
Failure to remove the corrupt cache entry does not downgrade a restoration
rollback failure to an ordinary cache miss.
Regular archive destinations are unlinked before their contents are restored,
so an existing hard link cannot redirect truncation outside the repository.
Resolved cache-directory subtrees are excluded from both task inputs and task
outputs, including custom cache directory names selected by broad output globs.
Cache output collection prunes directory subtrees that cannot match a positive
output pattern, while matching patterns may explicitly retain `node_modules`
or other normally ignored directories.
uv packages are discovered from the root
`pyproject.toml` workspace root and member globs after applying workspace
exclusions; unrelated Python projects and `.venv` trees are ignored.
Synthesized uv packages
expose `build` and `test`, and implicit builds default to uncached unless task
configuration explicitly enables caching. uv tasks execute from their project
directory, forward test arguments directly to `pytest`, and parse `uv.lock` as
TOML. uv package-graph edges require a
matching `tool.uv.sources` workspace declaration or local path resolving to the
named workspace member by canonical, platform-aware filesystem identity;
registry, Git, URL, and undeclared sources remain
external. JavaScript package-graph edges
require declared workspace or version-range compatibility, or a `file:` or
`link:` path whose canonical, platform-aware filesystem identity resolves to
the local JavaScript package. Local path aliases record the resolved package's
actual name even when the dependency key differs. pnpm workspace aliases
resolve to the package name encoded in their `workspace:` specification;
same-named Cargo and uv packages are never JavaScript workspace targets. Cargo metadata
paths are matched by canonical filesystem identity. Repository-root Cargo
packages reuse the loaded root task configuration instead of interpreting it as
a workspace configuration. Unfiltered Cargo `test`,
`check`, `lint`, and `format` tasks execute once per Cargo workspace and bypass
caching when any grouped member disables it; filtered and package-qualified
runs retain package targeting. A workspace is grouped only when every
repository-contained member exposes the requested verification task; otherwise
participating members retain package targeting so task exclusions are honored.
Members of an enclosing Cargo workspace outside
the repository always retain package targeting and bypass caching, as do task
scopes whose hashes depend on them, because their external Cargo controls are
not repository hash inputs. Cargo packages with source-free local path
dependencies that do not resolve to a same-workspace repository package also
bypass caching. Grouped Cargo commands receive
the union of all member task environments. Cargo package-graph edges require a
source-free metadata dependency path that resolves to the named member in the
same workspace; registry and Git dependencies remain external. Cargo `run` and
`dev` tasks are exposed only for crates with one unambiguous binary target, and
default to uncached unless task configuration explicitly enables caching.
Pass-through arguments are forwarded to Cargo without an implicit
target-argument separator. Cargo builds
for mixed library and binary crates default to uncached. Builds with
pass-through arguments that select an additional package, an alternate output
layout or manifest, or an unmodeled library, binary, example, test, or benchmark
target bypass caching until those outputs are modeled explicitly. The
additional-package selectors include `--workspace` and `--all`. Cargo build
pass-through `--config` arguments also bypass caching because they can override
the output layout. Cargo builds also bypass caching when any effective
Cargo-home configuration is present because those external controls are not
hashed. Ancestor configuration or the effective task environment setting a
build target, or different `CARGO_TARGET_DIR` values for Cargo metadata and
strict task execution, likewise bypass caching. Cargo metadata discovery uses
`--locked`, uses each response's workspace-member list, and does not probe
excluded or unrelated nested manifests. Combined workspace task
hashes are propagated into every downstream task hash.
Cargo builds with colliding synthesized binary destinations bypass caching,
including when task configuration explicitly enables it.
Synthesized Cargo binary outputs cover the extensionless executable plus
`.exe` and `.pdb` variants.

Structured task input globs apply ordered inclusion and negation consistently
to task hashing and task-aware affected selection. Task-aware Git filters
preserve leading and trailing ellipses and traverse both task and package graphs
in the requested dependent or dependency direction. Filters requesting both
directions compute each closure from the original matches before unioning them.
Ordinary root-file changes
select only tasks whose effective inputs match them; repository-global inputs
and Git discovery failures retain the all-task fallback.
Changes to the loaded root task configuration select all requested task
entrypoints under task-aware affected and Git-range filtering.

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
