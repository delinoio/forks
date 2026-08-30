# Clean-Room Instructions for `packages/turbo-ts`

- Follow the repository and `packages/` instructions and
  `docs/packages-turbo-ts-contract.md`.
- Do not inspect, copy, translate, or import upstream implementation source,
  tests, fixtures, or commit diffs.
- Allowed compatibility inputs are public documentation, distributed JSON
  Schema and type artifacts, independently authored synthetic cases, and
  external black-box executions of the official `turbo@2.10.12` binary.
- Keep fixture provenance explicit. Never copy an upstream fixture or golden
  output that was obtained from upstream source or tests.
- Repository-authored implementation and tests must be TypeScript. Do not add
  authored Rust, Go, C, C++, WASM, shell, or PowerShell implementation modules.
- Route every effectful boundary through an Effect service and Layer. Acquire
  resources in Scope, supervise concurrent work with fibers, preserve
  interruption, use tagged typed errors, and apply retry schedules only to
  explicitly idempotent operations.
- Keep deterministic algorithms pure and separate from live adapters.
- Exact-pin direct dependencies. Runtime dependencies and any added parsing or
  protocol dependencies must be pure JavaScript and contain no native or WASM
  artifacts. Native TypeScript/Rstest development tooling and the external
  official Turbo oracle are the only approved exceptions.
- Do not import `turbo` or `@turbo/*`. Invoke official Turbo only as an external
  test oracle and verify that it is version 2.10.12.
- Use Effect Schema as the configuration source and keep generated schema and
  named type outputs synchronized.
- Never weaken or broaden a normalizer without repeated black-box evidence and
  a compatibility-ledger entry.
- Do not publish, deploy, or claim later compatibility gates are complete.
