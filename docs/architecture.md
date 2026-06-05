# Architecture

Firestate has two public API layers over the same core subscription system.

The recommended layer is the registry API:

- `createFirestate(registry)` creates named React hooks.
- `doc({ path, schema })` declares one document entry.
- `col({ path, schema })` declares one collection entry.

The lower-level layer is:

- `defineDocument(definition)` and `defineCollection(definition)`
- `useDocument({ definition, params })`
- `useCollection({ definition, params })`
- `createDocumentSubscription(...)` and `createCollectionSubscription(...)`

Both layers share the same store, undo manager, diff helpers, autosave logic,
sync tracking, and Firestore listener behavior.

## Data Flow

At runtime, a typical React app follows this flow:

1. The app renders `FirestateProvider` with a Firestore instance.
2. `FirestateProvider` creates a `FirestateStore`.
3. A generated hook from `createFirestate`, or a direct call to `useDocument`
   / `useCollection`, resolves the Firestore path from params.
4. The hook creates a document or collection subscription.
5. The subscription attaches an `onSnapshot` listener when loaded.
6. Snapshots update `syncState`.
7. Mutations update `localState` immediately and schedule autosave.
8. `sync()` computes a diff and writes to Firestore.
9. Later snapshots confirm the write or cause pending local edits to be
   rebased over newer server state.

The public handle always exposes merged data:

```ts
merged = localState ?? syncState
```

For documents, `localState === null` represents a pending delete and surfaces
as `data: undefined`.

## Registry API

`src/firestate.ts` owns the registry API.

Path templates use `{name}` placeholders:

```ts
doc({ path: 'projects/{projectId}', schema: ProjectSchema })
col({ path: 'projects/{projectId}/spaces', schema: SpaceSchema })
```

The template is used twice:

- At the type level, placeholder names become required hook params.
- At runtime, placeholders are interpolated before creating the lower-level
  definition.

Document paths are split at the final slash. For
`projects/{projectId}/revisions/{revisionId}`, the collection path is
`projects/{projectId}/revisions` and the document id template is
`{revisionId}`.

The registry API intentionally requires Zod schemas. Use the lower-level API
when a plain TypeScript definition or custom path derivation is needed.

## Definitions

`src/schema.ts` contains the lower-level definition helpers. They are mostly
identity functions with useful generic overloads.

`defineDocument` accepts:

- `collection`: a string or params function
- `id`: a string or params function
- optional `schema`
- autosave, loading, read-only, and retry options

`defineCollection` accepts:

- `path`: a string or params function
- optional `schema`
- optional lazy loading
- optional Firestore query constraints
- autosave, loading, read-only, and retry options

## Store

`src/store.ts` creates the shared `FirestateStore`.

The store owns:

- the Firestore instance
- default autosave and min-load-time config
- the undo manager
- global sync-state tracking
- error reporting

Each subscription registers a unique sync key. On stop, the subscription must
unregister that key so `useIsSynced()` cannot get stuck on stale unsynced
state.

## React Hooks

`src/hooks.ts` wraps subscriptions with `useSyncExternalStore`.

Important details:

- Hooks return stable disabled handles when `enabled: false`.
- Disabled hooks do not resolve params or create subscriptions.
- Toggling `undoable` should not rebuild Firestore listeners.
- `queryConstraints` are compared by reference; callers should memoize arrays.
- Subscription handles are cached until state changes, so React sees stable
  snapshots between commits.

## Document Subscriptions

`src/document.ts` owns single-document behavior.

State has three local edit cases:

- `undefined`: no pending local edits
- `null`: pending delete
- object: pending set or update

`update(diff)`:

- requires current data
- applies the diff locally
- pushes an undo action unless disabled
- schedules autosave
- syncs later with `updateDoc(flattenDiff(diff))`

`set(data)`:

- validates with Zod when a schema is present
- stores the caller's original object, not the parsed value
- creates or replaces the document with `setDoc`

`delete()`:

- marks a pending delete locally
- syncs later with `deleteDoc`

When a snapshot arrives during an inflight write, Firestate compares the
inflight local state with the current local state. If the user made more local
edits while the write was inflight, those edits are rebased onto the new
server snapshot.

## Collection Subscriptions

`src/collection.ts` owns collection behavior.

Collections store data as `Record<string, T>`, keyed by Firestore document id.
Snapshot data is normalized so each document includes its `id`.

Collection mutations require the first snapshot. Before that, `add`, `update`,
and `remove` bail rather than guessing what server fields exist.

`add(data)` can auto-generate an id synchronously. It returns `undefined` if
the mutation is dropped.

Collection sync uses a Firestore write batch:

- new docs use `batch.set`
- existing docs use `batch.update` with flattened diffs
- removed docs use `batch.delete`

## Diff Utilities

`src/diff.ts` is Firestore-aware:

- removed fields become `deleteField()`
- arrays are replaced as whole values
- nested plain objects are recursively diffed
- `Timestamp` values are compared and cloned specially
- Firestore sentinels are preserved while flattening

These helpers are shared by document sync, collection sync, and undo.

## Undo

`src/undo.ts` is framework agnostic.

Subscriptions push undo actions eagerly when local mutations are made. Grouped
actions with the same `groupId` are merged. Undo applies grouped actions from
newest to oldest; redo applies them from oldest to newest.

Undo state is local to the current store/client. It does not sync through
Firestore.
