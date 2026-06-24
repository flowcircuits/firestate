/**
 * Optimistic conflict resolution: how pending local edits reconcile with
 * snapshots produced by other clients.
 *
 * Contract: pending `localState` is rebased onto EVERY incoming snapshot, using
 * the prior snapshot as the baseline. That yields three guarantees:
 *
 *   - Field-level merge — fields the client did not touch follow the server;
 *     the client's own edits survive; concurrent edits to the SAME field are
 *     last-write-wins (the local edit is kept and re-sent).
 *   - Deletes win — a doc present in the baseline but absent from the new
 *     snapshot was deleted remotely. It is dropped (along with any pending local
 *     edit to it) and never recreated.
 *   - Genuine creates survive — a doc absent from every baseline is a real local
 *     create, not a remote delete, so the rebase keeps it.
 *
 * The scenarios below interleave two clients ("this client" holds pending edits;
 * "another client" mutates the server) to exercise each guarantee.
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

import { FieldPath } from 'firebase/firestore'
import { createHarness, type Harness } from './test-harness'
import { createCollectionSubscription } from '../core/collection'
import { createDocumentSubscription } from '../core/document'
import { defineCollection, defineDocument } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'

interface Doc {
    field1?: string
    field2?: string
}

interface Item {
    id?: string
    name?: string
    v?: number
}

const docDef = defineDocument<Doc>({ collection: 'docs', id: 'd1' })
const itemsDef = defineCollection<Item>({ path: 'items' })

describe('optimistic conflict resolution', () => {
    let store: FirestateStore
    let h: Harness

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        // autosave: 0 → no debounce; every write is driven by sub.sync() so
        // the snapshot/commit interleaving is deterministic.
        store = createStore({ firestore: {} as never, autosave: 0 })
        h = createHarness()
    })

    const makeDoc = () => {
        const sub = createDocumentSubscription({
            store,
            definition: docDef,
            docId: 'd1',
            collectionPath: 'docs',
        })
        sub.load()
        return sub
    }

    const makeColl = () => {
        const sub = createCollectionSubscription({
            store,
            definition: itemsDef,
            collectionPath: 'items',
        })
        sub.load()
        return sub
    }

    describe('field-level merge', () => {
        it('preserves a concurrent remote edit by writing only the locally-edited field', async () => {
            const sub = makeDoc()
            h.fireDocConfirmed({ field1: 'OLD', field2: 'OLD' })

            // This client edits field2 (pending, NOT mid-sync).
            sub.getHandle().update({ field2: 'NEW' })

            // Another client's change to field1 arrives via snapshot.
            h.fireDocConfirmed({ field1: 'A_NEW', field2: 'OLD' })

            // Merged view: field1 follows the server, field2 keeps the local edit.
            expect(sub.getState().data?.field1).toBe('A_NEW')
            expect(sub.getState().data?.field2).toBe('NEW')

            // On sync, the wire write must touch ONLY field2 — field1 is left
            // for the server's value, so the remote change is not reverted.
            const p = sub.sync()
            await h.flushMicrotasks()
            const commit = h.pendingCommits()[0]!
            expect(commit.kind).toBe('update')
            // Variadic FieldPath form: [FieldPath('field2'), 'NEW'] — and nothing
            // else. Re-writing field1 here would clobber the remote edit.
            expect(commit.fieldArgs).toEqual([new FieldPath('field2'), 'NEW'])

            h.resolveNextCommit()
            await p
            sub.stop()
        })

        it('drops the local edit once the server snapshot already reflects it', () => {
            const sub = makeDoc()
            h.fireDocConfirmed({ field1: 'OLD', field2: 'OLD' })

            sub.getHandle().update({ field2: 'NEW' })
            expect(sub.getState().isSynced).toBe(false)

            // A snapshot that already reflects the local edit (e.g. the confirmed
            // write) leaves nothing pending — localState is dropped, isSynced true.
            h.fireDocConfirmed({ field1: 'OLD', field2: 'NEW' })
            expect(sub.getState().isSynced).toBe(true)
            expect(sub.getState().data?.field2).toBe('NEW')
            sub.stop()
        })
    })

    describe('deletes win', () => {
        it('does not recreate a remotely-deleted doc that had a pending local edit', async () => {
            const sub = makeColl()
            h.fireCollectionSnapshot({
                X: { name: 'X', v: 1 },
                Y: { name: 'Y', v: 1 },
            })

            // This client edits both X and Y (pending, NOT mid-sync).
            sub.getHandle().update({ X: { v: 2 }, Y: { v: 2 } })

            // Another client deletes X — the snapshot arrives without X.
            h.fireCollectionSnapshot({ Y: { name: 'Y', v: 1 } })

            // X is gone from the merged view (delete wins). Y keeps the local edit.
            expect(sub.getState().data.X).toBeUndefined()
            expect(sub.getState().data.Y?.v).toBe(2)

            // On sync the batch must NOT contain a set op (which would recreate
            // X); only Y is updated.
            const p = sub.sync()
            await h.flushMicrotasks()
            const commit = h.pendingCommits()[0]!
            expect(commit.kind).toBe('batch')
            const ops = commit.ops!
            expect(ops.some((o) => o.type === 'set')).toBe(false)
            expect(ops).toHaveLength(1)
            expect(ops[0]!.type).toBe('update')
            // The single update targets Y, never X.
            expect((ops[0]!.ref as { id: string }).id).toBe('Y')

            h.resolveNextCommit()
            await p
            sub.stop()
        })

        it('returns to synced when the only local edit was to a remotely-deleted doc', () => {
            const sub = makeColl()
            h.fireCollectionSnapshot({ X: { name: 'X', v: 1 }, Y: { name: 'Y' } })

            // This client edits only X.
            sub.getHandle().update({ X: { v: 2 } })
            expect(sub.getState().isSynced).toBe(false)

            // Another client deletes X.
            h.fireCollectionSnapshot({ Y: { name: 'Y' } })

            // X is dropped, the local edit to it discarded, and since nothing else
            // differs from the server, the client is back in sync — no resurrect.
            expect(sub.getState().data.X).toBeUndefined()
            expect(sub.getState().data.Y?.name).toBe('Y')
            expect(sub.getState().isSynced).toBe(true)
            sub.stop()
        })
    })

    describe('genuine local creates', () => {
        it('keeps a locally-created doc that was never present on the server', () => {
            const sub = makeColl()
            h.fireCollectionSnapshot({ Y: { name: 'Y' } })

            // This client adds a brand-new doc Z (never on the server).
            sub.getHandle().add('Z', { name: 'Z' })

            // An unrelated collaborator snapshot arrives (still no Z on server).
            h.fireCollectionSnapshot({ Y: { name: 'Y' }, W: { name: 'W' } })

            // Z is NOT a remotely-deleted doc — it was never in any baseline — so
            // it survives the rebase and will be created on the next sync.
            expect(sub.getState().data.Z?.name).toBe('Z')
            expect(sub.getState().data.W?.name).toBe('W')
            expect(sub.getState().isSynced).toBe(false)
            sub.stop()
        })
    })
})
