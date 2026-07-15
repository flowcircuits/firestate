/**
 * `useCollection` subscription identity.
 *
 * Contract: the subscription is keyed on the *semantic identity* of the query,
 * not on the reference of the `queryConstraints` array. Firestate builds the
 * query and compares it with Firestore's own `queryEqual`, so a fresh
 * constraints array that produces the same query keeps the existing listener,
 * while a genuine query change rebuilds it. Callers therefore need not memoize
 * `queryConstraints` — and a parent document that Firestate deep-clones on
 * every optimistic update (changing the array reference but not its contents)
 * does not tear down the listener, recreate the subscription with
 * `isLoading: true` / `data: {}`, and trip a route-level loading gate.
 *
 * Unlike the rest of the suite, these tests use a real Firestore instance and
 * real `query`/`queryEqual`/`where` — only `onSnapshot` (the network edge) is
 * mocked. queryEqual operates on real Query objects, so mocking the query
 * builders (as other tests do) would defeat the very thing under test.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('firebase/firestore', async () => {
    const actual =
        await vi.importActual<typeof import('firebase/firestore')>(
            'firebase/firestore'
        )
    return {
        ...actual,
        onSnapshot: vi.fn(),
    }
})

import { createElement, type ReactElement } from 'react'
import { create, act, type ReactTestRenderer } from 'react-test-renderer'
import { initializeApp, type FirebaseApp } from 'firebase/app'
import {
    getFirestore,
    onSnapshot,
    documentId,
    query,
    where,
    queryEqual,
    collection,
    type Firestore,
    type QueryConstraint,
} from 'firebase/firestore'
import { useCollection, FirestateContext } from './hooks'
import { defineCollection } from '../registry/schema'
import { createFirestate, col } from '../registry/firestate'
import { z } from 'zod'
import { createStore, type FirestateStore } from '../core/store'
import type { CollectionHandle, FirestoreObject, LoadingStatus } from '../types'

interface Station extends FirestoreObject {
    name: string
}

const stationsCollection = defineCollection<Station>({
    path: 'weatherStations',
})

const lazyStationsCollection = defineCollection<Station>({
    path: 'weatherStations',
    lazy: true,
})

// A real (offline) Firestore — building queries and refs is purely
// client-side; onSnapshot is mocked so nothing hits the network.
let app: FirebaseApp
let firestore: Firestore
try {
    app = initializeApp({ projectId: 'firestate-test' }, 'firestate-test')
} catch {
    // Already initialized by a previous run in the same worker.
    app = initializeApp({ projectId: 'firestate-test' }, 'firestate-test-2')
}
firestore = getFirestore(app)

type MockSnapshot = {
    docs: Array<{ id: string; data: () => Record<string, unknown> }>
}

describe('useCollection queryConstraints identity', () => {
    let store: FirestateStore
    let renderer: ReactTestRenderer | undefined
    // One entry per Firestore listener that was attached.
    let listeners: Array<{
        deliver: (snapshot: MockSnapshot) => void
        unsubscribe: ReturnType<typeof vi.fn>
    }>
    let latestHandle: CollectionHandle<Station>

    const onSnapshotMock = onSnapshot as unknown as ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        store = createStore({ firestore })
        listeners = []
        onSnapshotMock.mockImplementation(
            (_query: unknown, onNext: (snapshot: MockSnapshot) => void) => {
                const unsubscribe = vi.fn()
                listeners.push({ deliver: onNext, unsubscribe })
                return unsubscribe
            }
        )
    })

    afterEach(() => {
        act(() => {
            renderer?.unmount()
        })
        renderer = undefined
        vi.useRealTimers()
    })

    const Probe = ({
        queryConstraints,
        enabled,
        definition = stationsCollection,
    }: {
        queryConstraints: QueryConstraint[]
        enabled?: boolean
        definition?: typeof stationsCollection
    }) => {
        latestHandle = useCollection({
            definition,
            queryConstraints,
            enabled,
        })
        return null
    }

    const element = (props: {
        queryConstraints: QueryConstraint[]
        enabled?: boolean
        definition?: typeof stationsCollection
    }): ReactElement =>
        createElement(
            FirestateContext.Provider,
            { value: store },
            createElement(Probe, props)
        )

    const constraintsFor = (ids: string[]): QueryConstraint[] => [
        where(documentId(), 'in', ids),
    ]

    const snapshot: MockSnapshot = {
        docs: [{ id: 'ws1', data: () => ({ name: 'Station 1' }) }],
    }

    /** Mount, deliver the first snapshot, and settle minLoadTime. */
    const mountAndLoad = (props: { queryConstraints: QueryConstraint[] }) => {
        act(() => {
            renderer = create(element(props))
        })
        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
        })
        expect(latestHandle.isLoaded).toBe(true)
        expect(latestHandle.data.ws1?.name).toBe('Station 1')
    }

    it('sanity: queryEqual treats fresh arrays with equal ids as the same query', () => {
        const ref = collection(firestore, 'weatherStations')
        const a = query(ref, where(documentId(), 'in', ['ws1', 'ws2']))
        const b = query(ref, where(documentId(), 'in', ['ws1', 'ws2']))
        const c = query(ref, where(documentId(), 'in', ['ws1', 'ws3']))
        expect(queryEqual(a, b)).toBe(true)
        expect(queryEqual(a, c)).toBe(false)
    })

    it('keeps the subscription across constraint reference churn (semantically equal, no key needed)', () => {
        const ids = ['ws1', 'ws2']
        mountAndLoad({ queryConstraints: constraintsFor(ids) })
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)

        // Semantically identical query, brand-new array + constraint
        // references — as produced by deriving ids from a deep-cloned parent
        // document. A reference-keyed implementation would tear down the
        // listener here; semantic-identity keying must keep it.
        act(() => {
            renderer!.update(
                element({ queryConstraints: constraintsFor([...ids]) })
            )
        })

        // Same query → same subscription: no teardown, no reload, data intact.
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)
        expect(listeners[0]!.unsubscribe).not.toHaveBeenCalled()
        expect(latestHandle.isLoaded).toBe(true)
        expect(latestHandle.data.ws1?.name).toBe('Station 1')
    })

    it('rebuilds the subscription when the query actually changes', () => {
        const ids = ['ws1', 'ws2']
        mountAndLoad({ queryConstraints: constraintsFor(ids) })
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)

        const newIds = ['ws1', 'ws3']
        act(() => {
            renderer!.update(
                element({ queryConstraints: constraintsFor(newIds) })
            )
        })

        // Different query → old listener torn down, new one attached, loading
        // state reset (isLoaded back to false until the new snapshot arrives).
        expect(onSnapshotMock).toHaveBeenCalledTimes(2)
        expect(listeners[0]!.unsubscribe).toHaveBeenCalledTimes(1)
        expect(latestHandle.isLoaded).toBe(false)
        expect(latestHandle.data).toEqual({})

        // The new listener queries with the new constraints.
        const queryArg = onSnapshotMock.mock.calls[1]![0]
        const ref = collection(firestore, 'weatherStations')
        expect(
            queryEqual(queryArg, query(ref, ...constraintsFor(newIds)))
        ).toBe(true)
    })

    // Contract: the documented `enabled: ids.length > 0` recipe for gating an
    // `in` query. While disabled the constraints array holds an empty-array
    // `in` filter — a query Firestore refuses to build. The hook must not
    // compare against those constraints captured while disabled when it later
    // enables, or it throws "A non-empty array is required for 'in' filters"
    // during render.
    it('enables an in-query gated with enabled:false on empty ids without throwing', () => {
        // Disabled first render: empty `in` filter, no subscription built.
        act(() => {
            renderer = create(
                element({
                    queryConstraints: constraintsFor([]),
                    enabled: false,
                })
            )
        })
        expect(latestHandle.isActive).toBe(false)
        expect(onSnapshotMock).not.toHaveBeenCalled()

        // IDs arrive: enable with a valid, non-empty `in` filter. This render
        // is where the stale empty-array constraints would be built for the
        // identity compare and throw.
        const ids = ['ws1', 'ws2']
        act(() => {
            renderer!.update(
                element({ queryConstraints: constraintsFor(ids), enabled: true })
            )
        })
        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
        })

        expect(onSnapshotMock).toHaveBeenCalledTimes(1)
        expect(latestHandle.isLoaded).toBe(true)
        expect(latestHandle.data.ws1?.name).toBe('Station 1')

        const queryArg = onSnapshotMock.mock.calls[0]![0]
        const ref = collection(firestore, 'weatherStations')
        expect(
            queryEqual(queryArg, query(ref, ...constraintsFor(ids)))
        ).toBe(true)
    })

    // Contract: a lazy collection becomes "active" (enabled + resolved path)
    // as soon as it mounts, before load() attaches any listener. If the first
    // render carries a gated empty-array `in` filter and real IDs arrive on a
    // later render — still before load() — the identity compare would build the
    // stale empty-array query and throw "A non-empty array is required for 'in'
    // filters" during render. No listener exists pre-load, so there is nothing
    // to preserve and the compare must not throw.
    it('does not throw when lazy constraints go from empty to valid before load()', () => {
        // First render: lazy + enabled with an empty `in` filter. Lazy means no
        // listener is attached yet (load() not called).
        act(() => {
            renderer = create(
                element({
                    definition: lazyStationsCollection,
                    queryConstraints: constraintsFor([]),
                    enabled: true,
                })
            )
        })
        expect(latestHandle.isActive).toBe(false)
        expect(onSnapshotMock).not.toHaveBeenCalled()

        // IDs arrive before load(). This render is where the stale empty-array
        // constraints would be built for the identity compare and throw.
        const ids = ['ws1', 'ws2']
        act(() => {
            renderer!.update(
                element({
                    definition: lazyStationsCollection,
                    queryConstraints: constraintsFor(ids),
                    enabled: true,
                })
            )
        })

        // Still no listener — lazy defers until load() is called explicitly.
        expect(onSnapshotMock).not.toHaveBeenCalled()

        // load() now attaches a listener with the valid, non-empty constraints.
        act(() => {
            latestHandle.load()
        })
        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
        })

        expect(onSnapshotMock).toHaveBeenCalledTimes(1)
        expect(latestHandle.isLoaded).toBe(true)
        expect(latestHandle.data.ws1?.name).toBe('Station 1')

        const queryArg = onSnapshotMock.mock.calls[0]![0]
        const ref = collection(firestore, 'weatherStations')
        expect(
            queryEqual(queryArg, query(ref, ...constraintsFor(ids)))
        ).toBe(true)
    })
})

