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
Nested JavaScript root discovery recognizes `npm-shrinkwrap.json` and Yarn PnP
`.pnp.cjs` lockfile markers. When both npm lockfiles exist,
`npm-shrinkwrap.json` takes precedence over `package-lock.json`.
Enabled JavaScript, Cargo, and uv discovery passes operate independently, so a
declared JavaScript workspace may also contain co-located Cargo and uv package
scopes. Package names are unique within an ecosystem but may be shared across
ecosystems. Cross-ecosystem collisions use `javascript:`, `cargo:`, or `uv:`
qualified internal identities; plain name selectors retain all matching
scopes, while a qualified identity selects one scope.
Matching directory symlinks are traversed by their declared logical path only
when their canonical target is a directory inside the repository; canonical
ancestor tracking prevents symlink cycles.
Git changes beneath a contained workspace symlink's canonical target map back
to that workspace for package and task-aware affected selection, including
`ls --affected`. `--single-package` skips child workspace discovery and treats
the repository root as the only runnable package.
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
Repository-root Cargo and uv package scopes do not claim ordinary root files
for package ownership; those changes retain repository-global package-level
affected selection.
Task-input selection uses the same effective global and task inputs as hashing,
evaluates task owners before Git-range package narrowing, applies negative Git
ranges after positive task matches, and includes `with` companions. Owning
manifests participate in task-aware selection and hashing independently of user
input globs. Symlinked owning control manifests retain their link identity and
also hash the resolved file contents consumed by discovery and execution.
Package task configurations participate independently in task-aware selection.
Owning lockfiles, repository-controlled JavaScript package-manager
configuration, workspace-local Bun `bunfig.toml` files, and Cargo control or
toolchain files participate in both task-aware selection and hashing. Expected
JavaScript lockfile paths remain task-aware inputs when the active lockfile is
deleted. Yarn PnP tasks always hash the repository-root `.pnp.cjs` loader in
addition to the preferred resolution lockfile. Yarn tasks hash every
repository-contained ancestor `.yarnrc.yml` from their execution directory to
the repository root. A repository-contained effective `yarnPath` executable is
also an input; a missing or external executable makes the package and downstream
cache scopes uncacheable. Yarn 2+ tasks also hash effective workspace-relative
`injectEnvironmentFiles`, including the default `.env.yarn`; external or
unmodeled injected-file paths make the package and downstream scopes
uncacheable. A changed workspace gitlink path is treated
as the package-relative `.` input. Task hashes preserve Git symlink, gitlink,
and dependency semantics, exclude the resolved cache directory, use each
task's owning ecosystem lockfile, and omit documentation-only task
descriptions. Hash input paths use locale-independent code-unit ordering.
When the Git index and working tree disagree on regular-file or symlink kind,
the working-tree kind determines the hashed mode. An indexed executable bit is
retained only while both representations remain regular files.
Repository-contained ancestor `.npmrc` files are always hashed for npm and
pnpm workspace tasks independently of configured input globs. An npm or pnpm
task bypasses caching when its effective user configuration exists, using
`NPM_CONFIG_USERCONFIG` when set and the platform user home's `.npmrc`
otherwise, because that external configuration is not a repository hash input.
Yarn tasks likewise bypass caching when the platform user home contains an
effective `.yarnrc` or `.yarnrc.yml` configuration.
Cache-eligible JavaScript task hashes include the normalized runtime identity
reported by the bare npm, pnpm, Yarn, Bun, Aube, or Nub command from the task
execution directory and effective task environment. A failed or empty identity
probe makes the task and its downstream hash scopes uncacheable; a
manifest-declared version is configuration metadata and does not substitute
for this runtime identity.
Only indexed mode `160000` directories are hashed as gitlinks; an indexed
regular file replaced by a working-tree directory is omitted while its
discovered descendants remain task inputs.
Regular input files are streamed through bounded-memory Git blob digests, and
owning lockfiles are streamed through bounded-memory xxHash64 digests.
NUL-delimited Git discovery output is consumed as bytes and filenames that are
not valid UTF-8 fail affected selection and hashing instead of being silently
omitted. Git-discovered and filesystem-traversed POSIX filenames preserve
literal backslashes as filename characters. Generic repository discovery,
path joining, cache archive paths, and symlink targets preserve the same POSIX
distinction while Windows-originated paths use Windows separator semantics.
Cargo task hashes additionally
include repository-contained ancestor manifests, Cargo configuration, and Rust
toolchain files that can change task execution. Repository-contained compiler
wrappers selected by effective `build.rustc-wrapper` and
`build.rustc-workspace-wrapper` configuration are also inputs; missing,
external, and PATH-resolved wrappers make the Cargo package and downstream
scopes uncacheable. Cached Cargo format tasks require at least one positive
output declaration and also include ancestor `rustfmt.toml` and `.rustfmt.toml`
controls. They are
partitioned by the normalized verbose compiler identity and effective Rust host
target reported for the package execution directory. A missing compiler
identity or host target, an effective ancestor Cargo configuration outside the
repository, or an effective Cargo target directory outside the repository makes
the Cargo package and downstream hash scopes uncacheable.
Cargo compilation tasks with an effective `RUSTC` environment override and
their downstream scopes are likewise uncacheable because the task-specific
compiler identity is not modeled. Effective `RUSTC_WRAPPER` and
`RUSTC_WORKSPACE_WRAPPER` environment overrides apply the same bypass because
the wrapper executables are not repository hash inputs.
Environment-name selection follows Windows case-insensitive semantics for run
options, affected-range controls, hashing, and strict task execution.
Repository discovery records the resolved root lockfile path. Gate 3 validates
all modeled lockfile formats before prune, rewrites pnpm importer/package/
snapshot closure, npm workspace package indexes and version 2 legacy dependency
trees, Yarn Classic and Berry entry closures, and text Bun workspace/package
indexes. Binary Bun, Yarn PnP, and
other validated formats without a safely rewritable public workspace index are
preserved. pnpm aliases derive their target identity from importer specifiers
and target-qualified resolutions, peer-qualified snapshots retain both the
base package and qualified snapshot, and resolvable `file:` package and
snapshot records retain their transitive closure. npm pruning retains only the
selected workspace dependency closure and its valid workspace links. Without
Git, explicit task
inputs under ordinary `dist` and `target` directories remain hashable.
Cache directories equal to or containing the repository or any discovered
package directory are rejected by canonical filesystem location before cache
access, including through symlinks.
Scheduled `with` groups preserve internal dependency order and share one
run-wide foreground concurrency budget. Simultaneously ready non-persistent
companions acquire foreground permits as an indivisible cohort, and a
concurrency limit that cannot fit the cohort is rejected. Ready groups are
refilled as individual groups finish rather than waiting for a whole scheduling
wave. Foreground owners wait until their complete non-persistent companion
cohort is dependency-ready; prerequisite companions may run first to unlock
the cohort. All non-interactive task output streams to the task log through
bounded backpressure while retaining only a bounded diagnostic tail and
incomplete display line in memory. Bounded display flushes retain streaming
render state, so a continuous line receives one prefix and no synthetic line
breaks. Before local task execution, the task-log parent must be a real
directory and an existing exact log destination must be a regular file.
Symlinks and other non-regular destinations are rejected. An existing regular
log destination is unlinked before task output is written so a hard link cannot
redirect truncation outside the execution directory.
Persistent companions must remain alive until their foreground owners
complete; any earlier natural exit fails the group, and foreground owners
sharing a companion remain subject to the run's concurrency limit.
Persistent task scopes always bypass local and remote caching, regardless of
their configured cache value.
On Windows, npm, pnpm, and Yarn task commands use their standard command shims
through a narrowly escaped command-interpreter adapter; POSIX task execution
does not use a shell. A scoped Windows process-event tracker retains descendant
identity after wrappers exit, and scope finalization terminates every remaining
tracked process in the task tree.

