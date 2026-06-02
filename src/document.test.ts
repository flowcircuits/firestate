import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDocumentSubscription } from './document'
import { defineDocument } from './schema'
import { createStore } from './store'
import { mockFirestore } from './test-utils/firestore-mock'

vi.mock('firebase/firestore', async () => {
    const m = await import('./test-utils/firestore-mock')
    return m.firestoreMockModule
})

interface Note extends Record<string, unknown> {
    body: string
}

const noteDoc = defineDocument<Note>({
    collection: 'notes',
    id: 'n1',
})

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
})

describe('createDocumentSubscription', () => {
    describe('handle caching', () => {
        it('getHandle() returns the same identity until notify() is called', () => {
            const store = createStore({
                firestore: mockFirestore.firestore,
                autosave: 1000,
            })
            const sub = createDocumentSubscription({
                store,
                definition: noteDoc,
            })
            sub.load()

            const a = sub.getHandle()
            const b = sub.getHandle()
            expect(b).toBe(a)
        })

        it('getHandle() returns a new identity after a snapshot arrives', () => {
            const store = createStore({
                firestore: mockFirestore.firestore,
                autosave: 1000,
            })
            const sub = createDocumentSubscription({
                store,
                definition: noteDoc,
            })
            sub.load()
            const before = sub.getHandle()

            mockFirestore.setRemote('notes/n1', { body: 'hello' })

            const after = sub.getHandle()
            expect(after).not.toBe(before)
            expect(after.data).toEqual({ body: 'hello' })
        })
    })

    describe('minLoadTime', () => {
        it('keeps isLoading true until the configured time has elapsed', async () => {
            const slowDoc = defineDocument<Note>({
                collection: 'notes',
                id: 'n1',
                minLoadTime: 500,
            })
            mockFirestore.seed('notes/n1', { body: 'fast' })
            const store = createStore({ firestore: mockFirestore.firestore })
            const sub = createDocumentSubscription({ store, definition: slowDoc })
            sub.load()

            // Snapshot arrived synchronously (data is populated) but loading
            // flag stays true until minLoadTime elapses.
            expect(sub.getState().data).toEqual({ body: 'fast' })
            expect(sub.getState().isLoading).toBe(true)

            await vi.advanceTimersByTimeAsync(499)
            expect(sub.getState().isLoading).toBe(true)

            await vi.advanceTimersByTimeAsync(1)
            expect(sub.getState().isLoading).toBe(false)
        })
    })

    describe('retryOnError', () => {
        it('reconnects after retryInterval when retryOnError is true', async () => {
            const retryingDoc = defineDocument<Note>({
                collection: 'notes',
                id: 'n1',
                retryOnError: true,
                retryInterval: 200,
            })
            const store = createStore({ firestore: mockFirestore.firestore })
            const sub = createDocumentSubscription({ store, definition: retryingDoc })
            sub.load()

            expect(mockFirestore.listenerCount()).toBe(1)

            // Inject a listener error.
            mockFirestore.injectListenerError('notes/n1', new Error('transient'))
            // The retry path: handleError schedules a reconnect via setTimeout.
            // The lib calls stop() then load() — listenerCount briefly drops
            // to zero before reconnect.
            await vi.advanceTimersByTimeAsync(200)
            expect(mockFirestore.listenerCount()).toBe(1)

            // After reconnect, a remote write reaches the new listener.
            mockFirestore.setRemote('notes/n1', { body: 'after-retry' })
            expect(sub.getState().data).toEqual({ body: 'after-retry' })
        })

        it('does NOT reconnect on error when retryOnError is false (default)', async () => {
            const onError = vi.fn()
            const store = createStore({
                firestore: mockFirestore.firestore,
                onError,
            })
            const sub = createDocumentSubscription({ store, definition: noteDoc })
            sub.load()

            mockFirestore.injectListenerError('notes/n1', new Error('fatal'))
            await vi.advanceTimersByTimeAsync(1000)

            expect(sub.getState().error?.message).toBe('fatal')
            expect(sub.getState().isLoading).toBe(false)
            expect(onError).toHaveBeenCalledWith(
                expect.objectContaining({ message: 'fatal' }),
                expect.objectContaining({ type: 'document', operation: 'read' })
            )
        })
    })

    describe('stop() lifecycle', () => {
        it('clears autosave, listener, and sync-key on stop', async () => {
            mockFirestore.seed('notes/n1', { body: 'existing' })
            const store = createStore({
                firestore: mockFirestore.firestore,
                autosave: 100,
            })
            const sub = createDocumentSubscription({
                store,
                definition: noteDoc,
            })
            sub.load()
            await vi.advanceTimersByTimeAsync(0)

            // Queue an autosave so we have a pending timer to verify cancellation.
            sub.getHandle().update({ body: 'pending' })
            expect(sub.getState().isSynced).toBe(false)
            expect(store.isSynced).toBe(false)

            sub.stop()

            expect(mockFirestore.listenerCount()).toBe(0)
            // Sync key was unregistered from the store.
            expect(store.isSynced).toBe(true)

            // Advancing past the autosave window should NOT flush a write.
            await vi.advanceTimersByTimeAsync(100)
            expect(mockFirestore.getDoc('notes/n1')).toEqual({ body: 'existing' })
        })
    })

    describe('rebase: local edit during inflight write', () => {
        // Synchronous mock listener delivery is too eager to exercise the
        // rebase branch — the listener fires inside updateDoc, before any
        // follow-up `update()` call has a chance to mutate localState. We
        // defer listener delivery, queue the follow-up edit while sync is
        // resolved but the snapshot is pending, then flush. That's the
        // sequence that drives handleSnapshot down the rebase path.
        it('rebases a local edit issued while a write was in flight', async () => {
            interface NoteWithMeta extends Record<string, unknown> {
                body: string
                note?: string
            }
            const metaDoc = defineDocument<NoteWithMeta>({
                collection: 'notes',
                id: 'n1',
            })

            mockFirestore.seed('notes/n1', { body: 'server', note: 'orig' })
            const store = createStore({
                firestore: mockFirestore.firestore,
                autosave: 1000,
            })
            const sub = createDocumentSubscription({ store, definition: metaDoc })
            sub.load()
            await vi.advanceTimersByTimeAsync(0)

            // First edit: change body. Sync this immediately — it's the
            // "in-flight" write whose snapshot we want to delay.
            sub.getHandle().update({ body: 'local-1' })

            mockFirestore.setDeferListenerFires(true)
            const syncPromise = sub.sync()
            // updateDoc has now mutated mock state.data to {body:'local-1',
            // note:'orig'}, and queued the listener fire instead of running it.

            // Second edit: change a DIFFERENT field. With sync delivery this
            // edit would be applied AFTER the snapshot cleared localState; now
            // it lands while inflightLocalState is still {body:'local-1',
            // note:'orig'} and the snapshot hasn't arrived.
            sub.getHandle().update({ note: 'rebased' })

            await syncPromise

            // Inflight: {body:'local-1', note:'orig'}. Current local:
            // {body:'local-1', note:'rebased'}. Snapshot data (about to be
            // delivered): {body:'local-1', note:'orig'}. The rebase branch
            // should compute the diff (note: 'orig' → 'rebased') and apply
            // it on top of the new sync state.
            mockFirestore.flushListeners()
            mockFirestore.setDeferListenerFires(false)

            // syncState now reflects 'local-1'/'orig' (the write). localState
            // must be the rebased {body:'local-1', note:'rebased'} — proving
            // the rebase branch ran. If it had taken the `else { localState =
            // undefined }` path instead, mergedData would equal syncState
            // ({note:'orig'}) and the assertion below would fail.
            expect(sub.getState().data).toEqual({
                body: 'local-1',
                note: 'rebased',
            })
            expect(sub.getState().isSynced).toBe(false)
        })
    })
})
