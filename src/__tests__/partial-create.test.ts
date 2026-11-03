/**
 * A collection must never create a document from a partial diff.
 *
 * `update(diff)` applies the diff onto local state, and `sync()` uses
 * `batch.set` for any id that is not on the server. Without a guard, a partial
 * diff for an unknown id (an undo/redo of an edit to a doc another client
 * deleted, or a stray `update`) writes a fragment document.
 *
 * Contract: a new id enters the collection only through `add()`, through the
 * undo/redo of `add()`/`remove()` (which restore a whole document), or when
 * the merged document passes the definition's `validateCreate` (default: the
 * `schema`). Any other new id is dropped and reported to `onRejectedCreate`.
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

import { z } from 'zod'
import { arrayUnion, deleteField, serverTimestamp } from 'firebase/firestore'
import { createHarness, type BatchOp, type Harness } from './test-harness'
import { createCollectionSubscription } from '../core/collection'
import { defineCollection } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'
import type { CollectionDefinition, RejectedCreateContext } from '../types'

const ItemSchema = z.object({ id: z.string(), name: z.string(), v: z.number() })
type Item = z.infer<typeof ItemSchema>

const schemaDef = defineCollection({ path: 'items', schema: ItemSchema })
const plainDef = defineCollection<Partial<Item>>({ path: 'items' })

describe('partial updates never create documents', () => {
    let store: FirestateStore
    let h: Harness
    let rejected: RejectedCreateContext[]

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        rejected = []
        store = createStore({
            firestore: {} as never,
            autosave: 0,
            onRejectedCreate: (context) => rejected.push(context),
        })
        h = createHarness()
    })

    const makeColl = <T extends Partial<Item>>(
        definition: CollectionDefinition<T> = schemaDef as never
    ) => {
        const sub = createCollectionSubscription<T>({
            store,
            definition,
            collectionPath: 'items',
            onPushUndo: (undo, redo, options) =>
                store.undoManager.push({
                    undo,
                    redo,
                    groupId: options?.undoGroupId,
                }),
        })
        sub.load()
        return sub
    }

    /** Sync and return the batch ops written, or [] when nothing was written. */
    const syncOps = async (sub: { sync: () => Promise<void> }) => {
        const before = h.commitCount()
        const p = sub.sync()
        await h.flushMicrotasks()
        if (h.commitCount() === before) {
            await p
            return [] as BatchOp[]
        }
        const ops = h.pendingCommits().at(-1)!.ops!
        h.resolveNextCommit()
        await p
        return ops
    }

    const setIds = (ops: BatchOp[]) =>
        ops
            .filter((o) => o.type === 'set')
            .map((o) => (o.ref as { id: string }).id)

    it('undo of a partial edit to a remotely-deleted doc does not recreate it', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ X: { name: 'X', v: 1 } })

        sub.getHandle().update({ X: { v: 2 } })
        await syncOps(sub)
        h.fireCollectionSnapshot({ X: { name: 'X', v: 2 } })

        // Another client deletes X outside this client's undo stack.
        h.fireCollectionSnapshot({})
        expect(sub.getState().data.X).toBeUndefined()

        // The undo entry is the partial `{ X: { v: 1 } }`.
        await store.undoManager.undo()

        expect(sub.getState().data.X).toBeUndefined()
        expect(sub.getState().isSynced).toBe(true)
        expect(setIds(await syncOps(sub))).toEqual([])
        expect(rejected).toEqual([
            expect.objectContaining({
                path: 'items',
                id: 'X',
                source: 'undo',
                data: { v: 1, id: 'X' },
            }),
        ])
        sub.stop()
    })

    it('redo of a partial edit to a remotely-deleted doc does not recreate it', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ X: { name: 'X', v: 1 } })

        sub.getHandle().update({ X: { v: 2 } })
        await store.undoManager.undo()
        expect(setIds(await syncOps(sub))).toEqual([])

        h.fireCollectionSnapshot({})
        await store.undoManager.redo()

        expect(sub.getState().data.X).toBeUndefined()
        expect(setIds(await syncOps(sub))).toEqual([])
        expect(rejected).toEqual([
            expect.objectContaining({ id: 'X', source: 'redo' }),
        ])
        sub.stop()
    })

    it('drops a partial update for an unknown id and keeps the rest of the diff', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ Y: { name: 'Y', v: 1 } })

        sub.getHandle().update({ X: { v: 2 }, Y: { v: 2 } })

        expect(sub.getState().data.X).toBeUndefined()
        expect(sub.getState().data.Y?.v).toBe(2)
        const ops = await syncOps(sub)
        expect(setIds(ops)).toEqual([])
        expect(ops.map((o) => (o.ref as { id: string }).id)).toEqual(['Y'])
        expect(rejected).toEqual([
            expect.objectContaining({ id: 'X', source: 'update' }),
        ])
        sub.stop()
    })

    it('a rejected create alone is a no-op: no state change and no undo entry', () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ Y: { name: 'Y', v: 1 } })
        const before = sub.getState()

        sub.getHandle().update({ X: { v: 2 } })

        expect(sub.getState()).toBe(before)
        expect(store.undoManager.canUndo).toBe(false)
        expect(rejected).toHaveLength(1)
        sub.stop()
    })

    it('creates a doc through update() when the merged doc passes the schema', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({})

        sub.getHandle().update({ X: { name: 'X', v: 1 } })

        expect(sub.getState().data.X).toEqual({ id: 'X', name: 'X', v: 1 })
        expect(setIds(await syncOps(sub))).toEqual(['X'])
        expect(rejected).toEqual([])
        sub.stop()
    })

    it('uses validateCreate instead of the schema when the definition sets it', () => {
        const sub = makeColl(
            defineCollection({
                path: 'items',
                schema: ItemSchema,
                validateCreate: (data) => data.name !== 'blocked',
            }) as never
        )
        h.fireCollectionSnapshot({})

        sub.getHandle().update({
            ok: { v: 1 },
            blocked: { name: 'blocked', v: 1 },
        } as never)

        expect(Object.keys(sub.getState().data)).toEqual(['ok'])
        expect(rejected.map((r) => r.id)).toEqual(['blocked'])
        sub.stop()
    })

    it('rejects every update() create when there is no schema or validateCreate', () => {
        const sub = makeColl(plainDef)
        h.fireCollectionSnapshot({})

        sub.getHandle().update({ X: { name: 'X', v: 1 } })

        expect(sub.getState().data.X).toBeUndefined()
        expect(rejected.map((r) => r.id)).toEqual(['X'])
        sub.stop()
    })

    it('add() still creates without a schema, and undo/redo of add() round-trips', async () => {
        const sub = makeColl(plainDef)
        h.fireCollectionSnapshot({})

        sub.getHandle().add('X', { name: 'X' })
        expect(setIds(await syncOps(sub))).toEqual(['X'])
        h.fireCollectionSnapshot({ X: { name: 'X' } })

        await store.undoManager.undo()
        expect(sub.getState().data.X).toBeUndefined()
        await syncOps(sub)
        h.fireCollectionSnapshot({})

        await store.undoManager.redo()
        expect(sub.getState().data.X).toEqual({ id: 'X', name: 'X' })
        expect(setIds(await syncOps(sub))).toEqual(['X'])
        expect(rejected).toEqual([])
        sub.stop()
    })

    it('undo of remove() restores the whole doc after the delete synced', async () => {
        const sub = makeColl(plainDef)
        h.fireCollectionSnapshot({ X: { name: 'X', v: 1 } })

        sub.getHandle().remove('X')
        await syncOps(sub)
        h.fireCollectionSnapshot({})

        await store.undoManager.undo()
        expect(sub.getState().data.X).toEqual({ id: 'X', name: 'X', v: 1 })
        expect(setIds(await syncOps(sub))).toEqual(['X'])
        expect(rejected).toEqual([])
        sub.stop()
    })

    it('without onRejectedCreate, a rejected create warns', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
        store = createStore({ firestore: {} as never, autosave: 0 })
        const sub = makeColl()
        h.fireCollectionSnapshot({})

        sub.getHandle().update({ X: { v: 1 } })

        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('[firestate] Rejected a create of items/X')
        )
        sub.stop()
    })

    it('undo of an update() whole delete restores a doc that fails the current schema', async () => {
        const sub = makeColl()
        // X predates the schema: `v` is a string, so it fails ItemSchema.
        h.fireCollectionSnapshot({
            X: { name: 'X', v: 'legacy' },
            Y: { name: 'Y', v: 1 },
        })

        sub.getHandle().update({ X: deleteField(), Y: { v: 2 } } as never)
        await syncOps(sub)
        h.fireCollectionSnapshot({ Y: { name: 'Y', v: 2 } })

        await store.undoManager.undo()

        expect(sub.getState().data.X).toEqual({
            id: 'X',
            name: 'X',
            v: 'legacy',
        })
        expect(sub.getState().data.Y?.v).toBe(1)
        expect(setIds(await syncOps(sub))).toEqual(['X'])
        expect(rejected).toEqual([])
        h.fireCollectionSnapshot({
            X: { name: 'X', v: 'legacy' },
            Y: { name: 'Y', v: 1 },
        })

        // Redo deletes X again; a second undo restores it again.
        await store.undoManager.redo()
        expect(sub.getState().data.X).toBeUndefined()
        await syncOps(sub)
        h.fireCollectionSnapshot({ Y: { name: 'Y', v: 2 } })
        await store.undoManager.undo()
        expect(sub.getState().data.X).toEqual({
            id: 'X',
            name: 'X',
            v: 'legacy',
        })
        expect(rejected).toEqual([])
        sub.stop()
    })

    it('redo of an update() create restores it whole after a remote delete', async () => {
        const sub = makeColl(
            defineCollection({
                path: 'items',
                schema: ItemSchema,
                // Only the first create passes; the replay must not re-check.
                validateCreate: () => !rejectFurther,
            }) as never
        )
        let rejectFurther = false
        h.fireCollectionSnapshot({})

        sub.getHandle().update({ X: { name: 'X', v: 1 } })
        rejectFurther = true
        await syncOps(sub)
        h.fireCollectionSnapshot({ X: { name: 'X', v: 1 } })
        await store.undoManager.undo()
        await syncOps(sub)
        h.fireCollectionSnapshot({})

        await store.undoManager.redo()

        expect(sub.getState().data.X).toEqual({ id: 'X', name: 'X', v: 1 })
        expect(setIds(await syncOps(sub))).toEqual(['X'])
        expect(rejected).toEqual([])
        sub.stop()
    })

    describe('default create check with Firestore sentinels', () => {
        const SentinelSchema = z.object({
            id: z.string(),
            name: z.string(),
            createdAt: z.number(),
            tags: z.array(z.string()).optional(),
        })
        const sentinelDef = defineCollection({
            path: 'items',
            schema: SentinelSchema,
        })

        it('accepts a create whose sentinel fields stand in for typed values', async () => {
            const sub = makeColl(sentinelDef as never)
            h.fireCollectionSnapshot({})

            sub.getHandle().update({
                X: {
                    name: 'X',
                    createdAt: serverTimestamp(),
                    tags: arrayUnion('a'),
                },
            } as never)

            expect(sub.getState().data.X?.name).toBe('X')
            expect(setIds(await syncOps(sub))).toEqual(['X'])
            expect(rejected).toEqual([])
            sub.stop()
        })

        it('still rejects a create that fails the schema outside its sentinels', () => {
            const sub = makeColl(sentinelDef as never)
            h.fireCollectionSnapshot({})

            // `name` is missing; the sentinel does not excuse it.
            sub.getHandle().update({
                X: { createdAt: serverTimestamp() },
            } as never)

            expect(sub.getState().data.X).toBeUndefined()
            expect(rejected.map((r) => r.id)).toEqual(['X'])
            sub.stop()
        })
    })

    describe('undo steps with rejected creates', () => {
        let onUndo: ReturnType<typeof vi.fn>
        let onRedo: ReturnType<typeof vi.fn>

        beforeEach(() => {
            onUndo = vi.fn()
            onRedo = vi.fn()
            store = createStore({
                firestore: {} as never,
                autosave: 0,
                onUndo,
                onRedo,
                onRejectedCreate: (context) => rejected.push(context),
            })
        })

        it('a grouped undo applies the members it can and rejects the rest', async () => {
            const sub = makeColl()
            h.fireCollectionSnapshot({
                X: { name: 'X', v: 1 },
                Y: { name: 'Y', v: 1 },
            })

            sub.getHandle().update({ X: { v: 2 } }, { undoGroupId: 'g' })
            sub.getHandle().update({ Y: { v: 2 } }, { undoGroupId: 'g' })
            await syncOps(sub)
            h.fireCollectionSnapshot({
                X: { name: 'X', v: 2 },
                Y: { name: 'Y', v: 2 },
            })
            h.fireCollectionSnapshot({ Y: { name: 'Y', v: 2 } })

            await store.undoManager.undo()

            expect(sub.getState().data.X).toBeUndefined()
            expect(sub.getState().data.Y?.v).toBe(1)
            expect(setIds(await syncOps(sub))).toEqual([])
            expect(rejected).toEqual([
                expect.objectContaining({ id: 'X', source: 'undo' }),
            ])
            expect(onUndo).toHaveBeenCalledTimes(1)
            expect(store.undoManager.canRedo).toBe(true)
            h.fireCollectionSnapshot({ Y: { name: 'Y', v: 1 } })

            await store.undoManager.redo()

            expect(sub.getState().data.X).toBeUndefined()
            expect(sub.getState().data.Y?.v).toBe(2)
            expect(rejected.map((r) => r.source)).toEqual(['undo', 'redo'])
            expect(onRedo).toHaveBeenCalledTimes(1)
            sub.stop()
        })

        it('an undo whose every create is rejected is dropped, not moved to redo', async () => {
            const sub = makeColl()
            h.fireCollectionSnapshot({ X: { name: 'X', v: 1 } })

            sub.getHandle().update({ X: { v: 2 } })
            await syncOps(sub)
            h.fireCollectionSnapshot({ X: { name: 'X', v: 2 } })
            h.fireCollectionSnapshot({})

            await store.undoManager.undo()

            expect(rejected).toHaveLength(1)
            expect(store.undoManager.canUndo).toBe(false)
            expect(store.undoManager.canRedo).toBe(false)
            expect(onUndo).not.toHaveBeenCalled()
            sub.stop()
        })
    })
})
