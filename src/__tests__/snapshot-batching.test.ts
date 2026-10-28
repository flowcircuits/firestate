/**
 * Snapshot batching: a burst of listener snapshots in one task updates state
 * at once but notifies subscribers at most twice (the first snapshot, then one
 * trailing notify on the next task). Without it, each snapshot drove one
 * synchronous React commit, and 50+ of them in a row threw React #185
 * ("Maximum update depth exceeded").
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('firebase/firestore', async () => {
    const actual =
        await vi.importActual<typeof import('firebase/firestore')>(
            'firebase/firestore'
        )
    const { buildFirestoreMock } = await import('./test-harness')
    return buildFirestoreMock(actual as unknown as Record<string, unknown>)
})

import { createHarness, type Harness } from './test-harness'
import { createCollectionSubscription } from '../core/collection'
import { createDocumentSubscription } from '../core/document'
import { defineCollection, defineDocument } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'

interface Space {
    id?: string
    processed?: boolean
}

interface Project {
    revision?: number
}

const spaces = defineCollection<Space>({ path: 'spaces' })
const projectDef = defineDocument<Project>({ collection: 'projects', id: 'p1' })

const nextTask = () => new Promise((resolve) => setTimeout(resolve, 0))

const BURST_SIZE = 100

const spacesProcessedUpTo = (processedCount: number) =>
    Object.fromEntries(
        Array.from({ length: BURST_SIZE }, (_, index) => [
            `space${index}`,
            { processed: index < processedCount },
        ])
    )

describe('snapshot batching', () => {
    let store: FirestateStore
    let h: Harness

    beforeEach(() => {
        vi.clearAllMocks()
        store = createStore({ firestore: {} as never, autosave: 0 })
        h = createHarness()
    })

    const makeColl = async () => {
        const sub = createCollectionSubscription({
            store,
            definition: spaces,
            collectionPath: 'spaces',
        })
        sub.load()
        h.fireCollectionSnapshot(spacesProcessedUpTo(0))
        await nextTask()
        return sub
    }

    const makeDoc = async () => {
        const sub = createDocumentSubscription({
            store,
            definition: projectDef,
            docId: 'p1',
            collectionPath: 'projects',
        })
        sub.load()
        h.fireDocSnapshot({ revision: 0 })
        await nextTask()
        return sub
    }

    describe('collection', () => {
        it('notifies a single snapshot synchronously', async () => {
            const sub = await makeColl()
            const subscriber = vi.fn()
            sub.subscribe(subscriber)

            h.fireCollectionSnapshot(spacesProcessedUpTo(1))

            expect(subscriber).toHaveBeenCalledTimes(1)
            await nextTask()
            expect(subscriber).toHaveBeenCalledTimes(1)
        })

        it('folds a burst of snapshots into one trailing notify', async () => {
            const sub = await makeColl()
            const subscriber = vi.fn()
            sub.subscribe(subscriber)

            for (let count = 1; count <= BURST_SIZE; count++) {
                h.fireCollectionSnapshot(spacesProcessedUpTo(count))
            }

            expect(subscriber).toHaveBeenCalledTimes(1)
            expect(sub.getState().data.space99?.processed).toBe(true)

            await nextTask()
            expect(subscriber).toHaveBeenCalledTimes(2)
            expect(subscriber).toHaveBeenLastCalledWith(sub.getState())
        })

        it('folds a burst delivered through a microtask chain', async () => {
            const sub = await makeColl()
            const subscriber = vi.fn()
            sub.subscribe(subscriber)

            for (let count = 1; count <= BURST_SIZE; count++) {
                await Promise.resolve()
                h.fireCollectionSnapshot(spacesProcessedUpTo(count))
            }
            await nextTask()

            expect(subscriber).toHaveBeenCalledTimes(2)
            expect(sub.getState().data.space99?.processed).toBe(true)
        })

        it('folds a backlog of snapshots queued as separate tasks', async () => {
            const sub = await makeColl()
            const subscriber = vi.fn()
            sub.subscribe(subscriber)

            for (let count = 1; count <= BURST_SIZE; count++) {
                setTimeout(() => {
                    h.fireCollectionSnapshot(spacesProcessedUpTo(count))
                }, 0)
            }
            await nextTask()
            await nextTask()

            expect(subscriber).toHaveBeenCalledTimes(2)
            expect(subscriber).toHaveBeenLastCalledWith(sub.getState())
            expect(sub.getState().data.space99?.processed).toBe(true)
        })

        it('drops the trailing notify after stop()', async () => {
            const sub = await makeColl()
            const subscriber = vi.fn()
            sub.subscribe(subscriber)

            h.fireCollectionSnapshot(spacesProcessedUpTo(1))
            h.fireCollectionSnapshot(spacesProcessedUpTo(2))
            sub.stop()
            await nextTask()

            expect(subscriber).toHaveBeenCalledTimes(1)
        })

        it('keeps local updates synchronous during a burst', async () => {
            const sub = await makeColl()
            const subscriber = vi.fn()
            sub.subscribe(subscriber)

            h.fireCollectionSnapshot(spacesProcessedUpTo(1))
            h.fireCollectionSnapshot(spacesProcessedUpTo(2))
            sub.getHandle().update({ space50: { processed: true } })

            expect(subscriber).toHaveBeenCalledTimes(2)
            expect(subscriber).toHaveBeenLastCalledWith(sub.getState())
            expect(sub.getState().data.space1?.processed).toBe(true)
            expect(sub.getState().data.space50?.processed).toBe(true)

            await nextTask()
            expect(subscriber).toHaveBeenCalledTimes(2)
        })
    })

    describe('document', () => {
        it('folds a burst of snapshots into one trailing notify', async () => {
            const sub = await makeDoc()
            const subscriber = vi.fn()
            sub.subscribe(subscriber)

            for (let revision = 1; revision <= BURST_SIZE; revision++) {
                h.fireDocSnapshot({ revision })
            }

            expect(subscriber).toHaveBeenCalledTimes(1)
            expect(sub.getState().data?.revision).toBe(BURST_SIZE)

            await nextTask()
            expect(subscriber).toHaveBeenCalledTimes(2)
            expect(subscriber).toHaveBeenLastCalledWith(sub.getState())
        })
    })

    describe('across subscriptions', () => {
        const docSnap = (data: object) => ({
            exists: () => true,
            data: () => data,
            metadata: { fromCache: false, hasPendingWrites: false },
        })

        // One snapshot per document subscription commits as often as a burst
        // on one subscription, so the batching window is shared per store.
        it('folds one snapshot each across many document subscriptions', async () => {
            const subs = Array.from({ length: BURST_SIZE }, (_, index) =>
                createDocumentSubscription({
                    store,
                    definition: projectDef,
                    docId: `p${index}`,
                    collectionPath: 'projects',
                })
            )
            subs.forEach((sub) => sub.load())
            const listeners = h.listeners()
            listeners.forEach((l) => l.onNext(docSnap({ revision: 0 })))
            await nextTask()

            const subscribers = subs.map((sub) => {
                const subscriber = vi.fn()
                sub.subscribe(subscriber)
                return subscriber
            })
            const totalCalls = () =>
                subscribers.reduce((n, fn) => n + fn.mock.calls.length, 0)

            for (const listener of listeners) {
                await Promise.resolve()
                listener.onNext(docSnap({ revision: 1 }))
            }

            expect(totalCalls()).toBe(1)
            expect(
                subs.every((sub) => sub.getState().data?.revision === 1)
            ).toBe(true)

            await nextTask()
            subscribers.forEach((subscriber, index) => {
                expect(subscriber).toHaveBeenCalledTimes(1)
                expect(subscriber).toHaveBeenLastCalledWith(
                    subs[index]!.getState()
                )
            })
        })

        // React throws #185 from inside the subscriber callback, so one
        // subscription's throw must not strand the rest of the shared flush.
        it('notifies every subscription when one subscriber throws', async () => {
            const a = await makeDoc()
            const b = createDocumentSubscription({
                store,
                definition: projectDef,
                docId: 'p2',
                collectionPath: 'projects',
            })
            b.load()
            h.fireDocSnapshot({ revision: 0 })
            await nextTask()

            // Open the window with a third subscription so a and b both defer.
            const c = createDocumentSubscription({
                store,
                definition: projectDef,
                docId: 'p3',
                collectionPath: 'projects',
            })
            c.load()
            h.fireDocSnapshot({ revision: 0 })

            const thrown = new Error('subscriber failed')
            a.subscribe(() => {
                throw thrown
            })
            const bSubscriber = vi.fn()
            b.subscribe(bSubscriber)

            h.listeners()[0]!.onNext(docSnap({ revision: 1 }))
            h.listeners()[1]!.onNext(docSnap({ revision: 1 }))

            const uncaught: unknown[] = []
            const onUncaught = (error: unknown) => uncaught.push(error)
            process.on('uncaughtException', onUncaught)
            try {
                await nextTask()
                await nextTask()
            } finally {
                process.off('uncaughtException', onUncaught)
            }

            expect(bSubscriber).toHaveBeenCalledTimes(1)
            expect(bSubscriber).toHaveBeenLastCalledWith(b.getState())
            expect(uncaught).toEqual([thrown])
        })

        it('drops a stopped subscription from the shared trailing notify', async () => {
            const a = await makeDoc()
            const b = createDocumentSubscription({
                store,
                definition: projectDef,
                docId: 'p2',
                collectionPath: 'projects',
            })
            b.load()
            h.fireDocSnapshot({ revision: 0 })
            await nextTask()

            const aSubscriber = vi.fn()
            const bSubscriber = vi.fn()
            a.subscribe(aSubscriber)
            b.subscribe(bSubscriber)

            h.listeners()[0]!.onNext(docSnap({ revision: 1 }))
            h.fireDocSnapshot({ revision: 1 })
            b.stop()
            await nextTask()

            expect(aSubscriber).toHaveBeenCalledTimes(1)
            expect(bSubscriber).not.toHaveBeenCalled()
        })
    })
})
