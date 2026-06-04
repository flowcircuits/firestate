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
- **Optimistic updates**: Changes reflect immediately, sync in background
- **Conflict resolution**: Automatic rebasing when concurrent changes occur
- **Undo/redo**: Built-in command pattern with action grouping
- **Lazy loading**: Collections can defer subscription until needed
- **Diff-based updates**: Only changed fields are sent to Firestore

## Choosing an API

Firestate exposes two layers. Pick one based on what you're building:

- **`defineFirestate` + `doc` / `col`** (recommended for app code) — declare every Firestore thing in a single registry object; the library generates one typed React hook per entry. Each entry takes a `path` template and a Zod `schema`. In return you get:
  - the data type (`TaskList`) inferred from the schema via `z.infer`
  - the param keys (`{ listId }`) inferred from the path template and enforced at call sites
  - runtime validation on `set` / `add` writes — bad data throws at the call site instead of after a Firestore round trip

  Partial `update(diff)` calls are intentionally NOT validated: diffs commonly include Firestore sentinels like `serverTimestamp()` that a strict schema would reject.

  ```ts
  import { z } from 'zod'
  import { defineFirestate, doc, col } from '@hvakr/firestate'

  const TaskListSchema = z.object({ name: z.string(), createdAt: z.number() })
  const TaskSchema     = z.object({ title: z.string(), completed: z.boolean() })

  export const { useTaskList, useTasks } = defineFirestate({
    taskList: doc({ path: 'taskLists/{listId}',       schema: TaskListSchema }),
    tasks:    col({ path: 'taskLists/{listId}/tasks', schema: TaskSchema }),
  })

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

## Table of Contents

- [Choosing an API](#choosing-an-api)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Examples](#examples)
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
        <FirestateProvider
            firestore={db}
            autosave={1000}
            maxUndoLength={20}
        >
            <YourApp />
        </FirestateProvider>
    )
}
```

### 3. Use in components

```tsx
// ProjectEditor.tsx
import { useDocument, useCollection, useUndoManager } from '@hvakr/firestate'
import { projectDoc, spacesCollection } from './schemas'

function ProjectEditor({ projectId }: { projectId: string }) {
    const params = { projectId }

    // Subscribe to project document
    const project = useDocument({ definition: projectDoc, params })

    // Subscribe to spaces collection (lazy)
    const spaces = useCollection({ definition: spacesCollection, params })

    // Access undo/redo
    const { undo, redo, canUndo, canRedo } = useUndoManager()

    if (project.isLoading) return <Spinner />
    if (!project.data) return <NotFound />

    return (
        <div>
            {/* Undo/Redo buttons */}
            <button onClick={undo} disabled={!canUndo}>Undo</button>
            <button onClick={redo} disabled={!canRedo}>Redo</button>

            {/* Edit project name - changes auto-save */}
            <input
                value={project.data.name}
                onChange={(e) => project.update({ name: e.target.value })}
            />

            {/* Lazy-load spaces */}
            {!spaces.isActive ? (
                <button onClick={spaces.load}>Load Spaces</button>
            ) : spaces.isLoading ? (
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
            {!project.isSynced && <span>Saving...</span>}
        </div>
    )
}
```

## Examples

Check out the [examples](./examples) directory for complete, runnable examples:

- **[React Tasks](./examples/react-tasks)** - A simple task manager demonstrating documents, collections, undo/redo, sync indicators, and real-time updates.

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

To skip undo tracking:

```tsx
project.update({ lastViewed: Date.now() }, { undoable: false })
```

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

Writes are debounced by `autosave` (default 1000 ms). If a component unmounts
while there are unflushed local edits, those edits are dropped silently — the
subscription is gone and the autosave timer is cleared. To handle this:

- **Block navigation** with `useUnsavedChangesBlocker` (shown above) so users
  can't navigate away while writes are pending.
- **Force a flush** by calling `handle.sync()` before triggering the unmount
  (e.g., in a custom save-and-close button).
- **Lower `autosave`** if the debounce window is the source of risk.

There is no automatic flush in the subscription's `stop()` because `stop()`
is synchronous and consumers may unmount during route transitions where
awaiting writes is not feasible.

## API Reference

### Definition Helpers

#### `defineDocument(definition)`

