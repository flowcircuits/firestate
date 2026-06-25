# Architecture

Firestate has two public API layers over the same core subscription system.

The recommended layer is the registry API:

- `createFirestate(registry)` creates named React hooks. It is used **once per
  resource** (a document or collection plus its slice-hooks), in that resource's
  own module — not once for the whole app.
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
4. The hook resolves a *shared* document or collection subscription for that
   resource — creating it on first use, reusing it otherwise (see "Shared
   subscriptions" below).
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

## Shared subscriptions

`src/core/shared-subscription.ts` is a registry that lets many hooks share one
subscription. Without it, each `useDocument` / `useCollection` call would build
its own subscription in a `useMemo` — its own `onSnapshot` listener and its own
optimistic state — so two components reading the same resource would hold two
divergent copies, and a write through one would not be visible to the other.

The registry is scoped per `FirestateStore` (a `WeakMap`) and, within that, per
*definition* object. A resource is keyed by:

- documents: `(resolved collection path, doc id)` — a plain string key;
- collections: `(resolved collection path)` plus *semantic query identity*.
  Distinct queries on one path coexist as separate entries and are matched with
  Firestore's `queryEqual`, so two hooks whose `queryConstraints` arrays differ
  by reference but build the same query share one listener.

Keying by definition (not just the path string) means two distinct definitions
that happen to resolve to the same path keep independent subscriptions — their
schema or autosave config may differ.

`readOnly` is deliberately **not** part of the key. It is a per-handle
capability over the shared state, not a state fork: a writable hook (the typical
provider, and the sole writer) and any number of `readOnly: true` hooks (leaves
that only read-select) resolve the *same* entry, so a write through the writable
handle is instantly visible to every read-only reader. The shared subscription
is always built writable; a read-only facade neuters only its own handle's
writers and `sync` (`load` and reads pass through) and leaves the shared
`undoable` flag untouched. A hook can pass `readOnly: false` to opt back into
writing a read-only-by-default definition off the same shared state.

Lifecycle is ref-counted and lazy:

- The underlying subscription is created the first time any hook resolves the
  resource (in the hook's render-phase `useMemo`), attaching no listener.
- A hook's `subscribe` effect calls `acquire()` (ref count + 1, register its
  change callback) and then `load()` to activate the one shared listener
  (idempotent — only the first activation attaches it).
- The last hook to `release()` runs the underlying `stop()` and evicts the
  entry, so a subsequent mount starts a fresh subscription. A lazy collection
  therefore resets to `isActive: false` after a full unmount, exactly as a
  single hook does.

Because the state is shared, the per-hook `selector` (see below) slices one
reconciled state rather than maintaining a private one, and a write through any
handle is observed by every reader on the resource. Undo recording belongs to
the shared subscription: its `onPushUndo` pushes to the store-global undo
manager, gated by a shared `undoable` flag that co-mounted hooks keep in sync.

The lower-level `createDocumentSubscription` / `createCollectionSubscription`
are unaffected — they return unshared single instances for direct, non-React
use.

## Registry API

`src/registry/firestate.ts` owns the registry API.

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

### Named slice-hooks (`.select`)

`doc()`/`col()` attach a `.select(selector, { isEqual? })` method that returns a
*derived entry* (`__kind: "document-selected"` / `"collection-selected"`) holding
the original entry as `base` plus the selector and comparator. The base is shared
by reference, so the schema/path is declared once. `createFirestate` builds one
underlying definition **per base entry**, memoized by the base object (`entry`
for a base hook, `entry.base` for a selected one), so the base hook and every
slice derived from it pass the *same* definition to `useDocument`/`useCollection`.
That sharing is load-bearing: the shared-subscription registry keys by definition
identity, so one definition means the base hook and all its slice-hooks resolve
ONE shared subscription (one `onSnapshot` listener, one optimistic state).
Building a fresh definition per generated hook would fork a listener apiece. Each
generated hook then just calls `useDocument`/`useCollection` with the selector and
`isEqual` injected — adapting the entry's `(state, params)` selector to the hook's
inline `selector` option by closing over the call's params bag. A slice-hook is
therefore just a base hook with the projection baked in.

The memoization map is local to each `createFirestate` call, which is what makes
the per-resource layout safe: a resource's base hook and its slices, declared in
one call, resolve one definition and so one subscription. The flip side is the
constraint — splitting a single resource's base and slices across two
`createFirestate` calls produces two definitions and forks the subscription. So
the recommended unit is one resource (doc/col) per module with its own
`createFirestate` call; separate resources are independent by construction.

The type layer carries four parameters on a derived entry — `T`, the path literal
`P`, the selector's own params `PExtra` (default `{}`), and the slice `TSelected`.
`HookFor` matches derived entries first (they have no `path`/`schema`, so they
never collide with the base arms) and maps them to a hook whose params are
`ParamsOf<P> & PExtra` (the merged bag) and whose return is the selected handle.
A single `.select` signature with a defaulted `PExtra` keeps the selector's
`state` argument reliably contextually typed for both one- and two-argument
selectors. Derived entries are leaves — they expose no `.select`, so chaining is
a type error.

## Definitions

`src/registry/schema.ts` contains the lower-level definition helpers. They are mostly
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

`src/core/store.ts` creates the shared `FirestateStore`.

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

`src/react/hooks.ts` wraps subscriptions with `useSyncExternalStore`
(`useSyncExternalStoreWithSelector` for `useDocument`/`useCollection`, which
project and diff the observable state — with or without a `selector`).

Important details:

- Hooks return stable disabled handles when `enabled: false`.
- An optional `selector` receives the resource's full observable state
  (`DocumentState`/`CollectionState`) and returns the slice that drives
  re-renders. The hook routes through `useSyncExternalStoreWithSelector` and
  gates *purely* on that slice via `isEqual` (default: the same
  `valuesEqualForNoOp` value compare the subscription itself uses). A selected
  handle is re-wrapped to expose only the slice as `data` plus the writers and
  `ref`; the status fields (`isLoading`/`isSynced`/`error`/`isActive`) are
  omitted unless the selector reads them into the slice, so churn on an
  unselected status flag (e.g. `isSynced` on a save) cannot re-render it. A hook
  with no `selector` instead projects the full observable state and re-renders on
  any field or status change — the full handle. Either way the projection
  deliberately excludes methods and `ref`; those are read *live* from the current
  subscription's `getHandle()` at render time. Otherwise a subscription rebuild
  whose projection happened to be value-equal would be collapsed by `isEqual`,
  and the hook would keep handing back the previous subscription's methods (e.g.
  `load()` against torn-down constraints).