Workspace task overrides merge with their effective package-qualified root
definition and the merged task invariants are revalidated before execution.
Task-level `extends: false` is package-only: without other fields it removes
the inherited task, including synthesized Cargo and uv tasks, while additional
fields create a fresh definition without root-task inheritance.
Workspace configuration inheritance accepts only the exact `["//"]` parent
list.
Cache policy values use comma-separated `(local|remote):(r|w|rw)` entries and
reject malformed entries. Remote artifact routes preserve configured API path
prefixes. Active remote URLs must use HTTP or HTTPS, must not contain username
or password credentials, and URLs and timeout values are validated before cache
or task work begins; blank download and upload timeout strings are invalid.
Signature-key requirements
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
Missing or malformed local cache duration metadata reports zero saved time
without invalidating an otherwise successful restoration.
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
files. It rejects destinations beneath the active cache directory, duplicate
destinations, and any non-directory archive entry that is an ancestor of
another destination. Output negations are deny rules during both collection
and restoration, regardless of their order relative to positive patterns.
Pre-restoration clearing preserves matched ancestor directories whose
descendants can match an output negation while still clearing matched leaves
and safe subtrees. Task identifiers are
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
whose metadata reports more than 64 MiB of aggregate uncompressed file content
are skipped before contents are read. Sequential bounded reads enforce the
remaining aggregate budget when an output grows after metadata collection; an
over-limit read skips publication with a warning that preserves the successful
task result.
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
per-entry writer lock before removal, then rereads and revalidates the selected
entry's file fingerprint and current limits so it cannot remove a concurrent
publication or expose a partially published entry. Selected-entry removal
failures are aggregated after all of its archive and sidecar paths are tried.
Eviction also reclaims stale atomic-write
temporaries under the corresponding entry lock. Restoration of an existing
entry holds the same lock through validation and rejected-entry cleanup so it
cannot remove a concurrent publication. Active entry locks renew their lease
before the stale-lock threshold, and renewal or ownership loss interrupts the
protected operation. Locks left by terminated writers remain reclaimable.
Parent-directory durability sync is attempted after atomic rename and ignores
only platform errors that explicitly report directory sync as unsupported.
Cache archives use PAX
extensions for paths beyond ustar limits. Tar header paths, link targets, and
PAX metadata must be valid UTF-8, and numeric fields must contain complete octal
values; malformed fields reject the artifact. Interrupted or failed atomic
writes attempt to remove their temporary files. An atomic-write cleanup failure
is surfaced as a local cache write failure, including when the write or rename
also failed. A cache
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
Declared output patterns may select `.turbo` descendants outside the resolved
cache-directory subtree.
Cache output collection prunes directory subtrees that cannot match a positive
output pattern, while matching patterns may explicitly retain `node_modules`
or other normally ignored directories. A matching FIFO, socket, device, or
other unsupported filesystem entry skips cache publication without changing a
successful task result. A symlink that is an untraversed ancestor of a positive
output pattern also skips publication so a log-only artifact cannot represent
missing declared outputs.
uv packages are discovered from the root
`pyproject.toml` workspace root and member globs after applying workspace
exclusions; unrelated Python projects and `.venv` trees are ignored.
Synthesized uv packages
expose `build` and `test`, and implicit builds default to uncached unless task
configuration explicitly enables caching. Explicitly cached uv builds bypass
caching when `-o`, an attached `-o` value, or `--out-dir` selects an unmodeled
output directory, when `--project` or `--directory` selects an unmodeled
project root, and when pass-through `--config-file` selects an unmodeled
configuration file. uv
tasks execute from their project directory, forward test arguments directly to
`pytest`, and parse `uv.lock` as TOML. Each task hash includes the owning
`pyproject.toml`, the workspace-root `pyproject.toml`, and effective
repository-contained `uv.toml`, `.python-version`, or `UV_CONFIG_FILE` controls
independently of configured input globs; these controls also participate in
task-aware affected selection. Repository-contained files selected through
`UV_ENV_FILE` are handled the same way unless `UV_NO_ENV_FILE` disables them;
external environment-file paths make the package and downstream hash scopes
uncacheable. uv task hashes are partitioned by normalized uv and effective
Python identities. If either identity cannot be determined without downloading
an interpreter, the task and downstream hash scopes bypass caching. Effective
uv user configuration or an external `UV_CONFIG_FILE` makes the package and
downstream hash scopes uncacheable. uv
path dependencies that do not resolve to the named discovered workspace member
make the package and hash scopes that depend on them uncacheable, regardless of
editable mode. Raw direct path and URL requirements without a corresponding
`tool.uv.sources` declaration likewise make those scopes uncacheable. uv
package-graph edges require a
matching `tool.uv.sources` workspace declaration or local path resolving to the
named workspace member by canonical, platform-aware filesystem identity;
registry, Git, URL, and undeclared sources remain
external. JavaScript package-graph edges require declared workspace or
version-range compatibility, or a `file:`, `link:`, or Yarn `portal:` path whose
canonical, platform-aware filesystem identity resolves to the local JavaScript
package. Bare npm relative directory specifications use the same canonical
resolution. Local path aliases record the resolved package's actual name even
when the dependency key differs. Relative pnpm `workspace:` paths resolve by
the same canonical filesystem identity.
JavaScript packages with a local path dependency that does not resolve to a
discovered JavaScript package make their task scopes and downstream hash scopes
uncacheable. pnpm
workspace aliases resolve to the package name encoded in their specification;
same-named Cargo and uv packages are never JavaScript workspace targets. Cargo metadata
paths are matched by canonical filesystem identity. Repository-root Cargo
packages reuse the loaded root task configuration instead of interpreting it as
a workspace configuration. Unfiltered Cargo `test`,
`check`, `lint`, and `format` tasks execute once per Cargo workspace and bypass
caching when any grouped member disables it; filtered and package-qualified
runs retain package targeting. A workspace is grouped only when every
repository-contained member exposes the requested verification task and their
interactive, output-log, and persistent runtime settings are compatible;
otherwise participating members retain package targeting so task exclusions
and runtime overrides are honored.
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
Synthesized Cargo builds always retain an internal `^build` dependency after
task configuration merging. Other cached Cargo compilation tasks (`check`,
`test`, `lint`, `run`, and `dev`) retain the same dependency, so resolved
workspace dependency hashes participate in their cache keys.
Pass-through arguments are forwarded to Cargo without an implicit
target-argument separator. Cargo builds for pure-library and mixed
library/binary crates remain uncached when configuration enables caching
without declaring positive output patterns; explicitly configured outputs may
opt those builds into caching. Every cacheable Cargo
compilation task bypasses caching when pass-through arguments add a package
selector, including `-p`, `--package`, `--workspace`, and `--all`. Every
cacheable Cargo compilation task with an alternate output layout or manifest,
or an unmodeled library, binary, example, test, or benchmark target, bypasses
caching until those outputs are modeled explicitly. `--timings` also bypasses
caching until its generated timing report is included in cache artifacts.
Cargo pass-through
`--config` arguments also bypass caching for every cacheable Cargo
compilation task (`build`, `check`, `test`, `lint`, `run`, and `dev`) because
they can load or set external compilation controls that are not hashed. The
same compilation-task set bypasses caching when any effective Cargo-home
configuration is present or when the effective task environment sets a build
target. Ancestor configuration setting a build target, or different
`CARGO_TARGET_DIR` values for Cargo metadata and strict task execution,
likewise bypass caching. Runtime-only cache bypasses seed the dependency and
`with` closure, so downstream task scopes cannot restore cache entries whose
prerequisite output depends on unmodeled external controls. Cargo metadata
discovery uses `--locked`, uses each response's workspace-member list, and does
not probe excluded or unrelated nested manifests. Combined workspace task
hashes are propagated into every downstream task hash using the same effective
task environment as the initial hash computation.
Cargo builds with colliding synthesized binary destinations bypass caching,
including when task configuration explicitly enables it.
Synthesized Cargo binary outputs cover the extensionless executable plus
`.exe` and `.pdb` variants.