Creates a document definition. Provide the document shape via the `TData`
type parameter, or let it be inferred from a Zod schema.

```typescript
const projectDoc = defineDocument<Project>({
    collection: 'projects',     // Collection path
    id: (params) => params.id,  // Document ID (string or function)
    autosave: 1000,             // Optional: debounce interval (ms)
    minLoadTime: 0,             // Optional: minimum loading time (ms)
    readOnly: false,            // Optional: prevent updates
    retryOnError: false,        // Optional: retry on listener errors
    retryInterval: 5000,        // Optional: retry interval (ms)
    schema: ProjectSchema,      // Optional: Zod schema (validates set/add)
})
```

#### `defineCollection(definition)`

Creates a collection definition.

```typescript
const spacesCollection = defineCollection<Space>({
    path: (params) => `projects/${params.id}/spaces`, // Collection path
    autosave: 1000,                                   // Optional: debounce interval
    minLoadTime: 0,                                   // Optional: minimum loading time
    readOnly: false,                                  // Optional: prevent updates
    lazy: false,                                      // Optional: defer subscription
    queryConstraints: [],                             // Optional: Firestore constraints
    schema: SpaceSchema,                              // Optional: Zod schema (validates add)
})
```

### React Hooks

#### `useDocument(options)`

Subscribe to a document.

```typescript
const {
    data,           // Current document data (T | undefined)
    update,         // Update with partial diff
    set,            // Replace entire document
    delete: del,    // Delete the document
    isLoading,      // Whether initial data is loading
    isSynced,       // Whether all changes are synced
    sync,           // Force sync immediately
    error,          // Error from listener, if any
    ref,            // Firestore DocumentReference
} = useDocument({
    definition: projectDoc,
    params: { projectId: '123' },
    readOnly: false,     // Optional: override read-only
    undoable: true,      // Optional: enable undo (default: true)
})
```

#### `useCollection(options)`

Subscribe to a collection.

```typescript
const {
    data,           // Record<string, T> of documents
    update,         // Update one or more documents
    add,            // Add a new document (explicit or auto-generated id)
    remove,         // Remove a document
    isLoading,      // Whether initial data is loading
    isSynced,       // Whether all changes are synced
    isActive,       // Whether subscription is active
    load,           // Activate a lazy subscription
    sync,           // Force sync immediately
    error,          // Error from listener, if any
    ref,            // Firestore CollectionReference
} = useCollection({
    definition: spacesCollection,
    params: { projectId: '123' },
    queryConstraints: [where('floor', '==', 1)],
    undoable: true,
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

#### `useUndoManager()`

Access the undo manager.

```typescript
const {
    canUndo,        // Whether undo is available
    canRedo,        // Whether redo is available
    undo,           // Undo the last action
    redo,           // Redo the last undone action
    clear,          // Clear undo/redo history
    undoStack,      // Array of undo actions
    redoStack,      // Array of redo actions
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
    firestore={db}              // Required: Firestore instance
    autosave={1000}             // Optional: default debounce (ms)
    minLoadTime={0}             // Optional: minimum loading time (ms)
    maxUndoLength={20}          // Optional: max undo stack size
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
import { diffContainsPath, extractDiffValue, createDiffAtPath } from '@hvakr/firestate'

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
import { isDeepEqual, deepClone, isDiffEmpty, mergeDiffs } from '@hvakr/firestate'

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

- **`enabled` flag** — pass `enabled: false` to `useDocument`/`useCollection` to skip the subscription when params aren't ready (e.g., during a route transition).
- **Navigation flicker** — changing `params` rebuilds the listener and briefly shows `isLoading: true`. To keep the previous data visible across the transition, wrap your param in `useDeferredValue`.
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
        Sentry.captureException(error, { extra: context })
    }
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
})

undoManager.push({
    undo: () => restoreOldValue(),
    redo: () => applyNewValue(),
    groupId: 'myGroup',
    path: '/projects/123',  // Navigate here on undo/redo
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

// Missing documents are not errors — `data` is undefined and `isLoading`
// is false. Render a create/empty state for that case.
if (!project.isLoading && !project.data) {
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
        isLoading: false,
        isSynced: true,
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
    const project = useDocument({ definition: projectDoc, params: { projectId } })
    const spaces = useCollection({ definition: spacesCollection, params: { projectId } })
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
