# API Recipes

This file collects examples and edge cases that are easy to miss when using or
modifying Firestate.

## Recommended Registry API

Use `createFirestate`, `doc`, and `col` for normal app code — **one
`createFirestate` call per resource**, in that resource's own module. Each call
owns one document or collection plus its slice-hooks; sibling resources are
sibling modules with their own calls.

```ts
// firestore/spaces.ts
import { z } from 'zod'
import { createFirestate, col } from '@hvakr/firestate'

const SpaceSchema = z.object({
    name: z.string(),
    area: z.number(),
    floor: z.number(),
})

const spaces = col({
    path: 'projects/{projectId}/spaces',
    schema: SpaceSchema,
    lazy: true,
})

export const { useSpaces } = createFirestate({ spaces })
```

```ts
// firestore/project.ts — a separate resource, its own call
const project = doc({ path: 'projects/{projectId}', schema: ProjectSchema })
export const { useProject } = createFirestate({ project })
```

Generated hooks require exactly the params implied by the path template:

```tsx
const project = useProject({ projectId })
const spaces = useSpaces({ projectId })
```

`createFirestate` is a per-resource hook factory, not an app-wide registry. The
recommended layout colocates each resource's schema, base hook, and
[slice-hooks](#named-slice-hooks-select) in one module. Sharing is keyed by
definition identity (a module-scope definition is one stable object), so hooks
from a resource module share one listener everywhere they're used, and every
resource module mounts under the one global `FirestateProvider`. The single
rule: a resource's base hook and all its `.select` slices must be in the **same**
call — splitting one resource across two calls forks its subscription.

## Lower-Level Escape Hatch

Use `defineDocument` and `defineCollection` directly when:

- path derivation does not fit a `{name}` template
- the definition is needed outside React
- a plain TypeScript type is preferred over a Zod schema
- control flow does not fit a module-level registry

```ts
import { defineDocument } from '@hvakr/firestate'

interface Project {
    name: string
    createdAt: number
}

export const projectDoc = defineDocument<Project>({
    collection: (params) => `orgs/${params.orgId}/projects`,
    id: (params) => `${params.projectId}-${params.revision}`,
})
```

```tsx
const project = useDocument({
    definition: projectDoc,
    params: { orgId, projectId, revision },
})
```

## Provider Setup

```tsx
import { FirestateProvider } from '@hvakr/firestate'
import { db } from './firebase'

export function App() {
    return (
        <FirestateProvider
            firestore={db}
            autosave={1000}
            maxUndoLength={20}
        >
            <Routes />
        </FirestateProvider>
    )
}
```

Use `FirestateStoreProvider` only when a pre-created store is needed.

## Zod Validation

Schemas validate full writes:

```ts
project.set({
    name: 'New project',
    createdAt: Date.now(),
})

spaces.add({
    name: 'Lobby',
    area: 500,
    floor: 1,
})
```

Firestate calls `schema.parse(...)`, but stores the original object. Parsed
output is not used. This means transforms, coercions, defaults, and stripping
do not affect stored data. Apply transforms before calling `set` or `add` if
you need transformed output.

Partial updates are not schema-validated:

```ts
import { serverTimestamp } from 'firebase/firestore'

project.update({
    updatedAt: serverTimestamp(),
})
```

This is intentional because Firestore sentinels often do not satisfy strict
Zod schemas.

## Create vs Update

Use `set` to create or fully replace a document:

```ts
project.set({
    name: 'New project',
    createdAt: Date.now(),
})
```

Use `update` only when current data exists:

```ts
if (project.data) {
    project.update({ name: 'Renamed project' })
}
```

Document `update` is ignored when there is no current data. This prevents
partial diffs from creating broken documents.

## Lazy Collections

Lazy collections do not attach a Firestore listener until `load()` is called.

```ts
const spaces = useSpaces({ projectId })

if (!spaces.isActive) {
    return <button onClick={spaces.load}>Load spaces</button>
}
```

Collection mutations are dropped before the first snapshot. Gate mutations on
`isLoaded` (which is `isActive && !isLoading`) or existing data.

```ts
if (spaces.isLoaded) {
    spaces.add({ name: 'Lobby', area: 500, floor: 1 })
}
```

## Enabled Flag

Use `enabled: false` when params are not ready. Disabled hooks return stable
no-op handles and do not resolve paths, so they are useful during route or auth
loading states where an id would otherwise be empty.

```tsx
const project = useProject(
    { projectId: projectId ?? '' },
    { enabled: Boolean(projectId) }
)
```

For the lower-level API:

```tsx
const project = useDocument({
    definition: projectDoc,
    params: projectId ? { projectId } : {},
    enabled: Boolean(projectId),
})
```

Disabled hooks return no-op handles with `isLoaded: false` and no Firestore
reference (the sync-status hooks report `{ isSynced: true, isSaving: false }`).

## Query Constraints

Memoize query constraints. Inline arrays create a new reference on every render
and rebuild the listener.

```tsx
import { orderBy, where } from 'firebase/firestore'
import { useMemo } from 'react'

const queryConstraints = useMemo(
    () => [where('floor', '==', floor), orderBy('name', 'asc')],
    [floor]
)

const spaces = useSpaces({ projectId }, { queryConstraints })
```

### Dynamic queries built from document data

A subtlety with the `useMemo` recipe above: `useMemo` keys on its dependencies
*by reference*. If a dependency is an array or object read out of another
Firestate document, its reference changes on every optimistic update to that
document — Firestate deep-clones local state on edit — even when the contents
are identical. The memo then produces a new constraints array on each edit.

`useCollection` handles this for you. It keys the subscription on the
*semantic identity* of the query, not the array reference: it builds the query
and compares it with Firestore's own `queryEqual`. A fresh array that produces
the same query is ignored, so the listener is not torn down, `isLoaded` does
not flip back to `false`, and a loading gate above the hook does not flash. You
can pass constraints derived from churning document data directly:

```tsx
import { documentId, where } from 'firebase/firestore'

// stationIds comes from another document and may change reference on every
// edit to that document, even when its contents are unchanged. The listener
// survives that churn — it only rebuilds when the query actually changes.
const stationIds = project.data?.weatherSpec.nearestWeatherStationIds ?? []

const stations = useWeatherStations(
    {},
    {
        // Firestore rejects an `in` filter with an empty array, which is what
        // you get before `project.data` loads or when the source list is empty.
        // Gate the subscription so the query is only built once IDs exist.
        enabled: stationIds.length > 0,
        queryConstraints: [where(documentId(), 'in', stationIds)],
    }
)
```

Memoizing `queryConstraints` is still a fine micro-optimization — a stable
reference takes a fast path and skips the per-render query build + compare —
but it is no longer required to keep the listener stable.

**The value driving the query must reach this component reactively.** Read it
from a Firestate hook (`useProject(...)` above) or from props/state derived from
one, so that when another client changes it the component *re-renders* and
`useCollection` is re-invoked with the new query. `useCollection` only re-points
its listener when it is called again with a different query — it cannot observe a
value the component never re-rendered on. The common failure mode in a
collaborative pane is reading the selection once into local `useState` (or from
any source the component isn't subscribed to): a remote change then updates the
underlying document but never re-renders the pane, so the query is stale until
the component remounts (a route change, tab switch, or reload), at which point
render-time resolution reads the now-current value and it "fixes itself." If a
remote selection change only takes effect on remount, this is the cause — make
the selection a live subscription, not a snapshot captured at mount.

## Render Slicing with Selectors

By default a component re-renders on data, load (`isLoaded`), or `error` changes
of the subscribed document or collection — but **not** on `isSynced`, since the
default handle is sync-agnostic (see [Sync and loading status](#sync-and-loading-status)).
Pass a `selector` (in the options object, for both the registry and lower-level
hooks): it receives the resource's full observable state — `isLoading`/`isSynced`
included — and returns the slice the component reacts to, and the component then
re-renders only when that slice changes.

```tsx
// Re-renders only when `name` changes — and not on a save (isSynced) flip,
// because the selector never reads it.
const { data: name } = useProject(
    { projectId },
    { selector: (s) => s.data?.name }
)

// Sub-select one document out of a collection.
const { data: space } = useSpaces(
    { projectId },
    { selector: (s) => s.data[spaceId] }
)
```

A selected handle exposes exactly your slice as `data`, plus the writer surface
(`update`/`set`/`delete`/`add`/`remove`/`load`/`sync`) and `ref` — all still
typed against the full document. The status flags are **not** on it; fold them
into the slice (`s => ({ slice: s.data?.x, saving: !s.isSynced })`) when you need
to react to them. Readers and writers share one hook:

```tsx
const { data: title, update } = useProject(
    { projectId },
    { selector: (s) => s.data?.title }
)
update({ archived: true }) // a full-document update, even though we read `title`
```

`update` takes a *partial* and merges it, so writing a selected field is
`update({ field: next })`. `set`, by contrast, **replaces the whole document** —
passing the selected value (`set(title)`) would overwrite every other field.
From a narrowed handle, prefer `update`; use `set` only when you hold the full
document.

The slice defaults to a deep value comparison, so returning a fresh object/array
of the same shape does not over-render. This matters for collection
sub-selection: an unchanged document may not keep object identity across an
optimistic rebase, but the default comparison still treats it as equal. Pass
`isEqual: shallow` for a cheaper one-level compare on flat projections, or a
custom comparator:

```tsx
import { shallow } from '@hvakr/firestate'

const { data: ids } = useSpaces(
    { projectId },
    { selector: (s) => Object.keys(s.data), isEqual: shallow }
)
```

Selectors do not need to be memoized — an inline selector is fine. It is
recomputed each render but only re-renders the component when its result changes
per `isEqual`.

Selectors scale for free because subscriptions are **shared**. Every hook call
for the same resource — same definition, resolved path, and query — shares one
`onSnapshot` listener and one reconciled state, so ten components each selecting
a different slice of the same document attach one listener, not ten. A write
through any handle is instantly visible to every selector reading that resource,
and the listener is torn down only when the last of them unmounts. `readOnly` is
not part of that key — see [Read-Only Handles](#read-only-handles).

## Named Slice-Hooks (`.select`)

When a slice is reused, named, or parameterized, register it on the entry with
`.select(...)` instead of passing a `selector` at every call site. The derived
hook shares the entry's schema and path (declared once) and is a flat sibling in
the generated API, named by its registry key.

A base entry and all its slices go in the same per-resource call (the tasks
collection here lives in `firestore/tasks.ts`; `project` would be its own module):

```ts
import { createFirestate, col, shallow } from '@hvakr/firestate'

const tasks = col({ path: 'projects/{projectId}/tasks', schema: TaskSchema })

export const { useTasks, useTaskIds, useTaskById } = createFirestate({
    tasks,
    taskIds: tasks.select((s) => Object.keys(s.data), { isEqual: shallow }),
    taskById: tasks.select((s, p: { id: string }) => s.data[p.id]),
})
```

A parameterized selector declares its own params as the selector's second
argument. The generated hook requires them merged with the path params, in one
bag — there is no separate "selector args" position:

```tsx
const ids = useTaskIds({ projectId })              // data: string[]
const task = useTaskById({ projectId, id })        // data: Task | undefined
```

The selector and its `isEqual` are baked into the hook; the call-site options
object is only for runtime knobs (`enabled`, `readOnly`, `queryConstraints`).
Passing `selector`/`isEqual` there is a type error — that distinction is the
point of `.select`.

Most apps wrap these once in a provider hook that pre-supplies the path params,
so feature components never thread `projectId` themselves:

```tsx
// In a ProjectProvider, where projectId is already known:
export function useProjectTaskById(id: string) {
    return useTaskById({ projectId, id })
}
// Feature component: useProjectTaskById(taskId)
```

`.select` is additive: the inline `selector` option (above) still works for
one-off slices. Reach for `.select` when the slice earns a name; keep trivial
one-offs (e.g. a write-only `() => null`) inline. A derived entry is a leaf —
there is no `.select(...).select(...)` chaining.

## Sync and Loading Status

The default data handle is **sync-agnostic**: `data`, `isLoaded`, `error` (plus a
collection's `isActive`) — but no `isSynced`. `isSynced` flips on *every* autosave
settle, so keeping it off the data handle means a component that just renders a
record does not re-render after each save. The handful of components that render
save state opt in instead.

`createFirestate` generates two status hooks beside each base entry's data hook:

```tsx
const { useSpaces, useSpacesSyncStatus, useSpacesLoadingStatus } =
    createFirestate({ spaces: spacesEntry })

// Save indicator / nav blocker — re-renders only when sync state flips.
const { isSynced, isSaving } = useSpacesSyncStatus({ projectId })

// Spinner that does NOT re-render when the data changes.
const { isLoading, isLoaded } = useSpacesLoadingStatus({ projectId })
```

Both share the entry's one `onSnapshot` listener with the data hook (sharing is
keyed by `(definition, path, query)`, not by which hook calls it), so opting in
adds no subscription. Collection status hooks take the same `queryConstraints` as
the data hook — pass the same query so they resolve the same shared entry.

On a **lazy** collection, a status hook never calls `load()` itself — so if it
is the *only* subscriber it attaches no listener and stays idle
(`{ isSynced: true, isSaving: false }` / `{ isLoading: false, isLoaded: false }`).
Mount it alongside the data hook, whose `load()` activates the shared listener
the status hook then rides. Non-lazy collections activate on mount, so this only
affects lazy ones.
`.select` (slice) entries don't get status hooks; read a slice's status through
its base entry. The lower-level API exposes the same as standalone
`useDocumentSyncStatus` / `useDocumentLoadingStatus` /
`useCollectionSyncStatus` / `useCollectionLoadingStatus`, each taking
`{ definition, params, enabled }` (collections also `queryConstraints`).

Keep `isLoaded` on the data handle for the common "spinner until ready" gate —
`useSpacesLoadingStatus` is an extra channel for progress UI rendered apart from
the data, not a replacement.

## Undo and Redo

Undo is enabled by default.

```tsx
const { undo, redo, canUndo, canRedo } = useUndoManager()
```

Skip undo for non-user-facing writes:

```ts
project.update({ lastViewedAt: Date.now() }, { undoable: false })
```

Group multiple writes into one undo action:

```ts
const undoGroupId = crypto.randomUUID()

project.update({ name: 'Renamed' }, { undoGroupId })
spaces.update({ [spaceId]: { name: 'Main room' } }, { undoGroupId })
```

## Manual Sync

Set `autosave: 0` to disable debounced writes, then call `sync()` explicitly.

```ts
const projectDoc = defineDocument({
    schema: ProjectSchema,
    collection: 'projects',
    id: (params) => params.projectId,
    autosave: 0,
})

project.update({ name: 'Draft name' })
await project.sync()
```

## Unsaved Changes

Use global sync state for save indicators and route blockers. `useIsSynced()` is
the provider-wide aggregate across *all* tracked resources; for one resource's
status, use its [`use{Name}SyncStatus`](#sync-and-loading-status) hook.

```tsx
const isSynced = useIsSynced()
const shouldBlock = useUnsavedChangesBlocker()
```

Debounced local edits are not flushed automatically when a subscription
unmounts. Call `handle.sync()` before a save-and-close action if the UI can
await the write.

## Read-Only Handles

Definitions and hooks can be read-only.

```ts
const project = useProject({ projectId }, { readOnly: true })
```

Mutation methods (`update`/`set`/`delete`/`add`/`remove`) and `sync` on a
read-only handle return without queueing writes. Reads — `data`, `isLoaded`,
`error`, `ref`, a collection's `isActive`, and a lazy collection's `load` — work
normally (as do the sync/loading status hooks).

`readOnly` is a **per-handle capability over the shared state, not a state
fork**. A read-only hook shares the same listener and optimistic state as a
writable hook on the same resource, so a write through the writable handle is
instantly visible to the read-only reader. This is the provider/leaf pattern:
one writable hook owns writes (and its undo bridge), while leaves subscribe
`readOnly: true` purely to read-select slices off the same state.

```ts
// Provider: the sole writer. Drives updates and the undo stack.
const project = useProject({ projectId })

// Leaf elsewhere in the tree: reads the same optimistic state, can't write.
const { data: title } = useProject(
    { projectId },
    { readOnly: true, selector: (s) => s.data?.title }
)
```

A read-only-by-default definition can still be written by a specific hook that
opts back in with `readOnly: false` — it gets a writable handle off the same
shared state, no fork.
