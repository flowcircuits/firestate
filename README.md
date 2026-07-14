# Firestate

Firestore state management for React with real-time sync, undo/redo, optimistic updates, and Zod schema validation.

[![npm version](https://badge.fury.io/js/@hvakr%2Ffirestate.svg)](https://www.npmjs.com/package/@hvakr/firestate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why Firestate?

Managing Firestore state in React applications typically involves:

- Setting up real-time listeners with proper cleanup
- Handling optimistic updates and conflict resolution
- Tracking sync state across multiple documents/collections
- Implementing undo/redo functionality
- Lots of boilerplate code that's easy to get wrong

Firestate provides a declarative, schema-first approach that eliminates boilerplate while giving you production-ready features out of the box.

## Features

- **Zod schemas as the source of truth**: each document/collection is declared with a [Zod](https://zod.dev) schema; firestate infers the TypeScript type via `z.infer` and validates writes at runtime
- **Real-time sync**: Automatic Firestore listeners with proper lifecycle management
- **Shared subscriptions**: Every hook reading the same resource shares one listener and one state, ref-counted across mounts — a write through any handle is instantly visible everywhere
- **Optimistic updates**: Changes reflect immediately, sync in background
- **Conflict resolution**: Automatic rebasing when concurrent changes occur
- **Undo/redo**: Built-in command pattern with action grouping
- **Lazy loading**: Collections can defer subscription until needed
- **Diff-based updates**: Only changed fields are sent to Firestore

## Choosing an API

Firestate exposes two layers. Pick one based on what you're building:

- **`createFirestate` + `doc` / `col`** (recommended for app code) — declare a Firestore resource (a document or collection) with a `path` template and a Zod `schema`, and the library generates one typed React hook per entry. In return you get:
    - the data type (`TaskList`) inferred from the schema via `z.infer`
    - the param keys (`{ listId }`) inferred from the path template and enforced at call sites
    - runtime validation on `set` / `add` writes — bad data throws at the call site instead of after a Firestore round trip

    Partial `update(diff)` calls are intentionally NOT validated: diffs commonly include Firestore sentinels like `serverTimestamp()` that a strict schema would reject.

    Treat `createFirestate` as a **per-resource hook factory**, not an app-wide registry: give each document/collection its own module (`firestore/taskList.ts`, `firestore/tasks.ts`, …) with one `createFirestate` call, and export the hooks flat. See [Organizing by resource](#organizing-by-resource).

    ```ts
    // firestore/taskList.ts
    import { z } from 'zod'
    import { createFirestate, doc } from '@hvakr/firestate'

    const TaskListSchema = z.object({ name: z.string(), createdAt: z.number() })

    const taskList = doc({ path: 'taskLists/{listId}', schema: TaskListSchema })

    export const { useTaskList } = createFirestate({ taskList })

    // useTaskList({ listId })           — { listId: string } statically required
    // useTaskList()                     — type error: missing listId
    // useTaskList({ wrong: 'a' })       — type error: wrong key
    ```

- **`defineDocument` / `defineCollection` + `useDocument` / `useCollection`** (lower-level escape hatch) — write the path-derivation function yourself, use the standalone hooks. Reach for these when:
    - your path doesn't fit the `{name}` template (computed from non-string state, conditional segments)
    - you need the definition outside React (Node scripts, server-side, tests)
    - your control flow doesn't fit a module-level registry
    - you want plain TypeScript types without a Zod schema (the schema field is optional here)

Both layers share the same store, undo manager, and sync semantics — the registry is a thin layer on top of the lower-level primitives.

### Organizing by resource

`createFirestate` is best used **once per resource**, not once for your whole app. Put each document or collection in its own module — its schema, its base hook, and its [named slice-hooks](#named-slice-hooks-select) together — and call `createFirestate` there:

```ts
// firestore/tasks.ts
import { z } from 'zod'
import { createFirestate, col } from '@hvakr/firestate'

const TaskSchema = z.object({
    title: z.string(),
    completed: z.boolean(),
    createdAt: z.number(),
})
const tasks = col({ path: 'taskLists/{listId}/tasks', schema: TaskSchema })

export const { useTasks, useTaskById } = createFirestate({
    tasks, // → useTasks (full handle)
    taskById: tasks.select((s, p: { id: string }) => s.data[p.id]),
})

// firestore/taskList.ts is a sibling module with its own createFirestate call.
// Components import directly from the resource: `import { useTaskById } from './firestore/tasks'`.
```

Why per-resource rather than one central call:

- **It scales.** A central registry becomes a chokepoint every feature edits; resource modules keep a resource's schema, hooks, and slices colocated and let you code-split.
- **Sharing still works app-wide.** Subscriptions are keyed by _definition identity_, and a resource module's definition lives at module scope (one stable object), so every component using `useTasks`/`useTaskById` shares one `onSnapshot` listener and one optimistic state — no matter how many modules.
- **The store stays global.** All resource modules mount under one `FirestateProvider`, so undo/redo and sync tracking span every resource regardless of how you split the files.

**The one rule:** keep a resource's base hook _and_ all its `.select` slices in the **same** `createFirestate` call. Each call builds its own definitions, so splitting one resource across two calls would fork it into two listeners. Separate _resources_ in separate calls is exactly what you want; separating _one_ resource is the mistake.

## Table of Contents

- [Choosing an API](#choosing-an-api)
- [Organizing by resource](#organizing-by-resource)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Examples](#examples)
- [Documentation](#documentation)
- [Core Concepts](#core-concepts)
- [API Reference](#api-reference)
- [Diff Utilities](#diff-utilities)
- [Advanced Usage](#advanced-usage)
- [Testing](#testing)
- [Contributing](#contributing)

## Installation

```bash
pnpm add @hvakr/firestate
# or
npm install @hvakr/firestate
# or
yarn add @hvakr/firestate
```

### Peer Dependencies

Firestate requires the following peer dependencies:

```json
{
    "firebase": "^10.0.0 || ^11.0.0",
    "react": "^18.0.0 || ^19.0.0",
    "zod": "^4.0.0"
}
```

Firestate is opinionated about Zod 4. Schemas drive both the inferred
TypeScript types and runtime validation on `set` / `add` writes.

## Quick Start

### 1. Define your data

```typescript
// schemas.ts
import { defineDocument, defineCollection } from '@hvakr/firestate'

// Plain TypeScript interfaces — no runtime validator required
interface Project {
    name: string
    description?: string
    createdAt: number
    updatedAt: number
}

interface Space {
    name: string
    area: number
    floor: number
}

// Create a document definition
export const projectDoc = defineDocument<Project>({
    collection: 'projects',
    id: (params) => params.projectId,
    autosave: 1000, // Debounce writes by 1 second
})

// Create a collection definition
export const spacesCollection = defineCollection<Space>({
    path: (params) => `projects/${params.projectId}/spaces`,
    lazy: true, // Only subscribe when load() is called
})
```

#### Validating with Zod

Pass a Zod schema via the `schema` field. `TData` is inferred from
`z.infer<typeof Schema>`, and firestate runs `schema.parse(...)` on
`set` / `add` writes — bad data throws at the call site rather than
after a Firestore round trip. Partial `update(diff)` is not validated
(diffs frequently carry Firestore sentinels).

```typescript
import { z } from 'zod'
import { defineDocument } from '@hvakr/firestate'

const ProjectSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
})

export const projectDoc = defineDocument({
    schema: ProjectSchema,
    collection: 'projects',
    id: (params) => params.projectId,
})
```

### 2. Set up the provider

```tsx
// App.tsx
import { FirestateProvider } from '@hvakr/firestate'
import { db } from './firebase'

function App() {
    return (
        <FirestateProvider firestore={db} autosave={1000} maxUndoLength={20}>
            <YourApp />
        </FirestateProvider>
    )
}
```

### 3. Use in components

```tsx
// ProjectEditor.tsx
import {
    useDocument,
    useCollection,
    useDocumentSyncStatus,
    useUndoManager,
} from '@hvakr/firestate'
import { projectDoc, spacesCollection } from './schemas'

function ProjectEditor({ projectId }: { projectId: string }) {
    const params = { projectId }

    // Subscribe to project document. The default handle is sync-agnostic — it
    // carries `data`/`isLoaded`/`error`, not `isSynced`, so it does NOT
    // re-render when a save settles.
    const project = useDocument({ definition: projectDoc, params })

    // Subscribe to spaces collection (lazy)
    const spaces = useCollection({ definition: spacesCollection, params })

    // Opt into save state only where you render it — shares the project's one
    // listener, so it doesn't add a subscription.
    const { isSaving } = useDocumentSyncStatus({
        definition: projectDoc,
        params,
    })

    // Access undo/redo
    const { undo, redo, canUndo, canRedo } = useUndoManager()

    if (!project.isLoaded) return <Spinner />
    if (!project.data) return <NotFound />

    return (
        <div>
            {/* Undo/Redo buttons */}
            <button onClick={undo} disabled={!canUndo}>
                Undo
            </button>
            <button onClick={redo} disabled={!canRedo}>
                Redo
            </button>

            {/* Edit project name - changes auto-save */}
            <input
                value={project.data.name}
                onChange={(e) => project.update({ name: e.target.value })}
            />

            {/* Lazy-load spaces */}
            {!spaces.isActive ? (
                <button onClick={spaces.load}>Load Spaces</button>
            ) : !spaces.isLoaded ? (
                <Spinner />
            ) : (
                <ul>
                    {Object.values(spaces.data).map((space) => (
                        <li key={space.id}>
                            {space.name} - {space.area} sq ft
                        </li>
                    ))}
                </ul>
            )}

            {/* Sync indicator */}
            {isSaving && <span>Saving...</span>}
        </div>
    )
}
```

## Examples

Check out the [examples](./examples) directory for complete, runnable examples:

- **[React Tasks](./examples/react-tasks)** - A simple task manager demonstrating documents, collections, undo/redo, sync indicators, and real-time updates.

## Documentation

- [Architecture](./docs/architecture.md) - how the registry API, hooks, store, subscriptions, diffing, sync, and undo layers fit together.
- [API Recipes](./docs/api-recipes.md) - focused examples for common usage patterns and edge cases.
- [Contributing](./CONTRIBUTING.md) - local setup, commands, tests, and release notes.
- [Agent Guide](./AGENTS.md) - repo map and behavioral contracts for AI coding agents.
- [Claude Instructions](./CLAUDE.md) - short pointer for Claude Code.

## Core Concepts

### Documents vs Collections

- **Document**: A single Firestore document with a known path
- **Collection**: A set of documents, optionally with query constraints

### Optimistic Updates

When you call `update()`, the change is applied immediately to local state. The library then:

1. Computes the minimal diff
2. Debounces writes (configurable `autosave` interval)
3. Sends only changed fields to Firestore using dot-notation (flattened keys)
4. Handles any conflicts from concurrent changes

### Update vs Set

Firestate uses Firestore's `updateDoc` for partial updates and `setDoc` for full replacements:

- **`update(diff)`** - Uses `updateDoc` with flattened dot-notation keys. This prevents accidentally recreating a document that was deleted by another user. If the document doesn't exist, the update will fail.

- **`set(data)`** - Uses `setDoc` to create or completely replace a document. Use this when you intentionally want to create a new document or overwrite an existing one.

```tsx
// Partial update - only changes 'name', fails if document was deleted
project.update({ name: 'New Name' })

// Full replacement - creates document if it doesn't exist
project.set({ name: 'New Project', createdAt: Date.now() })
```

This distinction is important for collaborative applications where multiple users may be editing simultaneously.

### Undo/Redo

Every undoable update automatically creates an undo action. Actions with the same `undoGroupId` are merged:

```tsx
const groupId = crypto.randomUUID()

// These two updates become a single undo action
project.update({ name: 'New Name' }, { undoGroupId: groupId })
spaces.update({ space1: { name: 'Updated' } }, { undoGroupId: groupId })
```

Grouped actions undo newest-first and redo oldest-first, so one undo/redo
always applies the complete group in write order.

To skip undo tracking:

```tsx
project.update({ lastViewed: Date.now() }, { undoable: false })
```

#### Navigation-aware undo/redo

When an undo action is tagged with a `path`, undo/redo can return the user to
the route where the change occurred before reverting it. Wire your router's
`navigate` via `onNavigate` on `FirestateProvider`:

```tsx
import { useNavigate } from 'react-router-dom'

function App() {
    const navigate = useNavigate()

    return (
        <FirestateProvider
            firestore={db}
            onNavigate={(path) => navigate(path)}
            onUndo={(action) =>
                analytics.track('undo', { description: action.description })
            }
            onRedo={(action) =>
                analytics.track('redo', { description: action.description })
            }
        >
            {children}
        </FirestateProvider>
    )
}
```

When creating the store manually, pass `onNavigate` to `createStore`:

```ts
const store = createStore({
    firestore: db,
    onNavigate: (path) => router.push(path),
})
```

Actions record a path via the `path` field on `UndoAction`:

```tsx
undoManager.push({
    undo: () => restoreValue(),
    redo: () => applyValue(),
    path: '/projects/123', // navigate here on undo/redo
})
```

Undo actions pushed by a normal handle write (`update`/`add`/`remove`) can't set
`path` at the call site, so on their own they never trigger `onNavigate`. Give
the store a `getUndoPath` callback and it stamps the current router path onto
every handle-pushed action, so navigation-aware undo works for ordinary writes —
not just manual `undoManager.push({ path })`. Read the path from your router:

```tsx
import { useLocation, useNavigate } from 'react-router-dom'

function App() {
    const location = useLocation()
    const navigate = useNavigate()

    return (
        <FirestateProvider
            firestore={db}
            getUndoPath={() => location.pathname}
            onNavigate={(path) => navigate(path)}
        >
            {children}
        </FirestateProvider>
    )
}
```

`getUndoPath` also works on `createStore({ firestore: db, getUndoPath: () => router.currentPath })`.
Return `undefined` to leave an action pathless. When actions merge into one undo
group, the merged group keeps the newest action's path.

### Lazy Collections

For large applications, you may not want to subscribe to every collection immediately:

```tsx
const spacesCollection = defineCollection({
    schema: SpaceSchema,
    path: (params) => `projects/${params.projectId}/spaces`,
    lazy: true, // Don't subscribe until load() is called
})

// In component
const spaces = useCollection({ definition: spacesCollection, params })
spaces.load() // Start subscription
```

### Sync State Tracking

The library tracks whether all documents/collections are synced:

```tsx
import { useIsSynced, useUnsavedChangesBlocker } from '@hvakr/firestate'

function App() {
    const isSynced = useIsSynced()
    const shouldBlock = useUnsavedChangesBlocker()

    // Use with react-router's useBlocker
    const blocker = useBlocker(
        ({ currentLocation, nextLocation }) =>
            currentLocation.pathname !== nextLocation.pathname && shouldBlock
    )

    return (
        <>
            {!isSynced && <SavingIndicator />}
            {blocker.state === 'blocked' && (
                <Dialog>Your changes may not be saved!</Dialog>
            )}
        </>
    )
}
```

### Pending edits on unmount

Writes are debounced by `autosave` (default 1000 ms). The subscription is
shared and ref-counted, so its state and autosave timer survive as long as any
hook is still reading the resource. Only when the **last** reader unmounts with
unflushed local edits are those edits dropped silently — the shared subscription
is torn down and its autosave timer cleared. To handle this:

- **Block navigation** with `useUnsavedChangesBlocker` (shown above) so users
  can't navigate away while writes are pending.
- **Force a flush** by calling `handle.sync()` before triggering the unmount
  (e.g., in a custom save-and-close button).
- **Lower `autosave`** if the debounce window is the source of risk.

There is no automatic flush in the subscription's `stop()` because `stop()`
is synchronous and consumers may unmount during route transitions where
awaiting writes is not feasible.

## API Reference

### Registry API

#### `createFirestate(registry)`

Creates typed React hooks from a registry object. Each key becomes a hook named
`use{CapitalizedKey}`.

Call it **once per resource** — a document or collection with its base hook and
its [slice-hooks](#named-slice-hooks-select) — in that resource's own module. See
[Organizing by resource](#organizing-by-resource) for why, and the one sharing
rule that comes with it.

```typescript
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

Generated hooks require the params implied by the path template:

```tsx
const spaces = useSpaces({ projectId })
```

Use the second argument for hook options such as `enabled`, `readOnly`,
`undoable`, or collection `queryConstraints`:

```tsx
const spaces = useSpaces(
    { projectId },
    { enabled: Boolean(projectId), queryConstraints }
)
```

#### `doc(options)` and `col(options)`

Declare registry entries. A Zod `schema` is required and drives both the
generated TypeScript data type and runtime validation for full writes.

```typescript
doc({
    path: 'projects/{projectId}',
    schema: ProjectSchema,
    autosave: 1000,
    readOnly: false,
    retryOnError: false,
})

col({
    path: 'projects/{projectId}/spaces',
    schema: SpaceSchema,
    lazy: true,
    queryConstraints: [],
})
```

Path placeholders must look like `{name}`. Empty param values throw at runtime
when a path is resolved.

#### Named slice-hooks (`.select`)

A bare entry generates a full-handle hook. Call `.select(...)` on an entry to
derive a **named slice-hook** that shares the entry's schema and path — so the
schema is declared once and reused — and re-renders only when its slice changes.
Each derived hook is a flat sibling in the API, named by its registry key:

Define each `.select` slice in the **same** `createFirestate` call as its base
entry — one resource per module (see [Organizing by resource](#organizing-by-resource)):

```typescript
// firestore/tasks.ts
const tasks = col({ path: 'projects/{projectId}/tasks', schema: TaskSchema })

export const { useTasks, useTaskIds, useTaskById } = createFirestate({
    tasks, // → useTasks (full handle)
    taskIds: tasks.select((s) => Object.keys(s.data), { isEqual: shallow }),
    // Parameterized: the selector declares its own params; the generated
    // hook then requires them alongside the path params, in one bag.
    taskById: tasks.select((s, p: { id: string }) => s.data[p.id]),
})

// firestore/project.ts — a separate resource, its own call:
// export const { useProject, useProjectTitle } = createFirestate({
//     project,
//     projectTitle: project.select((s) => s.data?.name),
// })
```

The selector receives the same full observable state as the inline `selector`
option (see [Selecting a slice](#selecting-a-slice-selector--isequal)) and, for a
parameterized slice, the merged params bag. At the call site you pass that one
bag and (optionally) the runtime options — the selector and `isEqual` are baked
into the hook, never passed per call:

```tsx
const ids = useTaskIds({ projectId }) //                data: string[]
const one = useTaskById({ projectId, id }) //           data: Task | undefined  (merged bag)
const disabled = useTaskById({ projectId, id }, { enabled: false })
```

A slice-hook returns a selected handle: `data` is the slice, plus the full
writer surface and `ref` — so `one.update({ ... })` still writes the whole task,
and a document slice-hook's `set` still replaces the whole document. Status
fields are not on it unless the slice reads them.

A base hook and all its slice-hooks share **one** subscription (one
`onSnapshot` listener, one optimistic state), so a write through any of them is
instantly visible to the rest — which is why they must live in one
`createFirestate` call. The inline `selector` option on the base hook still works
for one-off slices; reach for `.select` when a slice is named, reused, or
parameterized. (A derived entry is a leaf — there is no `.select(...).select(...)`
chaining.)

### Definition Helpers

#### `defineDocument(definition)`

Creates a document definition. Provide the document shape via the `TData`
type parameter, or let it be inferred from a Zod schema.

```typescript
const projectDoc = defineDocument<Project>({
    collection: 'projects', // Collection path
    id: (params) => params.id, // Document ID (string or function)
    autosave: 1000, // Optional: debounce interval (ms)
    minLoadTime: 0, // Optional: minimum loading time (ms)
    readOnly: false, // Optional: prevent updates
    retryOnError: false, // Optional: retry on listener errors
    retryInterval: 5000, // Optional: retry interval (ms)
    schema: ProjectSchema, // Optional: Zod schema (validates set/add)
})
```

#### `defineCollection(definition)`

Creates a collection definition.

```typescript
const spacesCollection = defineCollection<Space>({
    path: (params) => `projects/${params.id}/spaces`, // Collection path
    autosave: 1000, // Optional: debounce interval
    minLoadTime: 0, // Optional: minimum loading time
    readOnly: false, // Optional: prevent updates
    lazy: false, // Optional: defer subscription
    queryConstraints: [], // Optional: Firestore constraints
    schema: SpaceSchema, // Optional: Zod schema (validates add)
})
```

### React Hooks

#### `useDocument(options)`

Subscribe to a document.

```typescript
const {
    data, // Current document data (T | undefined)
    update, // Update with partial diff
    set, // Replace entire document
    delete: del, // Delete the document
    isLoaded, // Whether the initial snapshot has arrived (ready to render)
    sync, // Force sync immediately
    error, // Error from listener, if any
    ref, // Firestore DocumentReference
} = useDocument({
    definition: projectDoc,
    params: { projectId: '123' },
    readOnly: false, // Optional: override read-only
    undoable: true, // Optional: enable undo (default: true)
    enabled: true, // Optional: set false until required params exist
})

// The default handle is SYNC-AGNOSTIC: no `isSynced`, so a save settling does
// not re-render it. For save state, use the per-entry sync-status hook (with the
// registry API) or fold `isSynced` into a `selector`. `isLoading` likewise moved
// to the loading-status hook; the data handle keeps `isLoaded` for the common
// "spinner until ready" gate.
```

#### `useCollection(options)`

Subscribe to a collection.

```typescript
const {
    data, // Record<string, T> of documents
    update, // Update one or more documents
    add, // Add a new document (explicit or auto-generated id)
    remove, // Remove a document
    isLoaded, // Active AND past the initial load (isActive && !isLoading)
    isActive, // Whether subscription is active (for lazy collections)
    load, // Activate a lazy subscription
    sync, // Force sync immediately
    error, // Error from listener, if any
    ref, // Firestore CollectionReference
} = useCollection({
    definition: spacesCollection,
    params: { projectId: '123' },
    queryConstraints: [where('floor', '==', 1)],
    undoable: true,
    enabled: true, // Optional: set false until required params exist
})

// queryConstraints are keyed by query identity, not array reference: the
// subscription rebuilds only when the query actually changes (compared via
// Firestore's queryEqual). So a new array that produces the same query —
// e.g. stationIds read from a document Firestate deep-clones on every
// optimistic update — does NOT tear down the listener. You don't need to
// memoize for correctness:
const stations = useCollection({
    definition: weatherStations,
    enabled: stationIds.length > 0,
    queryConstraints: [where(documentId(), 'in', stationIds)],
})

// Update existing documents
update({ space1: { name: 'Updated Name' } })

// Add a new document with an explicit id
add('newSpaceId', { name: 'New Space', area: 500, floor: 1 })

// Or let Firestore generate the id — returned synchronously
const id = add({ name: 'New Space', area: 500, floor: 1 })

// Remove a document
remove('oldSpaceId')
```

#### Selecting a slice (`selector` + `isEqual`)

By default a component re-renders when the data, the load state (`isLoaded`), or
`error` of the subscribed document/collection changes, and the hook returns the
**sync-agnostic default handle** (`data`, `isLoaded`, `error`, the writers, and
`ref` — plus a collection's `isActive`). It deliberately omits `isSynced`, so a
save settling does not re-render it (see [Sync status and loading status](#sync-status-and-loading-status)).
Pass a `selector` to take further control: it receives the resource's _full_
observable state — including `isLoading`/`isSynced` — and returns the slice the
component reacts to, so the component re-renders **only** when that slice changes.

A selected handle exposes exactly your slice as `data`, plus the writer surface
(`update`/`set`/`delete`/`add`/`remove`/`load`/`sync`) and `ref` — the status
flags are **not** on it. You react to precisely what you select; status is not a
freebie, so read it from the state inside the selector when you need it. A
selector changes what you _read_, never what you _write_.

```typescript
// Re-renders only when the title changes — not on any other field, and not on a
// save (isSynced) flip, because the selector never reads it.
const { data: title, update } = useDocument({
    definition: projectDoc,
    params: { projectId },
    selector: (s) => s.data?.title,
})
update({ description: 'edited' }) // still a full-document update

// Need a status flag? Select it — then, and only then, you re-render on it.
const { data } = useDocument({
    definition: projectDoc,
    params: { projectId },
    selector: (s) => ({ title: s.data?.title, saving: !s.isSynced }),
})

// On a collection, sub-select a single document or a derived value.
const { data: space } = useCollection({
    definition: spacesCollection,
    params: { projectId },
    selector: (s) => s.data[spaceId],
})
```

`s.data` is `undefined` while a document is loading (and the collection record is
`{}`), so selectors should handle the empty case.

When writing from a narrowed handle, use `update` — it takes a _partial_ and
merges, so a selected field is just `update({ field: next })`. `set` still
**replaces the entire document**, not the slice: never pass the selected value
to `set` (e.g. `set(title)`) or you will overwrite every other field. Reach for
`set` only when you hold the full document.

By default the slice is compared with a deep value comparison, so a selector
that returns a fresh object/array of the same shape does **not** over-render.
Pass `isEqual` to tune it — `shallow` (exported) is a one-level compare for flat
projections:

```typescript
import { shallow } from '@hvakr/firestate'

const { data: ids } = useCollection({
    definition: spacesCollection,
    params: { projectId },
    selector: (s) => Object.keys(s.data),
    isEqual: shallow,
})
```

Selectors do not need to be memoized; an inline selector is recomputed each
render but only triggers a re-render when its result changes per `isEqual`.

Selectors compose cleanly across components because subscriptions are shared:
every hook reading the same resource (same definition, path, and query) shares
one Firestore listener and one reconciled state, so many components each
selecting a different slice cost a single listener. A write through any handle
is observed by all of them. `readOnly` is a per-handle capability, not part of
that key — a read-only hook shares the same listener and optimistic state as a
writable hook on the same resource, so the common provider/leaf pattern (one
writable owner, many `readOnly: true` read-selectors) sees the writer's
optimistic edits live. Only the read-only handle's own writers are disabled.

#### Sync status and loading status

The default data handle is **sync-agnostic**: it carries `data`/`isLoaded`/
`error` but never `isSynced`. That matters because `isSynced` flips on _every_
autosave settle — so if the data handle carried it, every component that merely
reads a record would re-render an extra time after each save. Most readers only
want the data; the few that render save state (a "Saving…" indicator, a
navigation blocker) opt in explicitly.

For each registry entry, `createFirestate` generates two opt-in status hooks
beside the data hook:

```typescript
const { useSpaces, useSpacesSyncStatus, useSpacesLoadingStatus } =
    createFirestate({ spaces: spacesEntry })

// Only this component re-renders when a save settles — not every data reader.
function SaveIndicator(params) {
    const { isSynced, isSaving } = useSpacesSyncStatus(params)
    return isSaving ? <Spinner /> : <Check />
}

// A spinner that shows load progress WITHOUT re-rendering when data changes.
function SpacesSpinner(params) {
    const { isLoading, isLoaded } = useSpacesLoadingStatus(params)
    return isLoading ? <Spinner /> : null
}
```

Both share the entry's **one** `onSnapshot` listener with the data hook (and any
slice hooks) — sharing is keyed by `(definition, path, query)`, not by which
hook you call — so opting in costs no extra subscription. `useSpacesSyncStatus`
re-renders only when sync state flips; `useSpacesLoadingStatus` re-renders only
on the load transition, never on data. Collection status hooks take the same
`queryConstraints` as the data hook (pass the same query to share the listener).

On a **lazy** collection, a status hook does not call `load()` itself — so as
the _only_ subscriber it stays idle (`{ isSynced: true, isSaving: false }` /
`{ isLoading: false, isLoaded: false }`) and attaches no listener. Pair it with
the data hook, whose `load()` activates the one shared listener the status hook
then rides. Non-lazy collections activate on mount, so this is lazy-only.

`.select` (slice) entries do **not** get their own status hooks — a slice's sync
and loading state is the resource's, read through the base entry's status hooks.

With the lower-level API there are standalone equivalents —
`useDocumentSyncStatus` / `useDocumentLoadingStatus` /
`useCollectionSyncStatus` / `useCollectionLoadingStatus`, each taking
`{ definition, params, enabled }` (collections also `queryConstraints`).

This is the per-resource counterpart to [`useIsSynced()`](#useissynced), which
reports a single provider-wide aggregate across _all_ tracked resources.

#### `useUndoManager()`

Access the undo manager.

```typescript
const {
    canUndo, // Whether undo is available
    canRedo, // Whether redo is available
    undo, // Undo the last action
    redo, // Redo the last undone action
    clear, // Clear undo/redo history
    undoStack, // Array of undo actions
    redoStack, // Array of redo actions
} = useUndoManager()
```

#### `useIsSynced()`

Check if all tracked resources are synced.

```typescript
const isSynced = useIsSynced()
```

#### `useUndoKeyboardShortcuts()`

Add Ctrl/Cmd+Z and Ctrl/Cmd+Y keyboard shortcuts.

```typescript
useUndoKeyboardShortcuts()
```

### Providers

#### `FirestateProvider`

Main provider component.

```tsx
<FirestateProvider
    firestore={db} // Required: Firestore instance
    autosave={1000} // Optional: default debounce (ms)
    minLoadTime={0} // Optional: minimum loading time (ms)
    maxUndoLength={20} // Optional: max undo stack size
    getUndoPath={() => location.pathname} // Optional: stamp router path onto handle-pushed undo actions
    onNavigate={(path) => navigate(path)} // Optional: router navigate for path-aware undo/redo
    onUndo={(action) =>
        analytics.track('undo', { description: action.description })
    }
    onRedo={(action) =>
        analytics.track('redo', { description: action.description })
    }
    onError={(error, context) => {
        // Optional: custom error handler
        console.error(context.path, error)
    }}
>
    {children}
</FirestateProvider>
```

#### `FirestateStoreProvider`

Use with a pre-created store for more control.

```tsx
import { createStore, FirestateStoreProvider } from '@hvakr/firestate'

const store = createStore({ firestore: db })

<FirestateStoreProvider store={store}>
    {children}
</FirestateStoreProvider>
```

## Diff Utilities

Firestate exports a comprehensive set of diff utilities that can be used throughout your application and backend.

### Core Diff Operations

```typescript
import {
    computeDiff,
    applyDiff,
    applyDiffMutable,
    computeUndoDiff,
} from '@hvakr/firestate'

// Compute minimal diff between two objects
const diff = computeDiff(oldState, newState)

// Apply diff (returns new object, original unchanged)
const newState = applyDiff(currentState, diff)

// Apply diff in place (mutates target object) - use for performance-critical paths
applyDiffMutable(targetState, diff)

// Compute the undo diff - what would reverse these changes
const undoDiff = computeUndoDiff(startState, diff)
// Applying undoDiff to the result restores startState
```

### Flattening for Firestore

```typescript
import { flattenDiff, unflattenDiff } from '@hvakr/firestate'

// Flatten nested diff to dot-notation for Firestore's updateDoc
const nested = { building: { floors: 5, height: 100 } }
const flat = flattenDiff(nested)
// { 'building.floors': 5, 'building.height': 100 }

// Unflatten back to nested structure
const restored = unflattenDiff(flat)
// { building: { floors: 5, height: 100 } }
```

### Path-Based Utilities

```typescript
import {
    diffContainsPath,
    extractDiffValue,
    createDiffAtPath,
} from '@hvakr/firestate'

const diff = { building: { floors: 5 }, name: 'Test' }

// Check if a path is affected by a diff
diffContainsPath(diff, 'building.floors') // true
diffContainsPath(diff, 'building.height') // false

// Extract value at a path
extractDiffValue(diff, 'building.floors') // 5

// Create a diff at a specific path
createDiffAtPath('building.config.enabled', true)
// { building: { config: { enabled: true } } }
```

### General Utilities

```typescript
import {
    isDeepEqual,
    deepClone,
    isDiffEmpty,
    mergeDiffs,
} from '@hvakr/firestate'

// Deep equality check (handles Timestamps, arrays, nested objects)
isDeepEqual(obj1, obj2)

// Deep clone (safe for Firestore operations, handles Timestamps)
const clone = deepClone(original)

// Check if a diff has no changes
if (isDiffEmpty(diff)) return

// Merge two diffs (second takes precedence)
const combined = mergeDiffs(diff1, diff2)
```

## Notes

- **`enabled` flag** — pass `enabled: false` to generated hooks or to `useDocument`/`useCollection` when route params or auth-derived ids are not ready yet. Disabled hooks do not resolve paths or attach listeners, which avoids building invalid Firestore paths like `projects//spaces`.
- **Navigation flicker** — changing `params` rebuilds the listener and briefly shows the loading state (`isLoaded: false`). To keep the previous data visible across the transition, wrap your param in `useDeferredValue`.
- **No cross-doc transactions** — writes are atomic per document and per collection (via `writeBatch`), but not across them. For now, use Firestore's `runTransaction` directly via `handle.ref`.
- **Per-client undo** — `useUndoManager` is local; one user's undo doesn't propagate to others.
- **Multi-tab sync** — handled automatically by Firestore's listeners; no extra setup.

## Advanced Usage

### Creating a Store Manually

For advanced use cases, you can create and manage the store yourself:

```typescript
import { createStore, createDocumentSubscription } from '@hvakr/firestate'

const store = createStore({
    firestore: db,
    autosave: 1000,
    maxUndoLength: 50,
    onError: (error, context) => {
        // Send to error tracking service
        if (context.type === 'undo') {
            analytics.track('undo_error', { operation: context.operation })
        }
        Sentry.captureException(error, { extra: context })
    },
    onUndo: (action) =>
        analytics.track('undo', { description: action.description }),
    onRedo: (action) =>
        analytics.track('redo', { description: action.description }),
})

const subscription = createDocumentSubscription({
    store,
    definition: projectDoc,
    docId: '123',
})

subscription.subscribe((state) => {
    console.log('State changed:', state)
})

subscription.load()

// Later: cleanup
subscription.stop()
```

### Custom Undo Manager

Create a standalone undo manager with navigation support:

```typescript
import { createUndoManager } from '@hvakr/firestate'

const undoManager = createUndoManager({
    maxLength: 50,
    onNavigate: (path) => router.push(path),
    onUndo: (action) =>
        analytics.track('undo', { description: action.description }),
    onRedo: (action) =>
        analytics.track('redo', { description: action.description }),
})

undoManager.push({
    undo: () => restoreOldValue(),
    redo: () => applyNewValue(),
    groupId: 'myGroup',
    path: '/projects/123', // Navigate here on undo/redo
    description: 'Update project name',
})

// Subscribe to state changes
const unsubscribe = undoManager.subscribe((state) => {
    console.log('Can undo:', state.canUndo)
    console.log('Can redo:', state.canRedo)
})
```

### Query Constraints

Add Firestore query constraints to collections:

```typescript
import { where, orderBy, limit } from 'firebase/firestore'

const recentSpaces = useCollection({
    definition: spacesCollection,
    params: { projectId: '123' },
    queryConstraints: [
        where('floor', '>=', 1),
        orderBy('createdAt', 'desc'),
        limit(10),
    ],
})
```

### Handling Errors

```typescript
const project = useDocument({
    definition: projectDoc,
    params: { projectId: '123' },
})

// Missing documents are not errors — once loaded, `data` is undefined.
// Render a create/empty state for that case.
if (project.isLoaded && !project.data) {
    return <CreateProject />
}

if (project.error) {
    return <ErrorDisplay error={project.error} />
}
```

### Disabling Autosave

For cases where you want manual control:

```typescript
const projectDoc = defineDocument({
    schema: ProjectSchema,
    collection: 'projects',
    id: (params) => params.id,
    autosave: 0, // Disable autosave
})

// In component
const project = useDocument({ definition: projectDoc, params })

// Changes won't auto-save
project.update({ name: 'New Name' })

// Manually sync when ready
await project.sync()
```

## Testing

Run tests:

```bash
pnpm test
```

Run tests in watch mode:

```bash
pnpm test:watch
```

Run tests with coverage:

```bash
pnpm test:coverage
```

### Mocking in Tests

When testing components that use Firestate, you can mock the hooks:

```typescript
import { vi } from 'vitest'
import * as firestate from '@hvakr/firestate'

vi.mock('@hvakr/firestate', () => ({
    useDocument: vi.fn(() => ({
        data: { id: '123', name: 'Test Project' },
        update: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        isLoaded: true,
        sync: vi.fn(),
        error: undefined,
        ref: {},
    })),
    useUndoManager: vi.fn(() => ({
        canUndo: false,
        canRedo: false,
        undo: vi.fn(),
        redo: vi.fn(),
    })),
}))
```

## Migration from useFirestoreDocument/Collection

If you're currently using custom hooks like `useFirestoreDocument` and `useFirestoreCollection`, here's how to migrate:

### Before (500+ lines of provider code)

```tsx
// ProjectProvider.tsx
export const ProjectProvider = ({ children }) => {
    const undoManager = useUndoManager()

    const project = useFirestoreDocument({
        firestore: db,
        collectionPath: 'projects',
        documentId: projectId,
        autosave: 1000,
        onPushUndoAction: undoManager.push,
    })

    const spaces = useFirestoreCollection({
        firestore: db,
        collectionPath: `projects/${projectId}/spaces`,
        autosave: 1000,
        lazy: true,
        onPushUndoAction: undoManager.push,
    })

    // ... 20 more collections ...

    const allSynced = project.isSynced && spaces.isSynced && /* ... */

    // ... lots of memoization and context setup ...
}
```

### After (declarative and minimal)

```tsx
// schemas.ts
export const projectDoc = defineDocument<Project>({
    collection: 'projects',
    id: (params) => params.projectId,
})

export const spacesCollection = defineCollection<Space>({
    path: (params) => `projects/${params.projectId}/spaces`,
    lazy: true,
})

// Component.tsx
function ProjectEditor({ projectId }) {
    const project = useDocument({
        definition: projectDoc,
        params: { projectId },
    })
    const spaces = useCollection({
        definition: spacesCollection,
        params: { projectId },
    })
    const isSynced = useIsSynced() // Automatic!

    // That's it. Undo/redo is automatic.
}
```

## Design Philosophy

1. **Schema-first**: A Zod schema per document/collection drives both the inferred type and runtime validation on writes
2. **Declarative over imperative**: Define what you want, not how to get it
3. **Batteries included**: Undo/redo, sync tracking, and conflict resolution work out of the box
4. **Escape hatches**: Low-level APIs available when you need them
5. **Framework agnostic core**: The subscription system works without React

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, workflow, and testing
guidelines.

### Development

```bash
# Install dependencies
pnpm install

# Build
pnpm build

# Run tests
pnpm test

# Type check
pnpm typecheck
```

## License

MIT © [HVAKR](https://github.com/hvakr)
