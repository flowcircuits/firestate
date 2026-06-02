import { StrictMode } from 'react'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
    useCollection,
    useDocument,
    useIsSynced,
    useStore,
    useUndoKeyboardShortcuts,
    useUndoManager,
} from './hooks'
import { FirestateProvider, useUnsavedChangesBlocker } from './provider'
import { defineCollection, defineDocument } from './schema'
import { mockFirestore } from './test-utils/firestore-mock'
import { renderHookWithProvider } from './test-utils/render-helpers'
import { where } from 'firebase/firestore'

vi.mock('firebase/firestore', async () => {
    const m = await import('./test-utils/firestore-mock')
    return m.firestoreMockModule
})

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    // Run any pending timers before clearing so timers that were about to
    // fire don't leak into the next test.
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
})

describe('useStore', () => {
    it('throws when used outside a FirestateProvider', () => {
        // Suppress React's error-boundary console noise for this assertion.
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(() => renderHook(() => useStore())).toThrow(
            /must be used within a FirestateProvider/
        )
        spy.mockRestore()
    })

    it('returns the store when inside a FirestateProvider', () => {
        const { result } = renderHookWithProvider(() => useStore())
        expect(result.current).toBeDefined()
        expect(result.current.undoManager).toBeDefined()
        expect(typeof result.current.subscribeToSyncState).toBe('function')
    })
})

describe('useUndoManager', () => {
    describe('regression: snapshot caching (fix for infinite useSyncExternalStore loop)', () => {
        it('mounts under StrictMode without throwing or warning', () => {
            // The bug: getSnapshot returned a fresh object literal every call,
            // so React's stability check failed and the passive-effect commit
            // re-rendered forever. StrictMode triggers it immediately because
            // of the extra mount/unmount/mount cycle.
            const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

            const { result, unmount } = renderHookWithProvider(() => useUndoManager(), {
                wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
            })

            expect(result.current.canUndo).toBe(false)
            expect(result.current.canRedo).toBe(false)

            // No "getSnapshot should be cached" warning, no "Maximum update
            // depth" error.
            expect(errorSpy).not.toHaveBeenCalled()
            expect(warnSpy).not.toHaveBeenCalled()

            unmount()
            errorSpy.mockRestore()
            warnSpy.mockRestore()
        })

        it('returns the same state identity across consecutive reads (no mutation)', () => {
            const { result, rerender } = renderHookWithProvider(() => useUndoManager())
            const first = result.current
            rerender()
            const second = result.current
            // The returned handle is memoized over (state, undoManager). With
            // no state change between renders, identity should be preserved.
            expect(second).toBe(first)
        })

        it('returns a new state identity after a mutation', () => {
            const { result } = renderHookWithProvider(() => useUndoManager())
            const before = result.current

            act(() => {
                before.push({
                    undo: vi.fn(),
                    redo: vi.fn(),
                })
            })

            const after = result.current
            expect(after).not.toBe(before)
            expect(after.canUndo).toBe(true)
        })
    })

    describe('state transitions', () => {
        it('flips canUndo when an action is pushed, and canRedo when undone', async () => {
            const { result } = renderHookWithProvider(() => useUndoManager())

            expect(result.current.canUndo).toBe(false)
            expect(result.current.canRedo).toBe(false)

            const undoFn = vi.fn()
            const redoFn = vi.fn()

            act(() => {
                result.current.push({ undo: undoFn, redo: redoFn })
            })

            expect(result.current.canUndo).toBe(true)
            expect(result.current.canRedo).toBe(false)
            expect(result.current.undoStack).toHaveLength(1)

            await act(async () => {
                await result.current.undo()
            })

            expect(undoFn).toHaveBeenCalledOnce()
            expect(result.current.canUndo).toBe(false)
            expect(result.current.canRedo).toBe(true)

            await act(async () => {
                await result.current.redo()
            })

            expect(redoFn).toHaveBeenCalledOnce()
            expect(result.current.canUndo).toBe(true)
            expect(result.current.canRedo).toBe(false)
        })

        it('clears both stacks', () => {
            const { result } = renderHookWithProvider(() => useUndoManager())

            act(() => {
                result.current.push({ undo: vi.fn(), redo: vi.fn() })
                result.current.push({ undo: vi.fn(), redo: vi.fn() })
            })

            expect(result.current.canUndo).toBe(true)

            act(() => {
                result.current.clear()
            })

            expect(result.current.canUndo).toBe(false)
            expect(result.current.canRedo).toBe(false)
            expect(result.current.undoStack).toHaveLength(0)
        })
    })

    describe('multiple consumers', () => {
        it('two hooks observing the same store see synchronized state', () => {
            // Both hooks must mount under the SAME provider to share a store.
            // We render two hooks via a single renderHook call that returns
            // both results.
            const { result } = renderHookWithProvider(() => ({
                a: useUndoManager(),
                b: useUndoManager(),
            }))

            expect(result.current.a.canUndo).toBe(false)
            expect(result.current.b.canUndo).toBe(false)

            act(() => {
                result.current.a.push({ undo: vi.fn(), redo: vi.fn() })
            })

            expect(result.current.a.canUndo).toBe(true)
            expect(result.current.b.canUndo).toBe(true)
        })
    })
})