Structured task input globs apply ordered inclusion and negation consistently
to task hashing and task-aware affected selection. Task-aware Git filters
preserve leading and trailing ellipses and traverse both task and package graphs
in the requested dependent or dependency direction. Filters requesting both
directions compute each closure from the original matches before unioning them.
Package, `{directory}`, and `[Git range]` components within one filter are
intersected before graph traversal; separate positive filters retain union
semantics and negative filters remove their matching sets afterward.
Ordinary root-file changes
select only tasks whose effective inputs match them; repository-global inputs
and Git discovery failures retain the all-task fallback.
Changes to the loaded root task configuration select all requested task
entrypoints under task-aware affected and Git-range filtering.
Changes to any repository-contained `.gitignore` retain the same all-task
fallback because they can change Git-discovered task inputs without exposing
newly included files in the revision diff.

Gate 2 is not closed: the composed task-hash serializer does not yet reproduce
the official 2.10.12 task hashes. Individual source-file hashes match Git and
the oracle, but the official binary does not distribute the serialization
contract that combines global and task inputs. End-to-end cache-key
interoperability therefore remains planned; archive and HTTP interoperability
must not be presented as evidence that task hashes match.
Structured `dependencyOutputs` task inputs are rejected during configuration
validation until their dependency graph and output-hash semantics are
implemented; they are never treated as ordinary local globs.

