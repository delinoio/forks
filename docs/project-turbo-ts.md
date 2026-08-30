# Turbo TS Project Index

## Identity and Ownership

- Project ID: `turbo-ts`
- Owned implementation: `packages/turbo-ts`
- Package contract: `docs/packages-turbo-ts-contract.md`
- Upstream reference: `https://github.com/vercel/turborepo`
- Compatibility tag: `v2.10.12`
- Compatibility commit: `53752d452049bdda47698354b16a83d7ce92ced0`

## Purpose and Provenance

`turbo-ts` is an unofficial, independently authored TypeScript and Effect
implementation of the core Turborepo CLI. It is maintained for repository
evaluation and local development. It is not affiliated with or endorsed by
Vercel.

No upstream source code, tests, fixtures, or commit diffs are imported. The
revision above is a black-box compatibility baseline, not an imported source
revision. Work may use public documentation, distributed JSON Schema and type
artifacts, and external executions of the official binary as permitted by the
package clean-room policy.

## Local Differences

- Package and executable identity is `@delino/turbo-ts` / `turbo-ts`.
- The implementation version is `0.1.0`, requires Node.js 24, and is private.
- Runtime code is ESM TypeScript compiled with `tsc`; no native or WASM runtime
  dependency is permitted.
- Hosted and telemetry identity is `turbo-ts`; update notification is disabled
  by default.
- The remaining explicit compatibility differences and implementation gates
  are defined by `docs/packages-turbo-ts-contract.md`.

## Synchronization and Licensing

The compatibility baseline does not move automatically. Maintainers review
upstream stable releases quarterly, and every baseline change requires a new
issue and refreshed differential evidence. The independent implementation is
MIT licensed by Delino. The separate upstream MIT attribution is retained at
`packages/turbo-ts/UPSTREAM-LICENSE`.
