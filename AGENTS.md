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

`src/` is organized by layer: `core/` (subscription engine + store), `react/`
(hooks + providers), `registry/` (public registry API + definition helpers),
`utils/` (framework-agnostic utilities). `index.ts` and `types.ts` stay at the
root. Tests live next to their source; cross-module integration tests and the
test harness live in `src/__tests__/`.

- `src/index.ts` - public exports. Update this when adding public API.
- `src/types.ts` - public state, handle, definition, undo, and config types.
- `src/registry/firestate.ts` - registry API: `createFirestate`, `doc`, `col`,
  path template validation, generated hook typing.
- `src/registry/schema.ts` - lower-level definition helpers.
- `src/react/hooks.ts` - React hooks and `useSyncExternalStore` integration.
- `src/react/provider.tsx` - React providers and unsaved-changes hook.
- `src/core/store.ts` - shared Firestore config, undo manager, global sync
  state, error reporting.
- `src/core/document.ts` - single-document subscription, optimistic state, set,
  update, delete, sync, conflict rebase.
- `src/core/collection.ts` - collection subscription, add, update, remove,
  batched sync, lazy loading.
- `src/core/shared-subscription.ts` - per-store, per-definition registry that
  ref-counts subscriptions keyed by `(path, doc id / query)` so every hook on
  the same resource shares one listener and one state. `readOnly` is a per-handle
  capability layered on top, not part of the key. The hooks resolve a shared
  instance through here instead of constructing their own.
- `src/utils/diff.ts` - Firestore-aware diff, flattening, cloning, equality
  helpers.
- `src/utils/undo.ts` - framework-agnostic undo manager.
- `src/__tests__/test-harness.ts` - deterministic Firestore mock for tests.
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
  listener; only a real change to the query (or `path`) does. `readOnly` is not
  part of the listener key (see the shared-subscription contract below).
  Callers therefore do not need to memoize `queryConstraints` for correctness.
- `useSyncExternalStore` snapshots and handles must have stable identity between
  changes. Do not rebuild snapshots on every `getSnapshot()` call.
- A hook `selector` receives the resource's full observable state
  (`DocumentState`/`CollectionState`) and returns the slice that drives
  re-renders; the hook gates purely on that slice (default value-based
  `valuesEqualForNoOp`, or a supplied `isEqual`). A selected handle exposes ONLY
  that slice as `data` plus the writer surface
  (`update`/`set`/`delete`/`add`/`remove`/`load`/`sync`) and `ref` — status
  fields are absent unless the selector folds them in, so a status flip the
  selector ignores (e.g. `isSynced` churning on a save) cannot re-render it. A
  hook called WITHOUT a selector is unchanged: it returns the full handle and
  re-renders on any field or status change. Writers/`ref` are read live from the
  subscription, not from the memoized selection, so a rebuilt subscription always
  surfaces its own methods even when the selected slice is value-equal.
- A registry entry's `.select(selector, { isEqual? })` derives a **named
  slice-hook** that shares the entry's schema/path (declared once) and becomes a
  flat sibling in the generated API, named by its registry key. The selector is
  `(state, params) => slice`; its second arg declares the slice's own params
  (`PExtra`, default `{}`), and the generated hook's params are the path-template
  params intersected with `PExtra` (one merged bag — `useTaskById({ projectId,
  id })`). `createFirestate` adapts it to the inline `selector` option by closing
  over the call's params bag, so a slice-hook is just a base hook with the
  selector/`isEqual` baked in (call-site options carry only `enabled`/`readOnly`/
  `queryConstraints`). Derived entries are leaves: no `.select(...).select(...)`.
- Subscriptions are shared and ref-counted, keyed by `(definition, resolved
  path, doc id / semantic query identity)`. Every `useDocument` /
  `useCollection` call for the same resource resolves the *same* underlying
  subscription through `src/core/shared-subscription.ts`, so there is one
  `onSnapshot` listener and one reconciled/optimistic state no matter how many
  hooks (or selectors) read it — a write through any handle is instantly visible
  to all of them. The listener attaches on the first `load()` and tears down
  (the underlying `stop()`) only when the *last* subscriber unmounts; the entry
  is then evicted, so a later mount starts a fresh subscription (a lazy
  collection resets to `isActive: false`). Keying by definition object means two
  distinct definitions that resolve to the same path keep independent
  subscriptions. The lower-level `createDocumentSubscription` /
  `createCollectionSubscription` remain unshared single instances for direct
  (non-React) use.
- `readOnly` is a *per-handle capability*, NOT part of the share key. A writable
  hook (the typical provider — the sole writer) and any number of `readOnly:
  true` hooks (leaves that only read-select) on the same resource resolve the
  same entry and the same shared optimistic state. The shared subscription is
  always built writable; a read-only facade neuters only its own handle's
  writers (`update`/`set`/`delete`/`add`/`remove`) and `sync` (its `load` and
  reads pass through), and it does not touch the shared `undoable` flag. A hook
  may pass `readOnly: false` to opt back into writing a read-only-by-default
  definition without forking the shared state.
- Undo recording is a property of the shared subscription, not the individual
  hook: its `onPushUndo` pushes to the store-global undo manager gated by a
  shared `undoable` flag that co-mounted hooks keep in sync (last writer wins).
  Per-call `update(diff, { undoable: false })` still suppresses a single entry.
- Unmounting the last subscriber clears the shared autosave timer and
  unregisters its sync state. Pending debounced edits are not automatically
  flushed on `stop()`.
- Undo actions are client-local. Grouped undo actions undo newest to oldest and
  redo oldest to newest.
- Firestore updates use flattened diffs for `updateDoc`; full document
  replacement and creation use `setDoc`.
- Pending `localState` is rebased onto **every** incoming snapshot, not only
  the one confirming an inflight write. The prior `syncState` is the baseline:
  `localState = applyDiff(newSnapshot, computeDiff(baseline, localState))`, then
  the baseline advances. Untouched fields follow the server; the client's own
  edits survive; same-field concurrent edits stay last-write-wins (local edit
  preserved and re-sent). Do not gate this rebase on `waitingForUpdate`.
- Collections enforce deletes-win: a doc in the baseline but absent from the
  new snapshot was deleted remotely → drop it (and any local edits to it) and
  never recreate it. A doc absent from the baseline but present locally is a
  genuine create (`batch.set`); an existing doc uses `batch.update`.

## Test Guide

Add or update focused tests near the behavior being changed:

- Registry typing/path behavior: `src/registry/schema.test.ts` and
  `src/registry/firestate.test.ts`.
- Document subscription behavior: `src/registry/firestate.test.ts` and
  `src/__tests__/firestate.integration.test.ts`.
- Collection behavior: `src/__tests__/firestate.integration.test.ts` and
  `src/core/store.test.ts`.
- Conflict/rebase and field-path behavior:
  `src/__tests__/conflict-resolution.test.ts`,
  `src/__tests__/reconcile.test.ts`, and `src/__tests__/fieldpath.test.ts`.
- Diff behavior: `src/utils/diff.test.ts`.
- Undo behavior: `src/utils/undo.test.ts`.
- Store/global sync behavior: `src/core/store.test.ts`.

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