Gate 3 adds repository workflows with automated ledger evidence. `watch`
debounces filesystem storms, retains every distinct changed path in each
settled debounce batch, and uses switching Effect streams so a later batch
interrupts an in-flight run before recovery. Watchers, child processes, fibers,
signals, and task resources remain scope-owned. Watch mode resolves cache
policy from CLI and environment configuration, reads cache by default, and
enables cache publication only with `--experimental-write-cache`; the effective
policy is reduced to its readable capabilities until that flag is present, and
a write-only policy disables cache access. Repository and
nested Git-ignore rules and configured task-output patterns suppress generated
files except where an output exclusion denies the changed file. Package-relative
outputs are matched from their package directory, while `$TURBO_ROOT$/` outputs
and exclusions are matched from the repository root. Partial output matching is
limited to directory events. Ignore and output filtering occurs before manifest
or configuration refresh classification, so generated manifests cannot cause a
watch loop. Changes to an ignore file reload the matcher before stale ignore
rules are applied and remain user-visible triggers.
Declared-output ignore files written by an active run remain suppressed to
prevent generated-output loops. Root, custom, and workspace Turbo configuration
changes and active JavaScript, Cargo, or uv workspace manifest changes refresh
package discovery and output patterns before the next run. Explicit graph,
structured-log, profile, trace, and heap artifacts, default profile artifacts,
and write-enabled local cache directories are treated as run-owned paths and
never trigger another watch run. Watch-time discovery honors `--single-package`
for both initial and refreshed repository models.
Internal-directory exclusions are matched relative to the watched repository,
so reserved names in ancestor directories do not suppress repository events.
Windows-originated `.git`, `.turbo`, and `node_modules` components are matched
case-insensitively. The bounded native watcher transport converts overflow into
a retried repository-wide invalidation; watch refreshes discovery and reruns all
requested tasks, while the daemon marks every registered output glob changed.
Run arguments after `--` remain task pass-through arguments, including text
equal to the watch-only cache-publication flag.
When `futureFlags.watchUsingTaskInputs` is enabled, file-triggered runs retain
only requested task entrypoints whose effective inputs match the changed paths,
plus their dependency and `with` closure. Root configuration, `.gitignore`, and
CLI `--global-deps` matches retain the all-task fallback. Watcher entry types
distinguish regular file renames from directories when applying directory-only
ignore rules.

