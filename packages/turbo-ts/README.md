# `@delino/turbo-ts`

Private, clean-room TypeScript and Effect compatibility implementation targeting
Turborepo 2.10.12.

> `turbo-ts` is an unofficial independent implementation. It is not affiliated
> with, maintained by, or endorsed by Vercel.

## Status

Compatibility Gate 1 is implemented: package identity, configuration schema and
types, Effect boundaries, external-oracle infrastructure, synthetic fixtures,
mock hosted services, deterministic normalizers, and the exhaustive
compatibility ledger. Features assigned to later gates are deliberately marked
as planned and are not yet compatibility claims.

Official `turbo@2.10.12` remains the repository task runner and black-box test
oracle. No upstream source, tests, fixtures, or diffs are included.

## Usage

```bash
pnpm --filter @delino/turbo-ts build
pnpm exec turbo --version
pnpm exec turbo-ts --version
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

## License and Attribution

The independent implementation is available under the Delino MIT license in
`LICENSE`. Turborepo's separate MIT attribution is retained in
`UPSTREAM-LICENSE`.
