# Documentation Catalog

## Purpose

`docs/` is the source of truth for Delino Forks repository contracts. Each fork
project must have one project index document and one or more domain contract
documents that connect its upstream provenance to its owned repository paths.

## Naming Rules

- Project indexes: `docs/project-<project-id>.md`
- Domain contracts: `docs/<domain>-<project-or-component>-<contract>.md`
- Repository contracts: `docs/repository-<topic>-contract.md`
- Supported domain prefixes: `apps`, `packages`, `crates`, `cmds`, `protos`, and `servers`
- Use lowercase kebab-case project and component identifiers.

## Documentation Policy

- `docs/AGENTS.md`

## Repository Contracts

- `docs/repository-fork-management-contract.md`

## Fork Project Catalog

No fork projects are registered yet. Add each project index and its directly
authoritative domain contracts here when the fork source is introduced.

## Adding a Contract

Add the project index and directly authoritative domain contracts before or in
the same change as the fork source. The project index must identify the upstream
repository and imported revision, owned paths, fork purpose and local
differences, synchronization approach, and license or attribution obligations.
Catalog every new document here and keep repository-wide policy in the
applicable `AGENTS.md` instead of repeating it inside contracts.