The daemon uses the shared `.turbo/daemon` logs, SHA-256 repository state
identity, per-user temporary state directory, atomic PID and start lock files,
0600 Unix sockets, and stale-state cleanup. Its public transport is the
official `turbodprotocol.Turbod` gRPC service over HTTP/2. Hello, status, and
shutdown calls interoperate in both directions with the 2.10.12 executable;
package and watch calls share the same bounded framing and scoped sessions.
Requests that exceed the transport queue receive an immediate protocol error
instead of displacing an older request. Unsupported-method and queue-capacity
responses run in the server Scope so endpoint teardown interrupts pending
response work.
Package discovery reloads the repository model for each request so workspace
additions, removals, and renames are visible without a daemon restart.
Custom root Turbo configuration paths are retained by lifecycle commands,
forwarded to detached servers, and reused for request-time package discovery.
Output-change registration/query calls return their protocol data rather than
empty acknowledgments. Changed-output snapshots consume only the exact glob
generations reported after their response is written successfully. A failed
response remains retryable, and changes recorded while a response is being
written remain pending for the next query.
Start-lock ownership is
preserved across overlapping starts, stale locks are validated before removal,
and a Hello response carrying an error is not healthy. Start, stop, restart,
status, logs, and clean are race-safe; `info` reports the live daemon state.
Failed health checks clean stale PID and socket state even when the recorded
PID has been reused by an unrelated live process.
After a successful health handshake, a subsequent status transport or response
failure preserves the live daemon's PID, socket, and active-log state and is
reported to the caller for both status and logs commands.
Log clients follow the exact dated log reported by the running daemon until
interrupted. Stop escalates only after a successful RPC identifies the process
as the expected daemon; reused live PIDs without a healthy daemon RPC are
treated as stale state and are never signaled. A failed shutdown RPC preserves
the live daemon's PID, socket, and active-log state and reports the failure so
the operation can be retried. Forced termination must be available, succeed,
and be confirmed before the same state is removed. A timed-out daemon start
applies the same termination and state-retention rules to its spawned process.
Malformed streams remain
isolated, response transport failures are logged and isolated to their request,
and an idle server resets its deadline after RPC or repository activity without
expiring while an RPC is in flight. Dated daemon log paths derive their time
from the configured clock service. Serve startup acquires exclusive PID
ownership, a competing server cannot unlink a live daemon endpoint, endpoint
cleanup is limited to the owning server instance, and a post-bind endpoint
setup failure closes the server and all sessions. Repository watcher failure
terminates the daemon rather than leaving an apparently healthy RPC server.
Windows deliberately uses Node's forceful
process termination because Node has no supported graceful Win32 Ctrl+C bridge.

