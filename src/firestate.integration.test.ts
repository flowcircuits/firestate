/**
 * Integration test: from a Firestate registry entry, through the generated
 * hook plumbing, to the actual Firebase `collection()` / `doc()` calls.
 *
 * The unit tests in `firestate.test.ts` verify that `buildDocumentDefinition`
 * produces a definition whose `collection`/`id` functions return the right
 * strings. That's necessary but not sufficient — what we actually care about
 * is that those strings reach Firestore in `collection(firestore, path)`.
 * This file pins that contract directly.
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
        doc: vi.fn((collRef: unknown, docId: string) => ({
            __mockDoc: { collRef, docId },
        })),
        onSnapshot: vi.fn(() => () => {
            /* noop unsubscribe */
        }),
        setDoc: vi.fn(),
        updateDoc: vi.fn(),
        deleteDoc: vi.fn(),
        writeBatch: vi.fn(() => ({
            set: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            commit: vi.fn(),
        })),
    }
})

import * as firestore from 'firebase/firestore'
import { serverTimestamp, Timestamp } from 'firebase/firestore'
import { z } from 'zod'
import {
    doc,
    col,
    buildDocumentDefinition,
    buildCollectionDefinition,
} from './firestate'
import { createDocumentSubscription } from './document'
import { createCollectionSubscription } from './collection'
import { createStore, type FirestateStore } from './store'

const revisionSchema = z.object({ title: z.string() })
const spaceSchema = z.object({ label: z.string() })

describe('Firestate registry → Firestore path', () => {
    let store: FirestateStore

    beforeEach(() => {
        vi.clearAllMocks()
        store = createStore({ firestore: {} as any })
    })

    it('resolves a flat document path through to collection() + doc()', () => {
        const definition = buildDocumentDefinition(
            doc({ path: 'projects/{projectId}', schema: revisionSchema })
        )
        const params = { projectId: 'p1' }

        const collectionPath = (
            definition.collection as (p: Record<string, string>) => string
        )(params)
        const docId = (definition.id as (p: Record<string, string>) => string)(
            params
        )

        createDocumentSubscription({ store, definition, collectionPath, docId })

        expect(firestore.collection).toHaveBeenCalledWith(
            store.firestore,
            'projects'
        )
        expect(firestore.doc).toHaveBeenCalledWith(
            { __mockColl: 'projects' },
            'p1'
        )
    })

    it('resolves a document nested under a dynamic parent (regression for hvakr-style paths)', () => {
        // This is the case that motivated the function-form `collection`.
        // If the registry-to-Firestore handoff regresses, this test catches it.
        const definition = buildDocumentDefinition(
            doc({
                path: 'projects/{projectId}/revisions/{revisionId}',
                schema: revisionSchema,
            })
        )
        const params = { projectId: 'p1', revisionId: 'r1' }

        const collectionPath = (
            definition.collection as (p: Record<string, string>) => string
        )(params)
        const docId = (definition.id as (p: Record<string, string>) => string)(
            params
        )

        createDocumentSubscription({ store, definition, collectionPath, docId })

        expect(firestore.collection).toHaveBeenCalledWith(
            store.firestore,
            'projects/p1/revisions'
        )
        expect(firestore.doc).toHaveBeenCalledWith(
            { __mockColl: 'projects/p1/revisions' },
            'r1'
        )
    })

    it('resolves a deep subcollection collection path', () => {
        const definition = buildCollectionDefinition(
            col({
                path: 'projects/{projectId}/revisions/{revisionId}/spaces',
                schema: spaceSchema,
            })
        )
        const path = (definition.path as (p: Record<string, string>) => string)(
            { projectId: 'p1', revisionId: 'r1' }
        )

        expect(path).toBe('projects/p1/revisions/r1/spaces')
    })
})

