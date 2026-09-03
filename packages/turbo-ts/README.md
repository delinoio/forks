# `@delino/turbo-ts`

Private, clean-room TypeScript and Effect compatibility implementation targeting
Turborepo 2.10.12.

> `turbo-ts` is an unofficial independent implementation. It is not affiliated
> with, maintained by, or endorsed by Vercel.

## Status

Compatibility Gate 1, substantial Gate 2 surfaces, and the Gate 3 repository
workflows are implemented. In addition to the identity,
schema, Effect, oracle, fixture, hosted-mock, normalizer, and ledger foundation,
`turbo-ts` now models JavaScript, Cargo, and uv workspaces; loads root and
package JSON/JSONC configuration; builds package and task graphs; selects
filters and affected packages; executes explicit or implicit tasks; controls
task environments and concurrency; and reads and writes compatible local and
remote cache archives. Repository workflows include watch/restart recovery, the
shared daemon lifecycle and HTTP/2 gRPC transport, GraphQL query and affected
responses, `ls`, lockfile-aware prune, dry runs, task graphs, summaries,
structured output, completion, system information, and Node/V8 profile
artifacts. Only passing automated ledger rows are compatibility claims; hosted
and secondary commands remain planned. Gate 2 is not closed
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
pnpm exec turbo-ts watch build
pnpm exec turbo-ts query '{ packages { length } }'
pnpm exec turbo-ts ls --output=json
pnpm exec turbo-ts prune @scope/application --docker
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

JavaScript `file:`, `link:`, Yarn `portal:`, bare npm relative-directory, and
relative pnpm `workspace:` dependencies resolve to discovered packages by
canonical filesystem identity. A local path that does not resolve to a
discovered JavaScript package disables caching for the declaring package and
downstream hash scopes. JavaScript task hashes always
include their owning `package.json`, independently of configured task globs.
When that manifest is a symlink, its task hash includes both the link and the
resolved contents consumed during discovery and execution. Repository-level
package-manager controls, workspace-local Bun `bunfig.toml` files, and expected
lockfile paths also remain task-aware inputs, including when the active
lockfile is deleted. Yarn PnP tasks hash the root `.pnp.cjs` loader separately
from the preferred resolution lockfile. Yarn tasks hash ancestor `.yarnrc.yml`
files through the repository root. Repository-contained effective `yarnPath`
executables are package-manager inputs; missing or external executables disable
caching for the package and downstream tasks. Yarn 2+ tasks also hash their
effective workspace-relative `injectEnvironmentFiles`, including the default
`.env.yarn`; external or unmodeled paths disable caching. Effective
npm and pnpm user `.npmrc` files likewise disable caching because they are
external inputs, while repository-contained ancestor `.npmrc` files are always
hashed. Yarn home `.yarnrc` and `.yarnrc.yml` files also disable caching.
Cache-eligible JavaScript task hashes include the normalized identity reported
by the actual npm, pnpm, Yarn, Bun, Aube, or Nub command invoked from the task
directory. If that identity cannot be verified, the task and downstream scopes
execute without cache reads or writes.
Enabled JavaScript, Cargo, and uv discovery passes retain co-located package
scopes in the same workspace directory. Repository-root Cargo and uv scopes do
not absorb ordinary root files during package-level affected selection.