// ---------------------------------------------------------------------------
// useDocument
// ---------------------------------------------------------------------------

interface Project extends Record<string, unknown> {
    name: string
    count: number
}

const projectDoc = defineDocument<Project>({
    collection: 'projects',
    id: (params) => params.projectId!,
    autosave: 100,
})

describe('useDocument', () => {
    it('transitions from loading to loaded with existing data', async () => {
        mockFirestore.seed('projects/p1', { name: 'Alpha', count: 1 })
        const { result } = renderHookWithProvider(() =>
            useDocument({ definition: projectDoc, params: { projectId: 'p1' } })
        )

        // Snapshot is delivered synchronously by the mock, but `isLoading`
        // only flips after the `minLoadTime` setTimeout fires (default 0).
        // The data is already there; the loading flag follows on the next tick.
        expect(result.current.data).toEqual({ name: 'Alpha', count: 1 })
        expect(result.current.isLoading).toBe(true)

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0)
        })

        expect(result.current.isLoading).toBe(false)
        expect(result.current.isSynced).toBe(true)
    })

    it('returns data: undefined when the document does not exist', async () => {
        const { result } = renderHookWithProvider(() =>
            useDocument({ definition: projectDoc, params: { projectId: 'missing' } })
        )

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0)
        })

        expect(result.current.data).toBeUndefined()
        expect(result.current.isLoading).toBe(false)
        expect(result.current.error).toBeUndefined()
    })

    it('mounts under StrictMode without leaking listeners', () => {
        mockFirestore.seed('projects/p1', { name: 'Alpha', count: 1 })
        const { unmount } = renderHookWithProvider(
            () => useDocument({ definition: projectDoc, params: { projectId: 'p1' } }),
            { wrapper: ({ children }) => <StrictMode>{children}</StrictMode> }
        )
        // StrictMode mounts twice; net should be exactly one active listener.
        expect(mockFirestore.listenerCount()).toBe(1)
        unmount()
        expect(mockFirestore.listenerCount()).toBe(0)
    })

    it('returns the disabled handle when enabled: false (no subscription)', () => {
        const { result } = renderHookWithProvider(() =>
            useDocument({
                definition: projectDoc,
                params: { projectId: 'p1' },
                enabled: false,
            })
        )
        expect(result.current.data).toBeUndefined()
        expect(result.current.isLoading).toBe(false)
        expect(result.current.ref).toBeUndefined()
        expect(mockFirestore.listenerCount()).toBe(0)
    })

    it('tears down and re-subscribes when params change', () => {
        mockFirestore.seedMany({
            'projects/p1': { name: 'Alpha', count: 1 },
            'projects/p2': { name: 'Beta', count: 9 },
        })
        const { result, rerender } = renderHookWithProvider(
            ({ id }: { id: string }) =>
                useDocument({ definition: projectDoc, params: { projectId: id } }),
            { initialProps: { id: 'p1' } }
        )
        expect(result.current.data?.name).toBe('Alpha')
        expect(mockFirestore.listenerCount()).toBe(1)

        rerender({ id: 'p2' })
        expect(result.current.data?.name).toBe('Beta')
        // Still one — old subscription stopped, new one attached.
        expect(mockFirestore.listenerCount()).toBe(1)
    })

    it('reflects optimistic updates immediately and flushes via autosave', async () => {
        mockFirestore.seed('projects/p1', { name: 'Alpha', count: 1 })
        const { result } = renderHookWithProvider(() =>
            useDocument({ definition: projectDoc, params: { projectId: 'p1' } })
        )

        act(() => {
            result.current.update({ count: 5 })
        })

        // Optimistic merge is immediate.
        expect(result.current.data?.count).toBe(5)
        expect(result.current.isSynced).toBe(false)
        // Firestore mock not yet written.
        expect(mockFirestore.getDoc('projects/p1')?.count).toBe(1)

        // Autosave is debounced at 100ms (projectDoc.autosave).
        await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
        })

        expect(mockFirestore.getDoc('projects/p1')?.count).toBe(5)
        expect(result.current.isSynced).toBe(true)
    })

    it('set() creates a missing document on autosave', async () => {
        const { result } = renderHookWithProvider(() =>
            useDocument({ definition: projectDoc, params: { projectId: 'newdoc' } })
        )
        expect(result.current.data).toBeUndefined()

        act(() => {
            result.current.set({ name: 'Fresh', count: 0 })
        })

        expect(result.current.data).toEqual({ name: 'Fresh', count: 0 })

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
        })

        expect(mockFirestore.getDoc('projects/newdoc')).toEqual({ name: 'Fresh', count: 0 })
    })

    it('delete() removes the document on autosave', async () => {
        mockFirestore.seed('projects/p1', { name: 'Alpha', count: 1 })
        const { result } = renderHookWithProvider(() =>
            useDocument({ definition: projectDoc, params: { projectId: 'p1' } })
        )

        act(() => {
            result.current.delete()
        })
        expect(result.current.data).toBeUndefined()

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
        })

        expect(mockFirestore.getDoc('projects/p1')).toBeUndefined()
    })

    it('surfaces listener errors', () => {
        mockFirestore.seed('projects/p1', { name: 'Alpha', count: 1 })
        const onError = vi.fn()
        const { result } = renderHookWithProvider(
            () => useDocument({ definition: projectDoc, params: { projectId: 'p1' } }),
            { provider: { onError } }
        )

        act(() => {
            mockFirestore.injectListenerError(
                'projects/p1',
                new Error('permission-denied')
            )
        })

        expect(result.current.error?.message).toBe('permission-denied')
        expect(result.current.isLoading).toBe(false)
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'permission-denied' }),
            expect.objectContaining({ type: 'document', path: 'projects/p1', operation: 'read' })
        )
    })

    it('respects readOnly by dropping mutations', async () => {
        mockFirestore.seed('projects/p1', { name: 'Alpha', count: 1 })
        const { result } = renderHookWithProvider(() =>
            useDocument({
                definition: projectDoc,
                params: { projectId: 'p1' },
                readOnly: true,
            })
        )

        act(() => {
            result.current.update({ count: 99 })
        })

        // Optimistic value didn't change — mutation was dropped.
        expect(result.current.data?.count).toBe(1)
        expect(result.current.isSynced).toBe(true)

        await act(async () => {
            await vi.advanceTimersByTimeAsync(200)
        })
        expect(mockFirestore.getDoc('projects/p1')?.count).toBe(1)
    })
})

