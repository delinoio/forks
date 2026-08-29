# Instructions for `cmds/`

- Follow the root `AGENTS.md` and the owning command contract before implementation.
- Preserve upstream command requirements recorded in the owning fork project contract.
- Implement command-line programs in Go unless an owning contract records an exception.
- Write source code and comments in English.
- Use documented public contracts instead of importing another component's Go `internal/` packages.
- Use structured logs for diagnostics and keep user-facing output concise.
- Enable ANSI color by default and honor `NO_COLOR` where practical.
- Run `go test ./cmds/...` after command changes.
