# API Recipes

This file collects examples and edge cases that are easy to miss when using or
modifying Firestate.

## Recommended Registry API

Use `createFirestate`, `doc`, and `col` for normal app code.

```ts
import { z } from 'zod'
import { createFirestate, doc, col } from '@hvakr/firestate'

const ProjectSchema = z.object({
    name: z.string(),
    createdAt: z.number(),
})

const SpaceSchema = z.object({
    name: z.string(),
    area: z.number(),
    floor: z.number(),
})

export const { useProject, useSpaces } = createFirestate({
    project: doc({
        path: 'projects/{projectId}',
        schema: ProjectSchema,
    }),
    spaces: col({
        path: 'projects/{projectId}/spaces',
        schema: SpaceSchema,
        lazy: true,
    }),
})
```

Generated hooks require exactly the params implied by the path template:

```tsx
const project = useProject({ projectId })
const spaces = useSpaces({ projectId })
```

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
`isActive`, `isLoading`, or existing data.

```ts
if (spaces.isActive && !spaces.isLoading) {
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

Disabled hooks return no-op handles with `isSynced: true` and no Firestore
reference.

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
the same query is ignored, so the listener is not torn down, `isLoading` does
not flip back to `true`, and a loading gate above the hook does not flash. You
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

Use global sync state for save indicators and route blockers.

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

Mutation methods on read-only handles return without queueing writes.