// ---------------------------------------------------------------------------
// useCollection
// ---------------------------------------------------------------------------

interface Task extends Record<string, unknown> {
    id: string
    title: string
    priority: 'low' | 'medium' | 'high'
    done: boolean
}

const tasksCollection = defineCollection<Task>({
    path: (params) => `lists/${params.listId}/tasks`,
    autosave: 100,
})

const lazyTasksCollection = defineCollection<Task>({
    path: (params) => `lists/${params.listId}/tasks`,
    lazy: true,
    autosave: 100,
})

describe('useCollection', () => {
    it('loads existing docs on mount (non-lazy)', async () => {
        mockFirestore.seedMany({
            'lists/L1/tasks/t1': { id: 't1', title: 'one', priority: 'low', done: false },
            'lists/L1/tasks/t2': { id: 't2', title: 'two', priority: 'high', done: true },
        })

        const { result } = renderHookWithProvider(() =>
            useCollection({ definition: tasksCollection, params: { listId: 'L1' } })
        )

        await act(async () => {
            await vi.advanceTimersByTimeAsync(0)
        })

        expect(Object.keys(result.current.data)).toHaveLength(2)
        expect(result.current.data['t1']!.title).toBe('one')
        expect(result.current.isLoading).toBe(false)
        expect(result.current.isActive).toBe(true)
    })

    it('lazy collection stays inactive until load() is called', () => {
        mockFirestore.seed('lists/L1/tasks/t1', {
            id: 't1',
            title: 'one',
            priority: 'low',
            done: false,
        })

        const { result } = renderHookWithProvider(() =>
            useCollection({ definition: lazyTasksCollection, params: { listId: 'L1' } })
        )

        expect(result.current.isActive).toBe(false)
        expect(result.current.data).toEqual({})
        expect(mockFirestore.listenerCount()).toBe(0)

        act(() => {
            result.current.load()
        })

        expect(result.current.isActive).toBe(true)
        expect(result.current.data['t1']!.title).toBe('one')
        expect(mockFirestore.listenerCount()).toBe(1)
    })

    it('add(id, data) writes the doc on autosave', async () => {
        // Need at least one seeded doc so the first snapshot arrives; collection
        // mutations bail before the first snapshot. Empty seed still triggers
        // an empty snapshot on subscribe (synchronously), so this works.
        mockFirestore.seedMany({})
        const { result } = renderHookWithProvider(() =>
            useCollection({ definition: tasksCollection, params: { listId: 'L1' } })
        )

        act(() => {
            result.current.add('t-new', {
                id: 't-new',
                title: 'new task',
                priority: 'medium',
                done: false,
            })
        })

        expect(result.current.data['t-new']?.title).toBe('new task')

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
        })

        expect(mockFirestore.getDoc('lists/L1/tasks/t-new')).toMatchObject({
            id: 't-new',
            title: 'new task',
        })
    })

    it('add() auto-id returns the generated id synchronously', () => {
        const { result } = renderHookWithProvider(() =>
            useCollection({ definition: tasksCollection, params: { listId: 'L1' } })
        )

        let returnedId: string | undefined
        act(() => {
            returnedId = result.current.add({
                id: '', // will be overwritten by add()
                title: 'auto',
                priority: 'low',
                done: false,
            })
        })

        expect(returnedId).toBeTruthy()
        expect(result.current.data[returnedId!]).toBeDefined()
    })

    it('remove(id) deletes the doc on autosave', async () => {
        mockFirestore.seed('lists/L1/tasks/t1', {
            id: 't1',
            title: 'one',
            priority: 'low',
            done: false,
        })
        const { result } = renderHookWithProvider(() =>
            useCollection({ definition: tasksCollection, params: { listId: 'L1' } })
        )

        act(() => {
            result.current.remove('t1')
        })

        expect(result.current.data['t1']).toBeUndefined()

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
        })

        expect(mockFirestore.getDoc('lists/L1/tasks/t1')).toBeUndefined()
    })

    it('applies queryConstraints (where ==) at snapshot time', () => {
        mockFirestore.seedMany({
            'lists/L1/tasks/t1': { id: 't1', title: 'one', priority: 'low', done: false },
            'lists/L1/tasks/t2': { id: 't2', title: 'two', priority: 'high', done: false },
            'lists/L1/tasks/t3': { id: 't3', title: 'three', priority: 'high', done: false },
        })
        // Memoized in the hook below — the test wrapper renders only once.
        const constraints = [where('priority', '==', 'high')]

        const { result } = renderHookWithProvider(() =>
            useCollection({
                definition: tasksCollection,
                params: { listId: 'L1' },
                queryConstraints: constraints,
            })
        )

        const keys = Object.keys(result.current.data)
        expect(keys.sort()).toEqual(['t2', 't3'])
    })

    it('cleans up the listener on unmount', () => {
        mockFirestore.seed('lists/L1/tasks/t1', {
            id: 't1',
            title: 'one',
            priority: 'low',
            done: false,
        })
        const { unmount } = renderHookWithProvider(() =>
            useCollection({ definition: tasksCollection, params: { listId: 'L1' } })
        )
        expect(mockFirestore.listenerCount()).toBe(1)
        unmount()
        expect(mockFirestore.listenerCount()).toBe(0)
    })
})

