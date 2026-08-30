# Repository Fork Management Contract

## Purpose

This contract defines how Delino Forks imports, organizes, documents, and
maintains forked projects. It applies to every fork stored in this repository.

## Repository Layout

Fork source is checked directly into the domain that owns its implementation:

- `apps/` for browser, desktop, and mobile application surfaces
- `packages/` for TypeScript packages and shared frontend modules
- `crates/` for Rust crates and binaries
- `cmds/` for Go command-line programs
- `protos/` for shared protobuf and Connect RPC contracts
- `servers/` for backend services and APIs

A fork may own paths in multiple domains. Git submodules are not part of the
repository model.

## Project Registration

Every fork has a unique, stable, lowercase kebab-case project ID. Its canonical
entry point is `docs/project-<project-id>.md`, which links every directly
authoritative domain contract and identifies all owned paths. The root
`README.md` and `docs/README.md` catalogs must be updated in the same change as
the source and contracts.

## Upstream Provenance

Each project index records:

- the canonical upstream repository URL and exact imported revision
- the purpose of maintaining the fork and its material local differences
- the approach for reviewing and incorporating later upstream changes
- the upstream license and all attribution or redistribution obligations

Imported source must retain upstream license and attribution files required for
redistribution. An upstream revision change must update the project index and
affected domain contracts in the same change.

## Policy and Validation

Forked source follows this repository's policies and its owning project and
domain contracts. Upstream requirements that must be preserved are recorded as
explicit project-contract decisions. Repository defaults continue to apply
unless an owning contract documents an upstream-driven exception.

Changes must run repository-wide validation plus the scoped checks required by
the affected language and domain. Generated outputs, imported revisions,
contracts, and catalogs remain synchronized in the same change.

## Current Projects

- [`turbo-ts`](project-turbo-ts.md): clean-room TypeScript and Effect
  compatibility implementation for Turborepo 2.10.12.
