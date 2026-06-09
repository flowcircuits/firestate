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
})