- Disabled hooks do not resolve params or create subscriptions.
- Toggling `undoable` should not rebuild Firestore listeners.
- `queryConstraints` are keyed by semantic query identity, not array
  reference. `QueryConstraint` objects are opaque, so Firestate never
  hand-rolls a deep compare; instead `useCollection` builds the query and
  compares it with Firestore's own `queryEqual`. When upstream state churns
  array references without changing the query (e.g. ids read from a
  deep-cloned document), the listener is preserved; a genuine query change
  rebuilds it. Callers need not memoize the array for correctness.
- Subscription handles are cached until state changes, so React sees stable
  snapshots between commits.

## Document Subscriptions

`src/core/document.ts` owns single-document behavior.

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

On **every** incoming snapshot — not only the one that confirms an inflight
write — Firestate rebases pending local edits onto the new server state. The
snapshot that was previously in `syncState` acts as the *baseline*: the user's
own edits are re-derived as `computeDiff(baseline, localState)` and re-applied
over the new snapshot, then the baseline advances. Fields the user did not touch
follow the server (so a collaborator's change to another field is adopted), and
the user's actual edits are preserved. If the rebase leaves nothing differing
from the server, `localState` is dropped and the subscription is back in sync.

Same-field concurrent edits stay last-write-wins: the local edit is preserved
and re-sent on the next sync. Rebasing continuously (rather than only inside the
inflight window) is what prevents a concurrent snapshot from leaving a pending
edit on a stale base — the cause of the optimistic-revert / collaborator-clobber
class of bugs.

## Collection Subscriptions

`src/core/collection.ts` owns collection behavior.

Collections store data as `Record<string, T>`, keyed by Firestore document id.
Snapshot data is normalized so each document includes its `id`.

Collection mutations require the first snapshot. Before that, `add`, `update`,
and `remove` bail rather than guessing what server fields exist.

`add(data)` can auto-generate an id synchronously. It returns `undefined` if
the mutation is dropped.

The continuous rebase (see Document Subscriptions) runs per document. It also
enforces **deletes win**: a document present in the baseline but absent from the
new snapshot was deleted remotely, so it is dropped from `localState` along with
any pending edits to it and is never recreated — even if this client was editing
it when the delete landed.

Collection sync uses a Firestore write batch:

- new docs (absent from the server) use `batch.set`
- existing docs use `batch.update` with flattened diffs — `updateDoc` fails if
  the doc was deleted in a race, so a remotely-deleted doc is not resurrected
- removed docs use `batch.delete`

## Diff Utilities

`src/utils/diff.ts` is Firestore-aware:

- removed fields become `deleteField()`
- arrays are replaced as whole values
- nested plain objects are recursively diffed
- `Timestamp` values are compared and cloned specially
- Firestore sentinels are preserved while flattening

These helpers are shared by document sync, collection sync, and undo.

## Undo

`src/utils/undo.ts` is framework agnostic.

Subscriptions push undo actions eagerly when local mutations are made. Grouped
actions with the same `groupId` are merged. Undo applies grouped actions from
newest to oldest; redo applies them from oldest to newest.

Undo state is local to the current store/client. It does not sync through
Firestore.