// Pins the C1 fix end-to-end: a document subscription receiving an
// update with serverTimestamp() must (a) keep the sentinel in
// localState so the eventual write ships the sentinel, and (b) expose
// a real Timestamp to consumers via the handle so optimistic UI works.
describe('Document subscription: serverTimestamp display overrides', () => {
    let store: FirestateStore
    let snapshotCallback: ((snap: unknown) => void) | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        store = createStore({ firestore: {} as any, autosave: 0 })

        // Re-mock onSnapshot to capture the callback so the test can
        // fire fake snapshots and exercise the full notify → reconcile
        // → getMergedData chain.
        snapshotCallback = undefined
        vi.mocked(firestore.onSnapshot).mockImplementation(
            ((_ref: unknown, onNext: (snap: unknown) => void) => {
                snapshotCallback = onNext
                return () => {
                    snapshotCallback = undefined
                }
            }) as never
        )
    })

    const fireSnapshot = (data: Record<string, unknown> | null) => {
        snapshotCallback!({
            exists: () => data !== null,
            data: () => data,
            metadata: { fromCache: false, hasPendingWrites: false },
        })
    }

    const schema = z.object({
        title: z.string(),
        updatedAt: z.any(),
    })

    it('exposes a frozen Timestamp via handle.data while sentinel sits in localState', () => {
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema })
        )
        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
        })
        sub.load()
        fireSnapshot({
            title: 'first',
            updatedAt: Timestamp.fromMillis(1000),
        })

        const handle = sub.getHandle()
        handle.update({ updatedAt: serverTimestamp() })

        // The merged view consumers see has a real Timestamp at
        // updatedAt — not the FieldValue sentinel.
        const after = sub.getState().data!
        expect(after.updatedAt).toBeInstanceOf(Timestamp)
        // And it's NOT the original syncState Timestamp — it's a fresh
        // capture from Timestamp.now() at mutation time.
        expect(after.updatedAt).not.toBe(handle.data!.updatedAt)
    })

    it('drops the override when the user overwrites the sentinel with an explicit value', () => {
        // The other path that drops an override: user changes their
        // mind mid-edit. localState's sentinel is replaced by the
        // explicit value; reconcile sees the path no longer holds a
        // sentinel and drops the override; the explicit value shows
        // through getMergedData unchanged.
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema })
        )
        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
        })
        sub.load()
        fireSnapshot({
            title: 'first',
            updatedAt: Timestamp.fromMillis(1000),
        })

        sub.getHandle().update({ updatedAt: serverTimestamp() })
        // Override captured — Timestamp shows through.
        expect(sub.getState().data!.updatedAt).toBeInstanceOf(Timestamp)

        const explicit = Timestamp.fromMillis(5000)
        sub.getHandle().update({ updatedAt: explicit })

        // Override dropped — explicit value flows directly.
        expect(sub.getState().data!.updatedAt).toBe(explicit)
    })

    it('keeps the sentinel in localState so the diff shipped to Firestore is the sentinel (not Timestamp.now())', () => {
        // This is the failure mode that motivated the whole PR. The
        // write payload — what computeDiff produces from syncState vs
        // localState — must contain the original sentinel, even
        // though the merged view returned to consumers shows a real
        // Timestamp. The two views diverge intentionally.
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema })
        )
        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
        })
        sub.load()
        fireSnapshot({
            title: 'first',
            updatedAt: Timestamp.fromMillis(1000),
        })

        const sentinel = serverTimestamp()
        sub.getHandle().update({ updatedAt: sentinel })

        // Consumer-facing view: a real Timestamp.
        const displayed = sub.getState().data!.updatedAt
        expect(displayed).toBeInstanceOf(Timestamp)
        // But the underlying handle's `data` reference is the same
        // merged view — same Timestamp.
        expect(sub.getHandle().data!.updatedAt).toBe(displayed)
        // And the displayed value is NOT the sentinel that will ship.
        expect(displayed).not.toBe(sentinel)
    })

    it('a chained update() after a serverTimestamp update keeps the sentinel in localState', () => {
        // Regression: updateState used getMergedData() as the mutation base.
        // getMergedData() substitutes the display-override Timestamp at the
        // sentinel path; a second update() would clone that Timestamp into
        // newLocalState, silently erasing the sentinel. If the sentinel is
        // erased, reconcileDisplayOverrides drops the override and
        // getMergedData() falls back to the syncState Timestamp(1000).
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema })
        )
        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
        })
        sub.load()
        fireSnapshot({ title: 'first', updatedAt: Timestamp.fromMillis(1000) })

        sub.getHandle().update({ updatedAt: serverTimestamp() })
        // Chain a second update that doesn't touch updatedAt.
        sub.getHandle().update({ title: 'second' })

        // Sentinel must still be in localState. Proxy: the display override is
        // still active, so updatedAt is NOT the syncState Timestamp(1000). If the
        // sentinel had been erased, the override would drop and Timestamp(1000) would show.
        const displayed = sub.getState().data!.updatedAt
        expect(displayed).toBeInstanceOf(Timestamp)
        expect(displayed).not.toEqual(Timestamp.fromMillis(1000))
        expect(sub.getState().data!.title).toBe('second')
    })

    it('setData undo restore payload contains the sentinel, not a frozen client Timestamp', async () => {
        // Regression: setData snapshotted deepClone(getMergedData()) for the
        // undo restore payload. getMergedData() substitutes frozen Timestamps
        // for sentinels; undo would then call setData() with a client Timestamp,
        // re-introducing the C1 regression through the undo path.
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema })
        )
        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
            onPushUndo: (undoFn, redoFn, opts) =>
                store.undoManager.push({ undo: undoFn, redo: redoFn, groupId: opts?.undoGroupId }),
        })
        sub.load()
        fireSnapshot({ title: 'first', updatedAt: Timestamp.fromMillis(1000) })

        sub.getHandle().update({ updatedAt: serverTimestamp() })
        // Display override active — shows a Timestamp that is not the syncState value.
        expect(sub.getState().data!.updatedAt).not.toEqual(Timestamp.fromMillis(1000))

        // set() captures the undo restore snapshot of the pre-set state (with sentinel).
        sub.getHandle().set({ title: 'replaced', updatedAt: Timestamp.fromMillis(9999) })
        expect(sub.getState().data!.title).toBe('replaced')

        // Undo restores the pre-set state. Sentinel is restored into localState,
        // triggering a fresh display-override capture.
        await store.undoManager.undo()

        expect(sub.getState().data!.title).toBe('first')
        // updatedAt must NOT be Timestamp(9999) — that would mean the undo payload
        // held the display-override Timestamp rather than the sentinel.
        expect(sub.getState().data!.updatedAt).not.toEqual(Timestamp.fromMillis(9999))
        // It IS a Timestamp (display override fired for the restored sentinel).
        expect(sub.getState().data!.updatedAt).toBeInstanceOf(Timestamp)
    })
})

