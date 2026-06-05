# Contributing

Thanks for working on Firestate. This repo is a small TypeScript library, so
changes should stay focused and come with tests when behavior changes.

## Setup

```bash
pnpm install
```

This package targets Node 18+ for consumers. CI runs on Node 22.

## Development Commands

```bash
pnpm typecheck
pnpm test
pnpm build
```

Useful variants:

```bash
pnpm test:watch
pnpm test:coverage
```

## Project Layout

- `src/` contains the library source.
- `src/index.ts` is the public export surface.
- `examples/react-tasks/` is a runnable React + Firebase example.
- `docs/architecture.md` explains how the internals fit together.
- `docs/api-recipes.md` contains usage examples and edge-case guidance.

## Change Guidelines

- Prefer the registry API (`defineFirestate`, `doc`, `col`) for examples and
  app-facing docs.
- Keep the lower-level API (`defineDocument`, `defineCollection`,
  `useDocument`, `useCollection`) working as an escape hatch.
- Preserve the Zod contract: schemas validate `set` and `add`, but parsed
  values are not written and partial `update` diffs are not validated.
- Keep React snapshots stable for `useSyncExternalStore`.
- Do not add dependencies unless they remove real maintenance burden.
- Update docs when changing public behavior.

## Testing Expectations

Run these before opening a PR:

```bash
pnpm typecheck
pnpm test
pnpm build
```

Add focused tests for behavior changes:

- Diff behavior: `src/diff.test.ts`
- Undo behavior: `src/undo.test.ts`
- Registry and schema behavior: `src/schema.test.ts`, `src/firestate.test.ts`
- Store and sync behavior: `src/store.test.ts`
- Firestore subscription behavior: `src/firestate.integration.test.ts`

## Releases

Publishing is handled by the `Publish Package to npm` workflow when a GitHub
release is published. The package build command is:

```bash
pnpm build
```
