/**
 * Regression tests for `useCollection` subscription identity.
 *
 * Motivating bug (HVAKR full-app flash): an app derived `queryConstraints`
 * from an array living inside a document that Firestate deep-clones on every
 * optimistic update. The array's *contents* never changed, but its reference
 * did — so the memoized constraints array changed reference, `useCollection`
 * tore down the Firestore listener, recreated the subscription with
 * `isLoading: true` / `data: {}`, and the app's loading gate unmounted the
 * whole route.
 *
 * The fix keys the subscription on the *semantic identity* of the query:
 * Firestate builds the query and compares it with Firestore's own
 * `queryEqual`, so a fresh constraints array that produces the same query is
 * ignored, while a genuine query change still rebuilds the listener. No
 * caller-supplied key is required.
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
import { defineCollection } from './schema'
import { createStore, type FirestateStore } from './store'
import type { CollectionHandle, FirestoreObject } from './types'

interface Station extends FirestoreObject {
    name: string
}

const stationsCollection = defineCollection<Station>({
    path: 'weatherStations',
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
    }: {
        queryConstraints: QueryConstraint[]
        enabled?: boolean
    }) => {
        latestHandle = useCollection({
            definition: stationsCollection,
            queryConstraints,
            enabled,
        })
        return null
    }

    const element = (props: {
        queryConstraints: QueryConstraint[]
        enabled?: boolean
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
        expect(latestHandle.isLoading).toBe(false)
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
        // document. This is the regression: with reference keying the listener
        // would tear down here.
        act(() => {
            renderer!.update(
                element({ queryConstraints: constraintsFor([...ids]) })
            )
        })

        // Same query → same subscription: no teardown, no reload, data intact.
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)
        expect(listeners[0]!.unsubscribe).not.toHaveBeenCalled()
        expect(latestHandle.isLoading).toBe(false)
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
        // state reset.
        expect(onSnapshotMock).toHaveBeenCalledTimes(2)
        expect(listeners[0]!.unsubscribe).toHaveBeenCalledTimes(1)
        expect(latestHandle.isLoading).toBe(true)
        expect(latestHandle.data).toEqual({})

        // The new listener queries with the new constraints.
        const queryArg = onSnapshotMock.mock.calls[1]![0]
        const ref = collection(firestore, 'weatherStations')
        expect(
            queryEqual(queryArg, query(ref, ...constraintsFor(newIds)))
        ).toBe(true)
    })

    // Regression: the documented `enabled: ids.length > 0` recipe for gating an
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
        expect(latestHandle.isLoading).toBe(false)
        expect(latestHandle.data.ws1?.name).toBe('Station 1')

        const queryArg = onSnapshotMock.mock.calls[0]![0]
        const ref = collection(firestore, 'weatherStations')
        expect(
            queryEqual(queryArg, query(ref, ...constraintsFor(ids)))
        ).toBe(true)
    })
})