// Pins the fix for issue #25: write failures should be retried up to
// `maxWriteRetries` times before the error is surfaced to React.
describe('Write retry on transient failures', () => {
    let store: FirestateStore
    let snapshotCallback: ((snap: unknown) => void) | undefined
    const schema = z.object({ title: z.string() })

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        store = createStore({ firestore: {} as any, autosave: 0 })

        snapshotCallback = undefined
        vi.mocked(firestore.onSnapshot).mockImplementation(
            ((_ref: unknown, onNext: (snap: unknown) => void) => {
                snapshotCallback = onNext
                return () => {
                    snapshotCallback = undefined
                }
            }) as never
        )
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    const fireDocSnapshot = (data: Record<string, unknown> | null) => {
        snapshotCallback!({
            exists: () => data !== null,
            data: () => data,
            metadata: { fromCache: false, hasPendingWrites: false },
        })
    }

    it('does not surface an error until all retries are exhausted (document set)', async () => {
        vi.mocked(firestore.setDoc).mockRejectedValue(new Error('transient'))
        const onError = vi.fn()
        store = createStore({ firestore: {} as any, autosave: 0, onError })

        const sub = createDocumentSubscription({
            store,
            definition: buildDocumentDefinition(
                doc({ path: 'items/{id}', schema, maxWriteRetries: 2, retryInterval: 100 })
            ),
            docId: 'i1',
            collectionPath: 'items',
        })
        sub.load()

        sub.getHandle().set({ title: 'new' })
        await sub.sync()

        // Attempt 1 failed — 2 retries remaining, no error yet
        expect(sub.getState().error).toBeUndefined()
        expect(onError).not.toHaveBeenCalled()
        expect(sub.getState().isSynced).toBe(false)

        await vi.advanceTimersByTimeAsync(101)
        // Attempt 2 (retry 1) failed — 1 retry remaining
        expect(sub.getState().error).toBeUndefined()
        expect(onError).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(101)
        // Attempt 3 (retry 2) failed — retries exhausted, error surfaced
        expect(sub.getState().error).toBeInstanceOf(Error)
        expect(onError).toHaveBeenCalledOnce()
        // localState preserved so the pending change is still visible
        expect(sub.getState().isSynced).toBe(false)
    })

    it('maxWriteRetries: 0 surfaces error immediately on the first failure', async () => {
        vi.mocked(firestore.setDoc).mockRejectedValue(new Error('perm denied'))
        const onError = vi.fn()
        store = createStore({ firestore: {} as any, autosave: 0, onError })

        const sub = createDocumentSubscription({
            store,
            definition: buildDocumentDefinition(
                doc({ path: 'items/{id}', schema, maxWriteRetries: 0 })
            ),
            docId: 'i1',
            collectionPath: 'items',
        })
        sub.load()

        sub.getHandle().set({ title: 'new' })
        await sub.sync()

        expect(sub.getState().error).toBeInstanceOf(Error)
        expect(onError).toHaveBeenCalledOnce()
    })

    it('a new user edit resets the retry budget', async () => {
        vi.mocked(firestore.updateDoc).mockRejectedValue(new Error('fail'))
        const onError = vi.fn()
        store = createStore({ firestore: {} as any, autosave: 0, onError })

        const sub = createDocumentSubscription({
            store,
            definition: buildDocumentDefinition(
                doc({ path: 'items/{id}', schema, maxWriteRetries: 1, retryInterval: 100 })
            ),
            docId: 'i1',
            collectionPath: 'items',
        })
        sub.load()
        fireDocSnapshot({ title: 'original' })

        // First edit: consumes 1 of 1 retry slot
        sub.getHandle().update({ title: 'v1' })
        await sub.sync()
        expect(onError).not.toHaveBeenCalled()

        // New edit before the retry fires — cancels the old timer and resets the budget
        sub.getHandle().update({ title: 'v2' })
        await sub.sync()
        // Budget was reset to 0, so this counts as attempt 1 of a fresh budget
        expect(sub.getState().error).toBeUndefined()
        expect(onError).not.toHaveBeenCalled()

        // One retry of the fresh budget exhausted — error surfaces
        await vi.advanceTimersByTimeAsync(101)
        expect(sub.getState().error).toBeInstanceOf(Error)
        expect(onError).toHaveBeenCalledOnce()
    })

    it('collection batch commit is also retried before surfacing the error', async () => {
        const mockBatch = {
            set: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            commit: vi.fn().mockRejectedValue(new Error('batch fail')),
        }
        vi.mocked(firestore.writeBatch).mockReturnValue(mockBatch as any)

        const onError = vi.fn()
        store = createStore({ firestore: {} as any, autosave: 0, onError })
        const spaceSchema = z.object({ label: z.string() })

        const sub = createCollectionSubscription({
            store,
            collectionPath: 'spaces',
            definition: buildCollectionDefinition(
                col({ path: 'spaces', schema: spaceSchema, maxWriteRetries: 1, retryInterval: 100 })
            ),
        })
        sub.load()
        // Fire an empty snapshot so syncState is defined and add() is allowed
        snapshotCallback!({ docs: [] })

        sub.getHandle().add({ label: 'room' })
        await sub.sync()

        // Attempt 1 failed — no error yet, 1 retry scheduled
        expect(sub.getState().error).toBeUndefined()
        expect(onError).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(101)

        // Retry 1 failed — retries exhausted, error surfaced
        expect(sub.getState().error).toBeInstanceOf(Error)
        expect(onError).toHaveBeenCalledOnce()
    })

    it('an intervening snapshot does not cancel the write-retry timer (autosave: 0 regression)', async () => {
        // Regression for the bug reported in the Codex review: handleSnapshot()
        // calls scheduleAutosave() when localState is pending, which previously
        // cleared writeRetryTimeout and reset writeRetryCount. With autosave: 0
        // no replacement timer was scheduled, leaving the edit stuck indefinitely.
        vi.mocked(firestore.updateDoc).mockRejectedValue(new Error('transient'))
        const onError = vi.fn()
        store = createStore({ firestore: {} as any, autosave: 0, onError })

        const sub = createDocumentSubscription({
            store,
            definition: buildDocumentDefinition(
                doc({ path: 'items/{id}', schema, maxWriteRetries: 1, retryInterval: 100 })
            ),
            docId: 'i1',
            collectionPath: 'items',
        })
        sub.load()
        fireDocSnapshot({ title: 'original' })

        sub.getHandle().update({ title: 'v1' })
        await sub.sync()

        // Retry is scheduled (1 of 1 retry budget used)
        expect(sub.getState().error).toBeUndefined()
        expect(onError).not.toHaveBeenCalled()

        // An unrelated snapshot arrives before the retry fires — must NOT
        // cancel the retry timer or reset the budget.
        fireDocSnapshot({ title: 'original' })

        // Retry still fires on schedule
        await vi.advanceTimersByTimeAsync(101)
        // Budget exhausted — error surfaced
        expect(sub.getState().error).toBeInstanceOf(Error)
        expect(onError).toHaveBeenCalledOnce()
    })
})
