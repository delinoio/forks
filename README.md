# Delino Forks

Delino Forks is a multi-language monorepo for Delino-maintained forks of
external projects. Fork sources are checked directly into domain-oriented
paths so they can share repository policy, tooling, and validation while
retaining documented upstream provenance.

## Prerequisites

- Node.js 24
- pnpm 10.17.1 through Corepack
- Go 1.26.6
- Rust toolchain from `rust-toolchain`

## Setup

```bash
corepack enable
pnpm install
pnpm check
```

The install step configures Lefthook for this checkout. See
`docs/README.md` for the contract-document catalog and naming rules.

## Repository Layout

- `apps/`: forked browser, desktop, and mobile application surfaces
- `packages/`: forked or shared TypeScript packages
- `crates/`: forked Rust crates and binaries
- `cmds/`: forked Go command-line programs
- `protos/`: protobuf and Connect RPC contracts owned by fork projects
- `servers/`: forked backend services and APIs
- `docs/`: authoritative fork, project, and domain contracts

## Fork Catalog

No fork projects are registered yet. Add each fork to this section when its
source and owning contracts are introduced.

## Adding a Fork

1. Reserve a unique lowercase kebab-case project ID.
2. Import the source directly into the applicable domain path; do not add it as
   a Git submodule.
3. Preserve the upstream license and required attribution.
4. Add `docs/project-<project-id>.md` and the applicable domain contract
   documents.
5. Record the upstream repository, imported revision, owned paths, fork purpose,
   local differences, and synchronization approach.
6. Update this catalog and `docs/README.md`, then run the scoped validation and
   `pnpm check`.

See `docs/repository-fork-management-contract.md` for the authoritative fork
management contract.
