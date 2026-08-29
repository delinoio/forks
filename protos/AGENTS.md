# Instructions for `protos/`

- Follow the root `AGENTS.md` and the owning API contract before changing protobuf definitions or generated bindings.
- Preserve upstream protocol requirements recorded in the owning fork project contract.
- Store versioned contracts under `protos/<service-name>/v1`.
- Keep generated Go protobuf and Connect packages beside their source contracts and use the repository module import path.
- Treat field numbers as permanent once published; never reuse removed field numbers.
- Prefer enums when the complete variant set is known.
- Document intentional compatibility breaks and migration requirements in the owning project contract.
- Regenerate bindings and run affected Go tests whenever protobuf inputs change.