// ---------------------------------------------------------------------------
// useIsSynced & useUnsavedChangesBlocker
// ---------------------------------------------------------------------------

describe('useIsSynced', () => {
    it('returns true with no subscriptions', () => {
        const { result } = renderHookWithProvider(() => useIsSynced())
        expect(result.current).toBe(true)
    })

    it('flips false during a local edit and true after autosave', async () => {
        mockFirestore.seed('projects/p1', { name: 'Alpha', count: 1 })
        const { result } = renderHookWithProvider(() => ({
            doc: useDocument({ definition: projectDoc, params: { projectId: 'p1' } }),
            isSynced: useIsSynced(),
        }))

        expect(result.current.isSynced).toBe(true)

        act(() => {
            result.current.doc.update({ count: 7 })
        })

        expect(result.current.isSynced).toBe(false)

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
        })

        expect(result.current.isSynced).toBe(true)
    })
})

describe('useUnsavedChangesBlocker', () => {
    it('returns the inverse of isSynced', async () => {
        mockFirestore.seed('projects/p1', { name: 'Alpha', count: 1 })
        const { result } = renderHookWithProvider(() => ({
            doc: useDocument({ definition: projectDoc, params: { projectId: 'p1' } }),
            blocked: useUnsavedChangesBlocker(),
        }))

        expect(result.current.blocked).toBe(false)

        act(() => {
            result.current.doc.update({ count: 7 })
        })
        expect(result.current.blocked).toBe(true)

        await act(async () => {
            await vi.advanceTimersByTimeAsync(100)
        })
        expect(result.current.blocked).toBe(false)
    })

    it('returns false when used outside a provider', () => {
        const { result } = renderHook(() => useUnsavedChangesBlocker())
        expect(result.current).toBe(false)
    })
})

