/**
 * §9 acceptance contract for the update-logic rewrite (rev. 3 spec).
 *
 * These tests assert the DESIRED post-rewrite behavior. The status column
 * reflects the state AFTER the baseline-rebase fix (0.1.3), which delivers the
 * continuous field-level merge (§4) but NOT the metadata-gating, buffering, or
 * same-field-remote-wins layers (those remain future PRs):
 *
 *   §9.1 collaborator reconcile ............... GREEN (delivered by 0.1.3 rebase)
 *   §9.2 create before first snapshot ......... SKIP  (→ PR-2: §5 buffering)
 *   §9.4 no-op stability (NaN + undefined) .... GREEN
 *   §9.7 in-flight re-edit (second wins) ...... MUST-STAY-GREEN
 *   §9.8 same-value race (flag-driven) ........ SKIP  (→ PR-2/PR-3: D2/D3 metadata)
 *   G1   document delete/tombstone confirm .... MUST-STAY-GREEN
 *   G4   per-doc gating (aggregate trap) ...... MUST-STAY-GREEN (D2 forward-lock)
 *
 * The SKIPPED tests assert behavior that is deliberately out of scope for the
 * 0.1.3 baseline-rebase fix and is tracked in later PRs of the rev. 3 spec:
 *   - §9.2 first-snapshot buffering (spec §5 / P0-b).
 *   - §9.8 echo gating on per-doc `hasPendingWrites` (spec §4 / D2 + D3), which
 *     requires `includeMetadataChanges: true` on the listener.
 *   - §9.8 control "same-field collaborator change → remote wins": the 0.1.3
 *     fix keeps same-field concurrent edits last-write-wins (the local edit is
 *     preserved and re-sent), so remote-wins is NOT yet implemented. Removing
 *     the skip requires the basis-relative conflict detection of spec §4.
 *
 * §9.3 (re-entrancy), §9.5 (retry), §9.6 (readOnly lifecycle), and the
 * remaining gap tests (G2/G3/G5) are authored alongside PR-3/PR-4, where their
 * observable surface (syncing guard, retry classification, isSynced floor) is
 * pinned.
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
    name?: string
    area?: number
    foo?: number
    v?: number
}

const spaces = defineCollection<Space>({ path: 'spaces' })

interface Doc {
    a?: number
    v?: number
    name?: string
    note?: string
}
const docDef = defineDocument<Doc>({ collection: 'docs', id: 'd1' })

describe('Firestate update-logic rewrite — §9 acceptance contract', () => {
    let store: FirestateStore
    let h: Harness

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        // autosave: 0 → no debounce timer; every write is driven by an
        // explicit sub.sync() so the commit→confirm timing is deterministic.
        store = createStore({ firestore: {} as never, autosave: 0 })
        h = createHarness()
    })

    const makeColl = (path = 'spaces') => {
        const sub = createCollectionSubscription({
            store,
            definition: spaces,
            collectionPath: path,
        })
        sub.load()
        return sub
    }

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

    // ── §9.1 collaborator reconcile (RED → PR-2) ──────────────────────────
    // With a pending local edit to A.name and NOT in flight, a confirmed
    // snapshot brings a new collaborator doc B and a collaborator change to
    // A.area. The merged view must adopt B and A.area while keeping my
    // pending A.name. Today localState (a full pre-collaborator snapshot)
    // masks both server changes — B is invisible and A.area is stale.
    it('§9.1 adopts collaborator doc + field while preserving my pending edit', () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ A: { name: 'A', area: 10 } })

        sub.getHandle().update({ A: { name: 'Mine', area: 10 } })

        // Collaborator confirmed change: A.area→99, new doc B. (Not my echo.)
        h.fireCollectionSnapshot({
            A: { name: 'A', area: 99 },
            B: { name: 'B', area: 5 },
        })

        const data = sub.getState().data
        expect(data.B?.name).toBe('B') // collaborator doc adopted
        expect(data.A?.area).toBe(99) // collaborator field adopted
        expect(data.A?.name).toBe('Mine') // my pending edit preserved
        sub.stop()
    })

    // ── §9.2 create before first snapshot (SKIP → PR-2) ───────────────────
    // add() before the first snapshot buffers in localState and renders;
    // today it bails (syncState === undefined) and the doc never appears.
    // First-snapshot buffering (spec §5 / P0-b) is out of scope for the 0.1.3
    // baseline-rebase fix.
    it.skip('§9.2 buffers a create issued before the first snapshot', () => {
        const sub = makeColl()
        // No snapshot fired yet — syncState is undefined.
        sub.getHandle().add('x', { name: 'X', area: 1 })

        expect(sub.getState().data.x?.name).toBe('X')
        sub.stop()
    })

    // ── §9.4 no-op collapse (RED → PR-1) ──────────────────────────────────
    // A write whose merged result equals the current view must be a complete
    // no-op: stable handle identity, no notify, isSynced stays true. MUST
    // exercise a NaN field and an explicit-undefined field — the two gaps in
    // isDeepEqual/computeDiff that let the render loop survive a naive guard.
    it('§9.4 document update with an unchanged NaN field is a no-op', () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ v: NaN, name: 'x' })

        const before = sub.getHandle()
        const spy = vi.fn()
        const unsub = sub.subscribe(spy)

        sub.getHandle().update({ v: NaN })

        expect(spy).not.toHaveBeenCalled()
        expect(sub.getHandle()).toBe(before)
        expect(sub.getState().isSynced).toBe(true)
        unsub()
        sub.stop()
    })

    it('§9.4 document set adding only an explicit-undefined key is a no-op', () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ a: 1 })

        const before = sub.getHandle()
        const spy = vi.fn()
        const unsub = sub.subscribe(spy)

        // {a:1, note:undefined} ≡ {a:1} under valuesEqualForNoOp.
        sub.getHandle().set({ a: 1, note: undefined })

        expect(spy).not.toHaveBeenCalled()
        expect(sub.getHandle()).toBe(before)
        expect(sub.getState().isSynced).toBe(true)
        unsub()
        sub.stop()
    })

    it('§9.4 collection update with unchanged values is a no-op', () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ A: { name: 'A', area: 10 } })

        const before = sub.getHandle()
        const spy = vi.fn()
        const unsub = sub.subscribe(spy)

        sub.getHandle().update({ A: { name: 'A', area: 10 } })

        expect(spy).not.toHaveBeenCalled()
        expect(sub.getHandle()).toBe(before)
        expect(sub.getState().isSynced).toBe(true)
        unsub()
        sub.stop()
    })

    // ── §9.7 in-flight re-edit (MUST-STAY-GREEN) ──────────────────────────
    // I send foo=5, re-edit foo=3 while the commit is in flight, then a
    // confirmed snapshot brings foo=5 (my first write). The re-edit must win:
    // foo=3. Today's in-flight rebase already yields this; the rewrite must
    // not regress it.
    it('§9.7 in-flight re-edit wins over the confirmed echo of the first write', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ A: { foo: 1 } })

        sub.getHandle().update({ A: { foo: 5 } })
        const p = sub.sync()
        await h.flushMicrotasks()
        expect(h.pendingCommits()).toHaveLength(1)

        // Re-edit while in flight.
        sub.getHandle().update({ A: { foo: 3 } })

        h.resolveNextCommit()
        await p

        // Confirmed snapshot reflects the FIRST write (foo=5), not the re-edit.
        h.fireCollectionSnapshot({ A: { foo: 5 } })

        expect(sub.getState().data.A?.foo).toBe(3)
        sub.stop()
    })

    // ── §9.8 same-value race, flag-driven (SKIP → PR-2/PR-3) ──────────────
    // An echo (hasPendingWrites:true) reflecting my own in-flight write must
    // NOT be treated as confirmation: the pending state stays unsynced until
    // a hasPendingWrites:false snapshot arrives. Echo gating on per-doc
    // metadata (spec §4 / D2 + D3, needs includeMetadataChanges:true) is out
    // of scope for the 0.1.3 baseline-rebase fix.
    it.skip('§9.8 an echo does not confirm; only hasPendingWrites:false does', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ A: { foo: 1 } }) // confirmed initial

        sub.getHandle().update({ A: { foo: 5 } })
        const p = sub.sync()
        await h.flushMicrotasks()
        h.resolveNextCommit()
        await p

        // Echo: my own un-acked write reflected, hasPendingWrites:true.
        h.fireCollectionSnapshot({ A: { foo: 5 } }, { hasPendingWrites: true })
        expect(sub.getState().isSynced).toBe(false) // not yet confirmed

        // Confirmation: hasPendingWrites:false.
        h.fireCollectionSnapshot({ A: { foo: 5 } }, { hasPendingWrites: false })
        expect(sub.getState().isSynced).toBe(true)
        expect(sub.getState().data.A?.foo).toBe(5)
        sub.stop()
    })

    // Control variant: a genuine collaborator change to a field I also edited
    // (not my echo) → remote wins. SKIP: the 0.1.3 fix keeps same-field
    // concurrent edits last-write-wins (my pending edit is preserved and
    // re-sent), so remote-wins requires the basis-relative conflict detection
    // of spec §4 (future PR).
    it.skip('§9.8 control: collaborator change to my edited field → remote wins', () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ A: { foo: 1 } })

        sub.getHandle().update({ A: { foo: 5 } }) // pending, not in flight

        // Collaborator confirmed foo=9 (different from my 5 → genuine conflict).
        h.fireCollectionSnapshot({ A: { foo: 9 } }, { hasPendingWrites: false })

        expect(sub.getState().data.A?.foo).toBe(9)
        sub.stop()
    })

    // ── G1 document delete/tombstone confirm (MUST-STAY-GREEN) ────────────
    it('G1 delete then missing-doc confirmation clears to no data', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ a: 1 })

        sub.getHandle().delete()
        const p = sub.sync()
        await h.flushMicrotasks()
        expect(h.pendingCommits()).toHaveLength(1)
        h.resolveNextCommit()
        await p

        // Server confirms the doc is gone.
        h.fireDocSnapshot(null)
        expect(sub.getState().data).toBeUndefined()
        expect(sub.getState().isSynced).toBe(true)
        sub.stop()
    })

    // ── G4 per-doc gating, the aggregate trap (MUST-STAY-GREEN / D2) ──────
    // My write to doc A is in flight; a snapshot arrives where A still carries
    // hasPendingWrites:true (my own echo) while a collaborator's confirmed
    // change to doc B carries hasPendingWrites:false. The aggregate flag is
    // therefore true. B's change MUST still be adopted — the gate is per-doc,
    // never the aggregate. A naive `if (aggregate.hasPendingWrites) return`
    // rewrite would drop B (the exact D2/P0-a class); this locks against it.
    it('G4 adopts a collaborator doc under a true aggregate flag (per-doc gate)', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ A: { v: 1 }, B: { v: 1 } })

        sub.getHandle().update({ A: { v: 2 } })
        const p = sub.sync()
        await h.flushMicrotasks()
        h.resolveNextCommit()
        await p

        // Per-doc metadata: A is my un-acked echo (pending), B is a
        // collaborator's confirmed change. Aggregate flag is true.
        h.fireCollectionSnapshotPerDoc({
            A: { data: { v: 2 }, meta: { hasPendingWrites: true } },
            B: { data: { v: 9 }, meta: { hasPendingWrites: false } },
        })

        const data = sub.getState().data
        expect(data.A?.v).toBe(2) // my optimistic value kept
        expect(data.B?.v).toBe(9) // collaborator doc adopted despite agg flag
        sub.stop()
    })
})