/**
 * Shared, ref-counted collection subscriptions keyed by (path, query).
 *
 * Contract: hooks whose queries are `queryEqual` share ONE listener and ONE
 * state, even with fresh constraint arrays; a write through one handle is
 * instantly visible to the others; the listener is ref-counted (attaches once,
 * tears down only when the last subscriber unmounts) and lazy `load()` from any
 * handle activates the one shared listener. Collection identity is *semantic
 * query* identity, so these tests use real `query`/`queryEqual` (only
 * `onSnapshot` is mocked).
 */
describe('shared collection subscriptions', () => {
    let store: FirestateStore
    const renderers: ReactTestRenderer[] = []
    let listeners: Array<{
        deliver: (snapshot: MockSnapshot) => void
        unsubscribe: ReturnType<typeof vi.fn>
    }>
    let handles: Record<string, CollectionHandle<Station>>

    const onSnapshotMock = onSnapshot as unknown as ReturnType<typeof vi.fn>

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        store = createStore({ firestore, autosave: 0 })
        listeners = []
        handles = {}
        onSnapshotMock.mockImplementation(
            (_query: unknown, onNext: (snapshot: MockSnapshot) => void) => {
                const unsubscribe = vi.fn()
                listeners.push({ deliver: onNext, unsubscribe })
                return unsubscribe
            }
        )
    })

    afterEach(() => {
        act(() => {
            renderers.splice(0).forEach((r) => r.unmount())
        })
        vi.useRealTimers()
    })

    const Probe = ({
        tag,
        queryConstraints,
        definition = stationsCollection,
        readOnly,
        undoable,
    }: {
        tag: string
        queryConstraints?: QueryConstraint[]
        definition?: typeof stationsCollection
        readOnly?: boolean
        undoable?: boolean
    }) => {
        handles[tag] = useCollection({
            definition,
            queryConstraints,
            readOnly,
            undoable,
        })
        return null
    }

    const mountProbe = (props: Parameters<typeof Probe>[0]): ReactTestRenderer => {
        let renderer!: ReactTestRenderer
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe, props)
                )
            )
        })
        renderers.push(renderer)
        return renderer
    }

    const constraintsFor = (ids: string[]): QueryConstraint[] => [
        where(documentId(), 'in', ids),
    ]

    const snapshot: MockSnapshot = {
        docs: [{ id: 'ws1', data: () => ({ name: 'Station 1' }) }],
    }

    it('shares one listener across semantically-equal queries (fresh arrays)', () => {
        const ids = ['ws1', 'ws2']
        // Two hooks, two brand-new constraint arrays that build the same query.
        mountProbe({ tag: 'a', queryConstraints: constraintsFor(ids) })
        mountProbe({ tag: 'b', queryConstraints: constraintsFor([...ids]) })

        // One listener for both — keyed on query identity, not array reference.
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)
        expect(listeners).toHaveLength(1)

        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
        })

        // The single snapshot reached both hooks.
        expect(handles.a!.data.ws1?.name).toBe('Station 1')
        expect(handles.b!.data.ws1?.name).toBe('Station 1')
    })

    it('keeps genuinely different queries on independent listeners', () => {
        mountProbe({ tag: 'a', queryConstraints: constraintsFor(['ws1']) })
        mountProbe({ tag: 'b', queryConstraints: constraintsFor(['ws2']) })

        expect(onSnapshotMock).toHaveBeenCalledTimes(2)
    })

    it('makes a write through one handle visible to the other', () => {
        const ids = ['ws1', 'ws2']
        mountProbe({ tag: 'a', queryConstraints: constraintsFor(ids) })
        mountProbe({ tag: 'b', queryConstraints: constraintsFor([...ids]) })
        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
        })

        act(() => {
            handles.a!.add('ws9', { name: 'Added' } as Omit<Station, 'id'>)
        })

        // Optimistic add is shared state — the other handle sees it at once,
        // and the one shared subscription reports unsynced (sync state is read
        // off the store / sync-status hook, not the default handle).
        expect(handles.b!.data.ws9?.name).toBe('Added')
        expect(store.isSynced).toBe(false)
    })

    it('does not record undo actions by default', () => {
        mountProbe({ tag: 'a' })
        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
            handles.a!.add('ws9', { name: 'Added' } as Omit<Station, 'id'>)
        })

        expect(store.undoManager.canUndo).toBe(false)
    })

    it('records undo actions when the resource opts in', () => {
        mountProbe({ tag: 'a', undoable: true })
        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
            handles.a!.add('ws9', { name: 'Added' } as Omit<Station, 'id'>)
        })

        expect(store.undoManager.canUndo).toBe(true)
    })

    it('shares one listener and state across a writable and a read-only hook', () => {
        // readOnly is a per-handle capability, not part of the share key: a
        // writable hook and a read-only hook on the same query resolve ONE
        // listener and ONE optimistic state.
        mountProbe({ tag: 'writer' })
        mountProbe({ tag: 'reader', readOnly: true })

        // readOnly is not in the key → one listener for both.
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)
        expect(listeners).toHaveLength(1)

        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
        })

        // A write through the writable handle is visible to the read-only
        // reader (shared optimistic state).
        act(() => {
            handles.writer!.add('ws9', { name: 'Added' } as Omit<Station, 'id'>)
        })
        expect(handles.reader!.data.ws9?.name).toBe('Added')
        expect(store.isSynced).toBe(false)

        // The read-only handle's writers are no-ops: it cannot mutate the
        // shared state.
        act(() => {
            handles.reader!.add('ws10', {
                name: 'Nope',
            } as Omit<Station, 'id'>)
            handles.reader!.remove('ws1')
            handles.reader!.update({ ws1: { name: 'Renamed' } } as never)
        })
        expect(handles.writer!.data.ws10).toBeUndefined()
        expect(handles.writer!.data.ws1?.name).toBe('Station 1')
    })

    it('ref-counts the listener: torn down only when the last hook unmounts', () => {
        const ids = ['ws1', 'ws2']
        const r1 = mountProbe({ tag: 'a', queryConstraints: constraintsFor(ids) })
        const r2 = mountProbe({ tag: 'b', queryConstraints: constraintsFor([...ids]) })
        expect(listeners).toHaveLength(1)
        const { unsubscribe } = listeners[0]!

        act(() => r1.unmount())
        expect(unsubscribe).not.toHaveBeenCalled()

        act(() => r2.unmount())
        expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    it('lazily activates one shared listener via load() from any handle', () => {
        // Two lazy hooks: no listener until someone calls load().
        mountProbe({ tag: 'a', definition: lazyStationsCollection })
        mountProbe({ tag: 'b', definition: lazyStationsCollection })
        expect(onSnapshotMock).not.toHaveBeenCalled()
        expect(handles.a!.isActive).toBe(false)
        expect(handles.b!.isActive).toBe(false)

        // load() through one handle activates the single shared listener; the
        // other handle observes the activation too.
        act(() => {
            handles.a!.load()
            vi.runAllTimers()
        })
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)
        expect(handles.a!.isActive).toBe(true)
        expect(handles.b!.isActive).toBe(true)

        act(() => {
            listeners[0]!.deliver(snapshot)
            vi.runAllTimers()
        })
        expect(handles.a!.data.ws1?.name).toBe('Station 1')
        expect(handles.b!.data.ws1?.name).toBe('Station 1')
    })
})

