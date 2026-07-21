import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('firebase/firestore', async () => {
    const actual =
        await vi.importActual<typeof import('firebase/firestore')>(
            'firebase/firestore'
        )
    const { buildFirestoreMock } = await import('./test-harness')
    return buildFirestoreMock(actual as unknown as Record<string, unknown>)
})

import { createCollectionSubscription } from '../core/collection'
import { createDocumentSubscription } from '../core/document'
import { createStore, type FirestateStore } from '../core/store'
import { defineCollection, defineDocument } from '../registry/schema'
import type { FirestoreObject } from '../types'
import { createHarness, type Harness } from './test-harness'
import { deleteField } from 'firebase/firestore'

interface Item extends FirestoreObject {
    id: string
    value: number
}

const documentDefinition = defineDocument<Item>({
    collection: 'documents',
    id: (params) => params.id!,
    autosave: 1000,
})

const collectionDefinition = defineCollection<Item>({
    path: 'items',
    autosave: 0,
})

describe('persistence coordination', () => {
    let harness: Harness
    let store: FirestateStore

    beforeEach(() => {
        vi.useFakeTimers()
        harness = createHarness()
        store = createStore({ firestore: {} as never, autosave: 1000 })
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    const loadedDocument = (id: string) => {
        const sub = createDocumentSubscription({
            store,
            definition: documentDefinition,
            collectionPath: 'documents',
            docId: id,
        })
        sub.load()
        harness.fireDocSnapshot({ id, value: 0 })
        vi.runOnlyPendingTimers()
        return sub
    }

    it('flushes multiple resources and waits for every commit', async () => {
        const first = loadedDocument('a')
        const second = loadedDocument('b')
        first.getHandle().update({ value: 1 })
        second.getHandle().update({ value: 2 })

        let settled = false
        const flushing = store.flush().then(() => {
            settled = true
        })

        expect(harness.pendingCommits()).toHaveLength(2)
        harness.resolveNextCommit()
        await harness.flushMicrotasks()
        expect(settled).toBe(false)

        harness.resolveNextCommit()
        await flushing
        expect(settled).toBe(true)
        expect(store.hasPendingWrites).toBe(false)
    })

    it('includes a write that was already in flight', async () => {
        const sub = loadedDocument('a')
        sub.getHandle().update({ value: 1 })
        const directSync = sub.sync()

        const flushing = store.flush()
        expect(store.flush()).toBe(flushing)
        expect(harness.pendingCommits()).toHaveLength(1)

        harness.resolveNextCommit()
        await Promise.all([directSync, flushing])
        expect(store.hasPendingWrites).toBe(false)
    })

    it('does not clear an update queued while a flush is in progress', async () => {
        const sub = loadedDocument('a')
        sub.getHandle().update({ value: 1 })
        const flushing = store.flush()

        sub.getHandle().update({ value: 2 })
        harness.resolveNextCommit()
        await harness.flushMicrotasks()
        await harness.flushMicrotasks()

        expect(harness.pendingCommits()).toHaveLength(1)
        expect(store.hasPendingWrites).toBe(true)

        harness.resolveNextCommit()
        await flushing
        expect(store.hasPendingWrites).toBe(false)
    })

    it('drains an edit whose autosave fires during a document sync', async () => {
        const sub = loadedDocument('a')
        sub.getHandle().update({ value: 1 })
        const firstSync = sub.sync()

        sub.getHandle().update({ value: 2 })
        vi.advanceTimersByTime(1000)
        harness.resolveNextCommit()
        await firstSync
        await harness.flushMicrotasks()

        expect(harness.pendingCommits()).toHaveLength(1)
        harness.resolveNextCommit()
        await harness.flushMicrotasks()
        expect(store.hasPendingWrites).toBe(false)
    })

    it('drains an edit whose autosave fires during a collection sync', async () => {
        const sub = createCollectionSubscription({
            store,
            definition: defineCollection<Item>({
                path: 'autosave-items',
                autosave: 1000,
            }),
            collectionPath: 'autosave-items',
        })
        sub.load()
        harness.fireCollectionSnapshot({ a: { id: 'a', value: 0 } })
        vi.runOnlyPendingTimers()

        sub.getHandle().update({ a: { value: 1 } })
        const firstSync = sub.sync()
        sub.getHandle().update({ a: { value: 2 } })
        vi.advanceTimersByTime(1000)
        harness.resolveNextCommit()
        await firstSync
        await harness.flushMicrotasks()

        expect(harness.pendingCommits()).toHaveLength(1)
        harness.resolveNextCommit()
        await harness.flushMicrotasks()
        expect(store.hasPendingWrites).toBe(false)
    })

    it('resolves a collection edit absorbed by a snapshot before autosave', async () => {
        const sub = createCollectionSubscription({
            store,
            definition: defineCollection<Item>({
                path: 'absorbed-items',
                autosave: 1000,
            }),
            collectionPath: 'absorbed-items',
        })
        sub.load()
        harness.fireCollectionSnapshot({ a: { id: 'a', value: 0 } })
        vi.runOnlyPendingTimers()

        sub.getHandle().update({ a: { value: 1 } })
        expect(store.hasPendingWrites).toBe(true)
        harness.fireCollectionSnapshot({ a: { id: 'a', value: 1 } })

        expect(sub.getState().isSynced).toBe(true)
        expect(store.hasPendingWrites).toBe(false)
        await expect(store.flush()).resolves.toBeUndefined()
        expect(harness.commitCount()).toBe(0)
    })

    it('rejects on write failure and keeps the failed work observable', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const sub = loadedDocument('a')
        sub.getHandle().update({ value: 1 })

        const flushing = store.flush()
        harness.rejectNextCommit('permission-denied')

        await expect(flushing).rejects.toThrow('permission-denied')
        expect(sub.getState().error?.message).toContain('permission-denied')
        expect(store.hasPendingWrites).toBe(true)

        const retrying = store.flush()
        harness.resolveNextCommit()
        await retrying
        expect(store.hasPendingWrites).toBe(false)
    })
})

describe('collection write batching', () => {
    let harness: Harness
    let store: FirestateStore

    beforeEach(() => {
        harness = createHarness()
        store = createStore({ firestore: {} as never, autosave: 0 })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const loadedCollection = () => {
        const sub = createCollectionSubscription({
            store,
            definition: collectionDefinition,
            collectionPath: 'items',
        })
        sub.load()
        const docs = Object.fromEntries(
            Array.from({ length: 501 }, (_, index) => {
                const id = `item-${index}`
                return [id, { id, value: 0 }]
            })
        )
        harness.fireCollectionSnapshot(docs)
        return sub
    }

    const allUpdates = () =>
        Object.fromEntries(
            Array.from({ length: 501 }, (_, index) => [
                `item-${index}`,
                { value: 1 },
            ])
        )

    it('commits 501 dirty documents in chunks of 500 and 1', async () => {
        const sub = loadedCollection()
        sub.getHandle().update(allUpdates())

        const syncing = sub.sync()
        expect(harness.pendingCommits()[0]!.ops).toHaveLength(500)

        harness.resolveNextCommit()
        await harness.flushMicrotasks()
        expect(harness.pendingCommits()[0]!.ops).toHaveLength(1)

        harness.resolveNextCommit()
        await syncing
        expect(harness.commitCount()).toBe(2)
    })

    it('retries only the uncommitted documents when a later chunk fails', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const sub = loadedCollection()
        sub.getHandle().update(allUpdates())

        const syncing = sub.sync()
        harness.resolveNextCommit()
        await harness.flushMicrotasks()
        harness.rejectNextCommit('permission-denied')
        await expect(syncing).rejects.toThrow('permission-denied')

        const retrying = sub.sync()
        expect(harness.pendingCommits()[0]!.ops).toHaveLength(1)
        harness.resolveNextCommit()
        await retrying
    })
})

describe('atomic multi-resource updates', () => {
    let harness: Harness
    let store: FirestateStore

    beforeEach(() => {
        harness = createHarness()
        store = createStore({ firestore: {} as never, autosave: 0 })
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    const collectionAt = (path: string, docs: Record<string, Item>) => {
        const sub = createCollectionSubscription({
            store,
            definition: defineCollection<Item>({ path, autosave: 0 }),
            collectionPath: path,
        })
        sub.load()
        harness.fireCollectionSnapshot(docs)
        return sub
    }

    it('uses one batch and one undo action across two collections', async () => {
        const first = collectionAt('first', { a: { id: 'a', value: 0 } })
        const second = collectionAt('second', { b: { id: 'b', value: 0 } })

        const committing = store.atomic(
            ({ update }) => {
                update(first.getHandle(), { a: { value: 1 } })
                update(second.getHandle(), { b: { value: 2 } })
            },
            { description: 'Update both collections' }
        )

        expect(first.getHandle().data.a!.value).toBe(1)
        expect(second.getHandle().data.b!.value).toBe(2)
        expect(harness.pendingCommits()).toHaveLength(1)
        expect(harness.pendingCommits()[0]!.ops).toHaveLength(2)

        harness.resolveNextCommit()
        await committing
        expect(store.undoManager.undoStack).toHaveLength(1)
        expect(store.undoManager.undoStack[0]!.description).toBe(
            'Update both collections'
        )

        const undoing = store.undoManager.undo()
        expect(first.getHandle().data.a!.value).toBe(0)
        expect(second.getHandle().data.b!.value).toBe(0)
        expect(harness.pendingCommits()).toHaveLength(1)
        harness.resolveNextCommit()
        await undoing

        const redoing = store.undoManager.redo()
        expect(first.getHandle().data.a!.value).toBe(1)
        expect(second.getHandle().data.b!.value).toBe(2)
        expect(harness.pendingCommits()).toHaveLength(1)
        harness.resolveNextCommit()
        await redoing
    })

    it('does not leak per-resource writes when atomic participants stop', async () => {
        const document = createDocumentSubscription({
            store,
            definition: defineDocument<Item>({
                collection: 'atomic-documents',
                id: 'a',
                autosave: 0,
            }),
            collectionPath: 'atomic-documents',
            docId: 'a',
        })
        document.load()
        harness.fireDocSnapshot({ id: 'a', value: 0 })
        const collection = collectionAt('second', { b: { id: 'b', value: 0 } })

        const committing = store.atomic(({ update }) => {
            update(document.getHandle(), { value: 1 })
            update(collection.getHandle(), { b: { value: 2 } })
        })
        document.stop()
        collection.stop()

        expect(harness.pendingCommits()).toHaveLength(1)
        expect(harness.pendingCommits()[0]!.kind).toBe('batch')
        expect(harness.pendingCommits()[0]!.ops).toHaveLength(2)

        harness.resolveNextCommit()
        await committing
        expect(harness.commitCount()).toBe(1)
    })

    it('undoes an atomic collection delete by recreating the document', async () => {
        const sub = collectionAt('deletions', { a: { id: 'a', value: 1 } })

        const deleting = store.atomic(({ update }) => {
            update(sub.getHandle(), { a: deleteField() })
        })
        expect(sub.getHandle().data.a).toBeUndefined()
        expect(harness.pendingCommits()[0]!.ops).toEqual([
            expect.objectContaining({ type: 'delete' }),
        ])
        harness.resolveNextCommit()
        await deleting

        const undoing = store.undoManager.undo()
        expect(sub.getHandle().data.a).toEqual({ id: 'a', value: 1 })
        expect(harness.pendingCommits()[0]!.ops).toEqual([
            expect.objectContaining({
                type: 'set',
                data: { id: 'a', value: 1 },
            }),
        ])
        harness.resolveNextCommit()
        await undoing
    })

    it('rejects more than 500 writes before changing state or committing', async () => {
        const docs = Object.fromEntries(
            Array.from({ length: 501 }, (_, index) => {
                const id = `item-${index}`
                return [id, { id, value: 0 }]
            })
        )
        const sub = collectionAt('large', docs)
        const updates = Object.fromEntries(
            Object.keys(docs).map((id) => [id, { value: 1 }])
        )

        await expect(
            store.atomic(({ update }) => update(sub.getHandle(), updates))
        ).rejects.toThrow("exceeds Firestore's 500-write atomic limit")

        expect(harness.commitCount()).toBe(0)
        expect(sub.getHandle().data['item-0']!.value).toBe(0)
    })

    it('rejects a resource that already has pending changes', async () => {
        const sub = collectionAt('pending', { a: { id: 'a', value: 0 } })
        sub.getHandle().update({ a: { value: 1 } })

        await expect(
            store.atomic(({ update }) =>
                update(sub.getHandle(), { a: { value: 2 } })
            )
        ).rejects.toThrow('already has pending or in-flight changes')
    })

    it('rejects read-only and unavailable handles', async () => {
        const readOnly = createCollectionSubscription({
            store,
            definition: defineCollection<Item>({ path: 'readonly' }),
            collectionPath: 'readonly',
            readOnly: true,
        })
        readOnly.load()
        harness.fireCollectionSnapshot({ a: { id: 'a', value: 0 } })

        await expect(
            store.atomic(({ update }) =>
                update(readOnly.getHandle(), { a: { value: 1 } })
            )
        ).rejects.toThrow('read-only')

        const unavailable = createCollectionSubscription({
            store,
            definition: defineCollection<Item>({ path: 'unavailable' }),
            collectionPath: 'unavailable',
        })
        await expect(
            store.atomic(({ update }) =>
                update(unavailable.getHandle(), { a: { value: 1 } })
            )
        ).rejects.toThrow('unavailable')
    })
})