`query` provides the compatible repository GraphQL root, package graph,
package and task collections, affected collections, variables, schema
introspection, and a loopback GraphQL server. Task relationship collections
come from the resolved task graph. GraphQL affected collections calculate the
requested base/head range, include dependent packages, and apply package and
task filters. The `query affected --tasks` shortcut uses the same resolved task
graph for explicitly requested bare and package-qualified names, including root
tasks and configured commandless tasks, and propagates dependency-task reasons
through transitive affected package chains, while its unfiltered form retains
script-backed task enumeration. Cyclic package graphs never include the starting
package in its own dependency or dependent relationship collections.
Boundary diagnostics evaluate root, package, and tag dependency and dependent
permissions against manifest and configured implicit package dependencies. Package-graph
center selection retains the named package and its
direct dependencies, package predicates narrow the returned nodes, and graph
edges retain the selected nodes' dependency context. Graph filtering uses
package identities, and same-named cross-ecosystem edge endpoints use qualified
identities. Affected collections include the root package for root changes and
when it depends on an affected workspace without allowing the root path to
claim workspace-owned files. `query affected`, `query
ls`, and `ls` share repository discovery and stable ordering. The server limits
request bodies and closes HTTP handles in Scope; oversized requests receive
HTTP 413 without resetting the connection. Client resets and request errors
during body upload are isolated before handler execution, and disconnects or
server shutdown interrupt in-flight resolver effects and their subprocesses.
Top-level package predicates are
applied, external dependencies come from manifest references resolved against
the parsed lockfile, including npm v2/v3 package locations whose entries omit
the package name, and Yarn Berry entries report their installed `version`
rather than descriptor ranges. Lockfile reading and parsing are deferred until
the `externalDependencies` field is selected, so independent fields remain
available if the discovered lockfile later becomes unavailable or invalid.
Package-manager fields use protocol identifiers;
only pnpm's compatibility family uses the versioned `pnpm9` label. File queries
enforce repository containment
after resolving symlinks. The startup message describes the static page as a
GraphQL endpoint rather than an IDE.

Affected package listing disables Git rename detection so moves between
workspaces select both the source and destination owners before dependent
closure is applied. Environment-provided revisions are separated from Git
options and pathspecs before the affected diff executes.

