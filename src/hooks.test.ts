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
 * `queryKey` is the escape hatch: when provided, the subscription is keyed
 * on that string instead of the constraints array reference.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('firebase/firestore', async () => {
    const actual =
        await vi.importActual<typeof import('firebase/firestore')>(
            'firebase/firestore'
        )
    return {
        ...actual,
        collection: vi.fn((_firestore: unknown, path: string) => ({
            __mockColl: path,
        })),
        query: vi.fn((ref: unknown, ...constraints: unknown[]) => ({
            __mockQuery: { ref, constraints },
        })),
        onSnapshot: vi.fn(),
    }
})

import { createElement, type ReactElement } from 'react'
import {
    create,
    act,
    type ReactTestRenderer,
} from 'react-test-renderer'
import * as firestore from 'firebase/firestore'
import { documentId, where, type QueryConstraint } from 'firebase/firestore'
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

    const onSnapshotMock = firestore.onSnapshot as unknown as ReturnType<
        typeof vi.fn
    >

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        store = createStore({ firestore: {} as never })
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
        queryKey,
    }: {
        queryConstraints: QueryConstraint[]
        queryKey?: string
    }) => {
        latestHandle = useCollection({
            definition: stationsCollection,
            queryConstraints,
            queryKey,
        })
        return null
    }

    const element = (props: {
        queryConstraints: QueryConstraint[]
        queryKey?: string
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
    const mountAndLoad = (props: {
        queryConstraints: QueryConstraint[]
        queryKey?: string
    }) => {
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

    it('rebuilds the subscription when queryConstraints changes reference without queryKey (documented footgun)', () => {
        const ids = ['ws1', 'ws2']
        mountAndLoad({ queryConstraints: constraintsFor(ids) })
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)

        // Semantically identical query, new array references — as produced by
        // deriving ids from a deep-cloned parent document.
        act(() => {
            renderer!.update(
                element({ queryConstraints: constraintsFor([...ids]) })
            )
        })

        // Old listener torn down, new one attached, loading state reset.
        expect(onSnapshotMock).toHaveBeenCalledTimes(2)
        expect(listeners[0]!.unsubscribe).toHaveBeenCalledTimes(1)
        expect(latestHandle.isLoading).toBe(true)
        expect(latestHandle.data).toEqual({})
    })

    it('keeps the subscription across constraint reference churn when queryKey is stable', () => {
        const ids = ['ws1', 'ws2']
        const queryKey = ids.join('\n')
        mountAndLoad({ queryConstraints: constraintsFor(ids), queryKey })
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)

        act(() => {
            renderer!.update(
                element({
                    queryConstraints: constraintsFor([...ids]),
                    queryKey: [...ids].join('\n'),
                })
            )
        })

        // Same key → same subscription: no teardown, no reload, data intact.
        expect(onSnapshotMock).toHaveBeenCalledTimes(1)
        expect(listeners[0]!.unsubscribe).not.toHaveBeenCalled()
        expect(latestHandle.isLoading).toBe(false)
        expect(latestHandle.data.ws1?.name).toBe('Station 1')
    })

    it('rebuilds the subscription when queryKey changes', () => {
        const ids = ['ws1', 'ws2']
        mountAndLoad({
            queryConstraints: constraintsFor(ids),
            queryKey: ids.join('\n'),
        })

        const newIds = ['ws1', 'ws3']
        act(() => {
            renderer!.update(
                element({
                    queryConstraints: constraintsFor(newIds),
                    queryKey: newIds.join('\n'),
                })
            )
        })

        expect(onSnapshotMock).toHaveBeenCalledTimes(2)
        expect(listeners[0]!.unsubscribe).toHaveBeenCalledTimes(1)
        expect(latestHandle.isLoading).toBe(true)

        // The new listener queries with the new constraints.
        const queryMock = firestore.query as unknown as ReturnType<typeof vi.fn>
        const lastQueryConstraints =
            queryMock.mock.calls[queryMock.mock.calls.length - 1]!.slice(1)
        expect(lastQueryConstraints).toEqual(constraintsFor(newIds))
    })
})