describe('createFirestate .select shares one collection listener (real queries)', () => {
    let store: FirestateStore
    let renderer: ReactTestRenderer | undefined
    let listeners: Array<{ unsubscribe: ReturnType<typeof vi.fn> }>
    const onSnapshotMock = onSnapshot as unknown as ReturnType<typeof vi.fn>

    const ThingSchema = z.object({ title: z.string() })
    // Base + two slices off the SAME base entry, all on one collection path.
    const things = col({ path: 'things', schema: ThingSchema })
    const lazyThings = col({ path: 'lazyThings', schema: ThingSchema, lazy: true })
    const api = createFirestate({
        things,
        thingById: things.select((s, p: { id: string }) => s.data[p.id]),
        thingIds: things.select((s) => Object.keys(s.data)),
        lazyThings,
    })

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        store = createStore({ firestore })
        listeners = []
        onSnapshotMock.mockImplementation(() => {
            const unsubscribe = vi.fn()
            listeners.push({ unsubscribe })
            return unsubscribe
        })
    })

    afterEach(() => {
        act(() => {
            renderer?.unmount()
        })
        renderer = undefined
        vi.useRealTimers()
    })

    it('attaches ONE listener for a base hook and its slice siblings on one collection', () => {
        // Unlike the mocked-query suites, this uses real query/queryEqual: the
        // base hook and both slice-hooks (same definition, same no-constraint
        // query) resolve ONE shared entry → one onSnapshot. Pre-fix, each
        // generated hook built its own definition object and forked one listener
        // apiece — three for this one collection.
        const Probe = (): null => {
            api.useThings()
            api.useThingById({ id: 'a' })
            api.useThingIds()
            return null
        }
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe)
                )
            )
        })

        expect(listeners.length).toBe(1)
    })

    it('a generated collection sync-status hook shares the base listener', () => {
        // The collection counterpart of the sharing guarantee, with real
        // query/queryEqual: useThingsSyncStatus resolves the SAME (path, query)
        // entry as useThings — readOnly and the baked sync selector are not part
        // of the share key — so opting into sync state adds no second listener.
        const Probe = (): null => {
            api.useThings()
            api.useThingsSyncStatus()
            return null
        }
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe)
                )
            )
        })

        expect(listeners.length).toBe(1)
    })

    it('a generated lazy collection loading-status hook rides the data hook load()', () => {
        // The flip side of the lazy caveat (asserted idle-only in
        // status-hooks.test.ts): a status hook never calls load() itself, but
        // when a co-mounted data hook does, both resolve the SAME (path, query)
        // entry — readOnly and the baked selector aren't part of the key — so the
        // status hook rides that one listener instead of staying stuck at idle.
        let data: CollectionHandle<{ title: string }> | undefined
        let loading: LoadingStatus | undefined
        const Probe = (): null => {
            data = api.useLazyThings()
            loading = api.useLazyThingsLoadingStatus()
            return null
        }
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe)
                )
            )
        })

        // Lazy: nothing attaches until load() runs, and the status hook won't.
        expect(listeners.length).toBe(0)
        expect(loading).toEqual({ isLoading: false, isLoaded: false })

        // load() through the data handle activates the ONE shared listener; the
        // status hook rides it (no second listener) and observes the load.
        act(() => {
            data!.load()
            vi.runAllTimers()
        })
        expect(listeners.length).toBe(1)
        expect(loading).toEqual({ isLoading: true, isLoaded: false })
    })
})