Cargo compilation tasks that receive pass-through arguments selecting another
package, release, profile, target, another manifest or alternate artifact
layout, a timing report, or an unmodeled library, binary, example, test, or
benchmark target
execute without cache reads or writes until those outputs are modeled
explicitly. Pass-through
`--config` arguments disable every cacheable Cargo compilation task because
external configuration paths are not task-hash inputs. Mismatched metadata/task
`CARGO_TARGET_DIR` values also disable Cargo compilation-task caching. Any
effective Cargo-home configuration or `CARGO_BUILD_TARGET` likewise disables
every cacheable Cargo compilation task. Effective `RUSTC`, `RUSTC_WRAPPER`, or
`RUSTC_WORKSPACE_WRAPPER` overrides also disable the affected Cargo compilation
and downstream cache scopes. Cargo
configuration above the repository disables the affected Cargo and downstream
cache scopes.
Repository-contained compiler wrappers selected by effective
`build.rustc-wrapper` and `build.rustc-workspace-wrapper` configuration are
hashed; missing, external, or PATH-resolved wrappers disable caching.
Pure-library and mixed library/binary crates remain uncached when caching is
enabled without positive output declarations because binary-only or log-only
artifacts cannot restore all of Cargo's default outputs. Explicit output
declarations may opt those builds into caching. Source-free local
path dependencies that do not resolve to a same-workspace repository package
also disable caching. Synthesized binary outputs cover the extensionless
executable plus `.exe` and `.pdb` variants. Single-binary Cargo `run` and `dev`
tasks also default to uncached unless task configuration explicitly enables
caching.
Repository-root Cargo packages reuse the loaded root task configuration.
Unfiltered Cargo workspace commands merge the effective environments of every
grouped member and remain package-scoped when any repository member excludes
the requested verification task.
Explicitly cached Cargo format tasks hash ancestor `rustfmt.toml` and
`.rustfmt.toml` files and require at least one positive output declaration so
formatted sources can be restored on a cache hit.

Local and remote cache restoration is limited to 256 MiB compressed and 1 GiB
after decompression. Artifacts beyond either limit are rejected; invalid local
entries are removed with a warning and become misses, while remote entries use
the normal local-execution fallback. Existing-output scan failures likewise
warn and execute the task locally without cache reads. Decompressed archives
are parsed from scoped temporary storage. Local restore validation and rejected
entry cleanup share the entry lock with writers, so corrupt cleanup cannot
remove a concurrent publication. Cache writes independently limit file content
and tar metadata overhead to 64 MiB each. Cache output files are read
sequentially against the remaining content budget, so growth after a metadata
snapshot cannot exceed the collection bound. Cache publication is serialized
within a run to bound writer memory independently of task concurrency. Remote
downloads, signature verification, and decompression use scoped files so
concurrent cache hits do not retain or duplicate complete compressed response
bodies in memory. Blank remote-cache timeout values are invalid. Run-option
environment names follow Windows case-insensitive semantics. Local
execution rejects symlinked task-log directories and exact log destinations
before starting the task, and replaces existing regular log files before
writing so hard links cannot redirect truncation. On Windows, scoped process
tracking retains descendant identities after command wrappers exit so
finalization can terminate detached task processes.

Cache publication is skipped when a declared output glob would require
traversing an output-directory symlink, preventing a log-only cache artifact
from standing in for omitted declared outputs. Cache restoration preserves
excluded descendants when a broader positive output pattern matches one of
their ancestor directories.

Configured cache directories may be inside or outside the repository, but the
repository root, its ancestors, and directories containing discovered packages
are rejected because treating them as cache content would exclude source files
from task hashes. Explicit `dist/**` and `target/**` task inputs remain hashable
when Git metadata is unavailable.

uv task hashes always include the owning and workspace-root `pyproject.toml`
plus effective repository-contained `uv.toml`, `.python-version`, and
`UV_CONFIG_FILE` controls. Repository-contained files selected through
`UV_ENV_FILE` are also hashed unless `UV_NO_ENV_FILE` disables them. These
controls remain task-aware inputs. Effective user configuration, an external
`UV_CONFIG_FILE`, an external `UV_ENV_FILE`, explicitly cached uv builds using
`-o`, `--out-dir`, `--project`, or `--directory`, and uv packages with unresolved
external local path dependencies bypass cache reads and writes until those
inputs and outputs are modeled, regardless of editable mode. Raw direct path or
URL requirements without a corresponding `tool.uv.sources` declaration also
bypass caching. uv task hashes include normalized uv and effective Python
identities; caching is bypassed when either identity cannot be determined
without downloading an interpreter.

## License and Attribution

The independent implementation is available under the Delino MIT license in
`LICENSE`. Turborepo's separate MIT attribution is retained in
`UPSTREAM-LICENSE`.