// ---------------------------------------------------------------------------
// useUndoKeyboardShortcuts
// ---------------------------------------------------------------------------

describe('useUndoKeyboardShortcuts', () => {
    const originalPlatform = navigator.platform

    afterEach(() => {
        Object.defineProperty(navigator, 'platform', {
            value: originalPlatform,
            configurable: true,
        })
    })

    const setPlatform = (platform: string) => {
        Object.defineProperty(navigator, 'platform', { value: platform, configurable: true })
    }

    it('Cmd+Z on Mac triggers undo', async () => {
        setPlatform('MacIntel')
        const { result } = renderHookWithProvider(() => ({
            undo: useUndoManager(),
            _: useUndoKeyboardShortcuts(),
        }))

        const undoFn = vi.fn()
        act(() => {
            result.current.undo.push({ undo: undoFn, redo: vi.fn() })
        })

        // Dispatch + flush microtasks so the async undo() in the keydown
        // handler resolves and notifies inside the act boundary.
        await act(async () => {
            window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'z', metaKey: true })
            )
            await Promise.resolve()
        })

        expect(undoFn).toHaveBeenCalledOnce()
    })

    it('Ctrl+Y on non-Mac triggers redo', async () => {
        setPlatform('Win32')
        const { result } = renderHookWithProvider(() => ({
            undo: useUndoManager(),
            _: useUndoKeyboardShortcuts(),
        }))

        const undoFn = vi.fn()
        const redoFn = vi.fn()
        act(() => {
            result.current.undo.push({ undo: undoFn, redo: redoFn })
        })
        await act(async () => {
            await result.current.undo.undo()
        })
        expect(undoFn).toHaveBeenCalledOnce()

        await act(async () => {
            window.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'y', ctrlKey: true })
            )
            await Promise.resolve()
        })

        expect(redoFn).toHaveBeenCalledOnce()
    })

    it('removes its listener on unmount', () => {
        setPlatform('MacIntel')
        const { result, unmount } = renderHookWithProvider(() => ({
            undo: useUndoManager(),
            _: useUndoKeyboardShortcuts(),
        }))

        const undoFn = vi.fn()
        act(() => {
            result.current.undo.push({ undo: undoFn, redo: vi.fn() })
        })

        unmount()

        // After unmount, the keyboard listener is gone — pressing Cmd+Z
        // should not invoke undoFn. (We can't read undoFn count after unmount
        // without checking it didn't fire; we dispatch then re-check.)
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true }))
        expect(undoFn).not.toHaveBeenCalled()
    })
})

