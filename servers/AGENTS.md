# Instructions for `servers/`

- Follow the root `AGENTS.md`, the owning `docs/project-*.md`, and matching server or protobuf contracts before implementation.
- Preserve upstream service requirements recorded in the owning fork project contract.
- Implement backend services in Go unless an owning contract records an exception.
- Use PostgreSQL with `sqlc` for relational persistence.
- Use UUID v7 for repository-owned entities and PostgreSQL `uuid` for their keys.
- Use Connect RPC for business APIs unless an owning contract records an exception.
- Return generic public errors for internal failures and record the original cause in structured logs with correlation metadata.
- Never expose secret values in logs, default API responses, or routine stream payloads.
- Keep API boundaries explicit, versioned, and aligned with the root protobuf ownership model.
- Use `log/slog` or a compatible structured logger.

## Minimum Service Shape

- Connect-backed services should use `cmd/<service-name>/main.go`, `internal/service/`, `db/query/`, `db/migrations/`, `db/sqlc.yaml`, Buf configuration, a local generation script, and repository-root protobuf contracts.
- MCP-only services may omit Connect and protobuf scaffolding only when their owning contract explicitly records that boundary.
- Runtime environment variables should describe the configured capability or dependency rather than repeat the owning service name.

## Integration and Validation

- Update owning project, server, and protobuf contracts in the same change as interface changes.
- Preserve rolling-deployment compatibility when a migration removes or replaces storage used by the previous production revision.
- Run `go test ./servers/<service-name>/...` after service changes.
- Keep protobuf generation, `sqlc` outputs, migrations, and documentation synchronized.
