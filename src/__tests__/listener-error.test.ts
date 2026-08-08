/**
 * Listener error handling: what a document / collection subscription does when
 * `onSnapshot` delivers an error.
 *
 * Two contracts are pinned here:
 *
 *   - Reported errors carry context. `store.reportError` wraps the raw
 *     FirebaseError in a FirestateError whose message and own fields hold the
 *     resource path, so a consumer that forwards only the error to a tracker
 *     still gets a usable path and a distinct fingerprint per resource.
 *   - permission-denied is terminal. A retry can never clear it, so even with
 *     `retryOnError: true` the subscription reports it, sets `state.error`, and
 *     clears `isLoading` instead of re-attaching the listener forever. A
 *     transient code (e.g. `unavailable`) still retries.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('firebase/firestore', async () => {
    const actual =
        await vi.importActual<typeof import('firebase/firestore')>(
            'firebase/firestore'
        )
    const { buildFirestoreMock } = await import('./test-harness')
    return buildFirestoreMock(actual as unknown as Record<string, unknown>)
})

import { createHarness, firestoreError, type Harness } from './test-harness'
import { createCollectionSubscription } from '../core/collection'
import { createDocumentSubscription } from '../core/document'
import { defineCollection, defineDocument } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'
import { FirestateError } from '../core/errors'
import type { ErrorContext } from '../types'

interface Doc {
    field1?: string
}

interface Item {
    id?: string
    name?: string
}

describe('listener error handling', () => {
    let onError: ReturnType<typeof vi.fn>
    let store: FirestateStore
    let h: Harness

    beforeEach(() => {
        vi.useFakeTimers()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        onError = vi.fn()
        store = createStore({ firestore: {} as never, autosave: 0, onError })
        h = createHarness()
    })

    afterEach(() => {
        vi.clearAllTimers()
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    const lastReported = () => {
        const call = onError.mock.calls.at(-1) as
            | [FirestateError, ErrorContext]
            | undefined
        return call?.[0]
    }

    describe('reported error carries context', () => {
        it('wraps a document listener error with its path', () => {
            const def = defineDocument<Doc>({
                collection: 'projects/p1/tasks',
                id: 't1',
            })
            const sub = createDocumentSubscription({
                store,
                definition: def,
                docId: 't1',
                collectionPath: 'projects/p1/tasks',
            })
            sub.load()

            h.fireListenerError(firestoreError('permission-denied'))

            const reported = lastReported()
            expect(reported).toBeInstanceOf(FirestateError)
            expect(reported?.type).toBe('document')
            expect(reported?.path).toBe('projects/p1/tasks/t1')
            expect(reported?.operation).toBe('read')
            expect(reported?.code).toBe('permission-denied')
            // The path is in the message, so a tracker fingerprints on it.
            expect(reported?.message).toContain('projects/p1/tasks/t1')
            sub.stop()
        })

        it('gives two resources distinct fingerprints', () => {
            const mk = (path: string, id: string) => {
                const sub = createDocumentSubscription({
                    store,
                    definition: defineDocument<Doc>({ collection: path, id }),
                    docId: id,
                    collectionPath: path,
                })
                sub.load()
                return sub
            }

            const a = mk('projects/p1/tasks', 't1')
            h.fireListenerError(firestoreError('permission-denied'))
            const first = lastReported()?.message

            const b = mk('projects/p2/notes', 'n9')
            h.fireListenerError(firestoreError('permission-denied'))
            const second = lastReported()?.message

            expect(first).not.toBe(second)
            a.stop()
            b.stop()
        })
    })

    describe('permission-denied is terminal', () => {
        it('reports and stops loading on a document even with retryOnError', () => {
            const def = defineDocument<Doc>({
                collection: 'docs',
                id: 'd1',
                retryOnError: true,
            })
            const sub = createDocumentSubscription({
                store,
                definition: def,
                docId: 'd1',
                collectionPath: 'docs',
            })
            sub.load()
            expect(sub.getState().isLoading).toBe(true)

            h.fireListenerError(firestoreError('permission-denied'))

            expect(onError).toHaveBeenCalledTimes(1)
            expect(sub.getState().error).toBeInstanceOf(Error)
            expect(sub.getState().isLoading).toBe(false)

            // No retry was scheduled: advancing past the interval attaches no
            // new listener and reports nothing more.
            const before = h.listeners().length
            vi.advanceTimersByTime(10000)
            expect(h.listeners().length).toBe(before)
            expect(onError).toHaveBeenCalledTimes(1)
            sub.stop()
        })

        it('reports and stops loading on a collection even with retryOnError', () => {
            const def = defineCollection<Item>({
                path: 'items',
                retryOnError: true,
            })
            const sub = createCollectionSubscription({
                store,
                definition: def,
                collectionPath: 'items',
            })
            sub.load()
            expect(sub.getState().isLoading).toBe(true)

            h.fireListenerError(firestoreError('permission-denied'))

            expect(onError).toHaveBeenCalledTimes(1)
            expect(lastReported()?.path).toBe('items')
            expect(sub.getState().error).toBeInstanceOf(Error)
            expect(sub.getState().isLoading).toBe(false)

            const before = h.listeners().length
            vi.advanceTimersByTime(10000)
            expect(h.listeners().length).toBe(before)
            sub.stop()
        })
    })

    describe('transient error still retries', () => {
        it('re-attaches the listener and does not report on a document', () => {
            const def = defineDocument<Doc>({
                collection: 'docs',
                id: 'd1',
                retryOnError: true,
                retryInterval: 5000,
            })
            const sub = createDocumentSubscription({
                store,
                definition: def,
                docId: 'd1',
                collectionPath: 'docs',
            })
            sub.load()
            const before = h.listeners().length

            h.fireListenerError(firestoreError('unavailable'))

            // Transient: no report, no terminal state, retry scheduled.
            expect(onError).not.toHaveBeenCalled()
            expect(sub.getState().error).toBeUndefined()
            expect(sub.getState().isLoading).toBe(true)

            vi.advanceTimersByTime(5000)
            // A fresh listener was attached by the retry.
            expect(h.listeners().length).toBe(before + 1)
            sub.stop()
        })
    })
})