// ---------------------------------------------------------------------------
// FirestateProvider behavior (the load-bearing memo)
// ---------------------------------------------------------------------------

describe('FirestateProvider', () => {
    // Both tests below use `renderHook` with `initialProps` and rerender with
    // *new* prop values so the provider actually receives a changing onError
    // reference across renders. The earlier versions wrapped the provider in
    // a closure that captured one onError, so rerenders kept the same ref —
    // the protections being tested were never actually exercised.

    // RTL renderHook's wrapper only receives { children }, so we can't thread
    // initialProps through it directly. We stash the current onError in a
    // closure variable that the wrapper reads each render. Reassigning the
    // variable + rerendering gives the FirestateProvider a fresh onError
    // reference per render — exactly the scenario the deps-exclusion was
    // built for.
    it('keeps the same store across re-renders when onError reference changes', () => {
        // Failure mode: if onError leaks into the useMemo deps in provider.tsx,
        // each render with a fresh arrow recreates the store and every active
        // subscription is torn down.
        let currentOnError: (e: Error, c: unknown) => void = () => {}
        const Wrapper = ({ children }: { children: React.ReactNode }) => (
            <FirestateProvider
                firestore={mockFirestore.firestore}
                onError={currentOnError}
            >
                {children}
            </FirestateProvider>
        )

        const { result, rerender } = renderHook(() => useStore(), {
            wrapper: Wrapper,
        })

        const first = result.current
        currentOnError = () => {} // brand-new arrow ref
        rerender()
        currentOnError = () => {}
        rerender()
        currentOnError = () => {}
        rerender()

        expect(result.current).toBe(first)
    })

    it('swaps the active onError handler when the prop changes', () => {
        // Failure mode: if provider.tsx's `useEffect(() => store.setOnError(
        // onError))` is removed, the store keeps invoking the handler it was
        // constructed with even though the consumer passed a new one.
        const first = vi.fn()
        const second = vi.fn()
        const ctx = {
            type: 'document' as const,
            path: 'p/x',
            operation: 'read' as const,
        }

        let currentOnError: typeof first = first
        const Wrapper = ({ children }: { children: React.ReactNode }) => (
            <FirestateProvider
                firestore={mockFirestore.firestore}
                onError={currentOnError}
            >
                {children}
            </FirestateProvider>
        )

        const { result, rerender } = renderHook(() => useStore(), {
            wrapper: Wrapper,
        })

        const store = result.current
        store.reportError(new Error('one'), ctx)
        expect(first).toHaveBeenCalledOnce()
        expect(second).not.toHaveBeenCalled()

        currentOnError = second
        rerender()

        // Same store instance — the setOnError effect must have swapped the
        // active handler in place.
        expect(result.current).toBe(store)
        store.reportError(new Error('two'), ctx)

        expect(first).toHaveBeenCalledOnce() // still 1, NOT 2
        expect(second).toHaveBeenCalledOnce()
    })
})

// ---------------------------------------------------------------------------
// FirestateStoreProvider
// ---------------------------------------------------------------------------

import { createStore } from './store'
import { FirestateStoreProvider } from './provider'

describe('FirestateStoreProvider', () => {
    it('exposes an externally-created store via context', () => {
        const external = createStore({ firestore: mockFirestore.firestore })
        const { result } = renderHook(() => useStore(), {
            wrapper: ({ children }) => (
                <FirestateStoreProvider store={external}>{children}</FirestateStoreProvider>
            ),
        })
        expect(result.current).toBe(external)
    })

    it('does NOT recreate the store across re-renders', () => {
        const external = createStore({ firestore: mockFirestore.firestore })
        const stores: unknown[] = []
        const Reader: React.FC = () => {
            stores.push(useStore())
            return null
        }
        const { rerender } = renderHook(() => null, {
            wrapper: ({ children }) => (
                <FirestateStoreProvider store={external}>
                    <Reader />
                    {children}
                </FirestateStoreProvider>
            ),
        })
        rerender()
        rerender()
        for (const s of stores) expect(s).toBe(external)
    })
})