`prune` selects the transitive internal package closure of both requested
packages and workspace dependencies retained by the copied root manifest,
emits ordinary and Docker layouts, creates reduced lockfiles with
reference-compatible canonical
configuration formatting, supports production manifests, and
rejects output roots that could contain the source repository, any discovered
package, or any discovered Cargo or uv workspace-control directory. Selected
package copies stop at nested workspace roots outside the selected closure.
Generated installation manifests and configuration files use readable `0644`
modes. It
never follows workspace symlinks into a prune output. Output safety and traversal
exclusions use canonical locations. Contained relative file symlinks are
recreated without dereferencing unless their resolved target enters an
unselected nested workspace; copied root controls include their contained
regular-file targets at the corresponding installation paths. Absolute,
escaping, or output-targeting links are rejected, including symlinked root
installation controls, and an exact symlinked output root is rejected before
replacement. The root pnpm
hook `.pnpmfile.cjs` is retained in every
installation root. Root Bun `bunfig.toml` configuration is retained in the
ordinary output and both Docker installation roots. Root Yarn installation controls, including `.yarnrc.yml`,
`.pnp.cjs`, releases, patches, and a repository-contained configured `yarnPath`
executable, are retained at their repository-relative locations in applicable
ordinary and Docker layouts. Required Yarn releases, patches, and configured
executables are retained even when Git-ignore rules match them. Other copying
honors repository and nested Git-ignore files unless disabled; ordinary pnpm
pruning retains development dependency closure. Production npm, pnpm, Yarn,
and text Bun pruning removes development dependency edges and their package
closure, including development-marked trees in legacy npm v1 lockfiles.
Production pruning also removes `devDependencies` from selected JavaScript
workspace manifests in the ordinary or Docker full tree. Docker JSON subsets
contain manifests only for selected JavaScript packages; selected Cargo and uv
package manifests remain in the full tree. Selected Cargo and uv packages also
retain their owning workspace manifest and lockfile in the ordinary or Docker
full tree. When
`futureFlags.pruneIncludesGlobalFiles` is enabled, ordered
`globalDependencies` or `global.inputs` globs copy their safe, non-ignored
matches into the ordinary output or Docker full tree before generated controls
and manifests are rewritten.

Run workflows support text and JSON dry-runs; DOT, Mermaid, JSON, and HTML task
graphs; JSON run summaries and live newline-delimited structured log files;
stream, grouped, timestamped stream, and NDJSON output;
completion and info; Chrome-compatible named and anonymous profiles; and the
approved V8 heap snapshot and trace substitutions. TUI requests retain stream
semantics when no interactive terminal is available, and all color output
continues to honor `NO_COLOR`. Interactive TUI mode renders task status and
falls back to stream mode when either terminal side is non-interactive. JSON
mode emits only newline-delimited JSON on stdout. Grouped mode serializes each
completed task's full log replay. Structured log files append typed task events
as work runs and end with a typed run summary. An explicit structured-log
artifact and explicit named, anonymous, or trace profile artifacts are excluded
from task and global file hashes. Root-level `profile.*` artifacts are likewise
excluded whenever a bare profile option selects the generated default path. A
structured-log artifact may not replace a mandatory task control input or match
a declared task output. Timestamped
streaming applies the timestamp
writer to a final unterminated task line. Errors-only failure replay does
not duplicate output already recorded while the task ran and reads the complete
task log instead of the bounded diagnostic tail. CLI `--global-deps`
patterns are merged into task hash inputs, and their repository-relative Git
blob hashes are reported in summary `globalCacheInputs.files`, including when a
valid requested task is filtered to a successful no-op. Dry runs do not perform local
cache eviction, and
`info` derives WSL status from the Linux kernel release. Log-prefix selection
applies to live and cached output. Summaries record
the actual local or remote cache source and saved duration, and summaries and
profiles use each task's scheduling timestamps. Generated profiles omit tasks
that were never scheduled, while summary task entries represent them with a
null `execution` value. Requested heap snapshots are written
before task input hashes are computed so repository-contained snapshots cannot
invalidate a cache key after hashing. Task summaries record the
resolved transitive external-dependency closure hash for graph-bearing npm,
pnpm, Yarn, Cargo, uv, Bun, Aube, and Nub lockfiles and the actual encoded log
path, including collision-qualified identifiers and alternate execution scopes.
Global summary inputs record the corresponding root-manifest external-dependency
closure hash instead of the empty-closure hash when root dependencies resolve.
Graph-bearing closures retain the declaring manifest reference or resolved
workspace entry so multiple locked versions of one name do not broaden a task's
external dependency hash. Cargo closures also retain parenthesized source
qualifiers so identical package names and versions from distinct registries or
Git sources remain separate graph nodes.
Summary `monorepo` fields are true whenever ordinary discovery finds at least
one child workspace and false in explicit single-package mode.
Persisted, stdout, and
newline-delimited summaries from one run share one canonical UUID v7 identifier.
Mermaid graphs assign stable,
unique node identifiers without truncated-hash collisions.

Only behavior with automated ledger evidence is a compatibility claim. Hosted
authentication, devtools, telemetry transports, and full platform matrices
remain later gates.

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
