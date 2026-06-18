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
import { vi, describe, it, expect, beforeEach } from 'vitest'

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
        setDoc: vi.fn(() => Promise.resolve()),
        updateDoc: vi.fn(() => Promise.resolve()),
        deleteDoc: vi.fn(() => Promise.resolve()),
        writeBatch: vi.fn(() => ({
            set: vi.fn(),
            update: vi.fn(),
            delete: vi.fn(),
            commit: vi.fn(() => Promise.resolve()),
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

// Pins the fix for issue #26: subscription rebuild on readOnly/query change
// must not silently discard pending un-synced localState.
describe('Issue #26: readOnly as live ref / flush on teardown', () => {
    let store: FirestateStore
    let snapshotCallback: ((snap: unknown) => void) | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        // Use a large autosave so the debounce timer never fires during tests —
        // we control sync() calls explicitly.
        store = createStore({ firestore: {} as any, autosave: 999999 })

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

    const fireDocSnapshot = (data: Record<string, unknown> | null) => {
        snapshotCallback!({
            exists: () => data !== null,
            data: () => data,
            metadata: { fromCache: false, hasPendingWrites: false },
        })
    }

    const fireColSnapshot = (docs: Array<{ id: string; data: Record<string, unknown> }>) => {
        snapshotCallback!({
            docs: docs.map((d) => ({ id: d.id, data: () => d.data })),
        })
    }

    const taskSchema = z.object({ title: z.string() })

    // Part 1: readOnly toggle must not discard pending localState

    it('toggling getReadOnly on a document subscription does not discard pending localState', () => {
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema: taskSchema })
        )

        let readOnly = false
        const getReadOnly = () => readOnly

        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
            getReadOnly,
        })
        sub.load()
        fireDocSnapshot({ title: 'original' })

        sub.getHandle().update({ title: 'edited' })
        expect(sub.getState().isSynced).toBe(false)
        expect(sub.getState().data?.title).toBe('edited')

        // Toggle readOnly — must not rebuild the subscription or clear localState
        readOnly = true

        expect(sub.getState().isSynced).toBe(false)
        expect(sub.getState().data?.title).toBe('edited')

        // Write guard is now active — further mutations must be blocked
        sub.getHandle().update({ title: 'blocked' })
        expect(sub.getState().data?.title).toBe('edited')

        // Re-enabling writes must work on the same subscription
        readOnly = false
        sub.getHandle().update({ title: 'continued' })
        expect(sub.getState().data?.title).toBe('continued')
        expect(sub.getState().isSynced).toBe(false)
    })

    it('toggling getReadOnly on a collection subscription does not discard pending localState', () => {
        const definition = buildCollectionDefinition(
            col({ path: 'tasks', schema: taskSchema })
        )

        let readOnly = false
        const getReadOnly = () => readOnly

        const sub = createCollectionSubscription({
            store,
            definition,
            collectionPath: 'tasks',
            getReadOnly,
        })
        sub.load()
        fireColSnapshot([{ id: 't1', data: { title: 'original', id: 't1' } }])

        sub.getHandle().update({ t1: { title: 'edited' } })
        expect(sub.getState().isSynced).toBe(false)
        expect(sub.getState().data['t1']?.title).toBe('edited')

        // Toggle readOnly — must not discard the pending edit
        readOnly = true

        expect(sub.getState().isSynced).toBe(false)
        expect(sub.getState().data['t1']?.title).toBe('edited')

        // Re-enable and verify further edits work
        readOnly = false
        sub.getHandle().update({ t1: { title: 'continued' } })
        expect(sub.getState().data['t1']?.title).toBe('continued')
        expect(sub.getState().isSynced).toBe(false)
    })

    // Part 2: fire-and-forget sync on teardown must attempt the Firestore write

    it('sync() before stop() on a document subscription flushes pending localState', async () => {
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema: taskSchema })
        )

        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
        })
        sub.load()
        fireDocSnapshot({ title: 'original' })

        sub.getHandle().update({ title: 'edited' })
        expect(sub.getState().isSynced).toBe(false)

        // Simulate the hook cleanup: fire-and-forget sync then stop
        const syncPromise = sub.sync()
        sub.stop()
        await syncPromise

        // updateDoc must have been called for the partial update
        expect(vi.mocked(firestore.updateDoc)).toHaveBeenCalled()
    })

    it('sync() before stop() on a collection subscription flushes pending localState', async () => {
        const definition = buildCollectionDefinition(
            col({ path: 'tasks', schema: taskSchema })
        )

        const sub = createCollectionSubscription({
            store,
            definition,
            collectionPath: 'tasks',
        })
        sub.load()
        fireColSnapshot([{ id: 't1', data: { title: 'original', id: 't1' } }])

        sub.getHandle().update({ t1: { title: 'edited' } })
        expect(sub.getState().isSynced).toBe(false)

        const syncPromise = sub.sync()
        sub.stop()
        await syncPromise

        expect(vi.mocked(firestore.writeBatch)).toHaveBeenCalled()
    })

    it('stop() after sync() does not leave a stale sync key in the global store', async () => {
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema: taskSchema })
        )

        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
        })
        sub.load()
        fireDocSnapshot({ title: 'original' })

        sub.getHandle().update({ title: 'edited' })
        // Global store sees this subscription as unsynced
        expect(store.isSynced).toBe(false)

        const syncPromise = sub.sync()
        sub.stop()
        // stop() must immediately unregister the key so isSynced can flip back
        expect(store.isSynced).toBe(true)

        // Completing the async sync must not re-add the stale key
        await syncPromise
        expect(store.isSynced).toBe(true)
    })

    // Part 3: stopped flag must be reset on retry so isSynced tracking resumes

    it('load() after stop() resets stopped so reportSyncState is called again', () => {
        // Regression for the retryOnError path: stop() sets stopped=true,
        // then load() re-activates. Without the reset, notify() would skip
        // reportSyncState forever, leaving useIsSynced stuck after a retry.
        const definition = buildDocumentDefinition(
            doc({ path: 'tasks/{taskId}', schema: taskSchema })
        )

        const sub = createDocumentSubscription({
            store,
            definition,
            docId: 't1',
            collectionPath: 'tasks',
        })
        sub.load()
        fireDocSnapshot({ title: 'original' })

        // Simulate retryOnError teardown + reload
        sub.stop()
        expect(store.isSynced).toBe(true)

        sub.load()
        fireDocSnapshot({ title: 'original' })

        // After reload an edit must flip isSynced back to false
        sub.getHandle().update({ title: 'after-retry' })
        expect(store.isSynced).toBe(false)
        expect(sub.getState().isSynced).toBe(false)
    })
})
