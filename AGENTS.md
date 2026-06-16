# Firestate Agent Guide

This file is the repo-level operating manual for coding agents. Read it before
changing code.

## What This Package Is

Firestate is a TypeScript library for using Cloud Firestore from React with
real-time listeners, optimistic local state, debounced writes, undo/redo, sync
state tracking, and optional Zod validation.

The recommended application API is registry-based:

```ts
import { z } from 'zod'
import { createFirestate, doc, col } from '@hvakr/firestate'

const TaskListSchema = z.object({ name: z.string(), createdAt: z.number() })
const TaskSchema = z.object({
    title: z.string(),
    completed: z.boolean(),
})

export const { useTaskList, useTasks } = createFirestate({
    taskList: doc({ path: 'taskLists/{listId}', schema: TaskListSchema }),
    tasks: col({ path: 'taskLists/{listId}/tasks', schema: TaskSchema }),
})
```

The lower-level API is `defineDocument` / `defineCollection` plus
`useDocument` / `useCollection`. Use it for custom path derivation, non-React
usage, or plain TypeScript shapes without Zod validation.

## Commands

Use pnpm.

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

CI runs `pnpm typecheck`, `pnpm build`, and `pnpm test` on Node 22.

## Source Map

- `src/index.ts` - public exports. Update this when adding public API.
- `src/firestate.ts` - registry API: `createFirestate`, `doc`, `col`, path
  template validation, generated hook typing.
- `src/schema.ts` - lower-level definition helpers.
- `src/types.ts` - public state, handle, definition, undo, and config types.
- `src/hooks.ts` - React hooks and `useSyncExternalStore` integration.
- `src/provider.tsx` - React providers and unsaved-changes hook.
- `src/store.ts` - shared Firestore config, undo manager, global sync state,
  error reporting.
- `src/document.ts` - single-document subscription, optimistic state, set,
  update, delete, sync, conflict rebase.
- `src/collection.ts` - collection subscription, add, update, remove, batched
  sync, lazy loading.
- `src/diff.ts` - Firestore-aware diff, flattening, cloning, equality helpers.
- `src/undo.ts` - framework-agnostic undo manager.
- `examples/react-tasks/` - runnable React + Firebase example.

## Behavioral Contracts

Preserve these unless the task explicitly changes them.

- The registry API requires Zod schemas. `doc()` and `col()` infer data types
  from `schema` and infer hook params from `{name}` placeholders in `path`.
- `defineDocument` and `defineCollection` keep the plain TypeScript escape
  hatch. Their `schema` field is optional.
- Schemas are validation guards only. Firestate calls `schema.parse(...)` on
  full writes (`document.set`, `collection.add`) but stores the caller's
  original object. Do not store the parsed result unless intentionally changing
  this contract.
- Partial `update(diff)` calls are not Zod-validated because diffs may include
  Firestore sentinels such as `serverTimestamp()`, `arrayUnion()`, or
  `deleteField()`.
- Document `update()` requires existing current data. Use `set()` to create or
  replace a document.
- Collection `add`, `update`, and `remove` require the first snapshot. They
  bail before the initial snapshot to avoid clobbering unknown server fields.
- `enabled: false` on hooks must not resolve paths or create subscriptions. It
  returns stable no-op handles.
- `queryConstraints` are keyed by *semantic query identity*, not by array
  reference. Never hand-roll a deep compare of `QueryConstraint` objects — they
  are opaque. `useCollection` builds the query and compares it with Firestore's
  `queryEqual`, so a fresh array producing the same query does not rebuild the
  listener; only a real change to the query (or `path`/`readOnly`) does.
  Callers therefore do not need to memoize `queryConstraints` for correctness.
- `useSyncExternalStore` snapshots and handles must have stable identity between
  changes. Do not rebuild snapshots on every `getSnapshot()` call.
- Unmounting a subscription clears its autosave timer and unregisters its sync
  state. Pending debounced edits are not automatically flushed on `stop()`.
- Undo actions are client-local. Grouped undo actions undo newest to oldest and
  redo oldest to newest.
- Firestore updates use flattened diffs for `updateDoc`; full document
  replacement and creation use `setDoc`.

## Test Guide

Add or update focused tests near the behavior being changed:

- Registry typing/path behavior: `src/schema.test.ts` and
  `src/firestate.test.ts`.
- Document subscription behavior: `src/firestate.test.ts` and
  `src/firestate.integration.test.ts`.
- Collection behavior: `src/firestate.integration.test.ts` and
  `src/store.test.ts`.
- Diff behavior: `src/diff.test.ts`.
- Undo behavior: `src/undo.test.ts`.
- Store/global sync behavior: `src/store.test.ts`.

Before finishing code changes, run at least:

```bash
pnpm typecheck
pnpm test
```

For public API or build output changes, also run:

```bash
pnpm build
```

## Documentation

- User README: `README.md`
- Architecture notes: `docs/architecture.md`
- Usage recipes: `docs/api-recipes.md`
- Contributor workflow: `CONTRIBUTING.md`

When changing public behavior, update the README or docs in the same change.
