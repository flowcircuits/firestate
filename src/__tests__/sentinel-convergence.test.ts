/**
 * Convergence contract for FieldValue sentinel writes (serverTimestamp,
 * increment, arrayUnion/arrayRemove).
 *
 * A sentinel is a fire-once write intent: the client ships the sentinel, the
 * server resolves it to a concrete value, and the confirming snapshot carries
 * that resolved value. The contract this file pins:
 *
 *   - Once the server confirms a sentinel write, the subscription returns to
 *     synced (localState cleared, isSynced true) — exactly like a plain-value
 *     write. The sentinel is consumed, not held.
 *   - A confirmed sentinel write produces no further writes. A subsequent
 *     sync() is a no-op. (Under autosave > 0 a held sentinel would otherwise be
 *     re-sent on every tick.)
 *   - A non-idempotent sentinel (increment) is applied to the server exactly
 *     once across the full write → confirm → settle cycle.
 *
 * The realistic-cycle tests drive the round-trip a live autosave would drive —
 * sync, server applies + acks, confirming snapshot — but bounded, so a failure
 * to converge surfaces as a climbing server value and a hit iteration cap
 * rather than a hung runner.
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

import {
    serverTimestamp,
    increment,
    arrayUnion,
    Timestamp,
} from 'firebase/firestore'
import { createHarness, type Harness } from './test-harness'
import { createDocumentSubscription } from '../core/document'
import { createCollectionSubscription } from '../core/collection'
import { defineDocument, defineCollection } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'

interface Counter {
    id?: string
    count?: number
    title?: string
    tags?: string[]
    updatedAt?: unknown
}

const counterDoc = defineDocument<Counter>({ collection: 'counters', id: 'c1' })
const countersColl = defineCollection<Counter>({ path: 'counters' })

describe('FieldValue sentinel convergence', () => {
    let store: FirestateStore
    let h: Harness

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        // autosave: 0 → writes are driven explicitly by sub.sync(), so the
        // round-trip is deterministic and a non-converging write can't spin a
        // real timer.
        store = createStore({ firestore: {} as never, autosave: 0 })
        h = createHarness()
    })

    const makeDoc = () => {
        const sub = createDocumentSubscription({
            store,
            definition: counterDoc,
            docId: 'c1',
            collectionPath: 'counters',
        })
        sub.load()
        return sub
    }

    const makeColl = () => {
        const sub = createCollectionSubscription({
            store,
            definition: countersColl,
            collectionPath: 'counters',
        })
        sub.load()
        return sub
    }

    // One write → ack → confirm round-trip helper.
    const settleWrite = async (sync: () => Promise<void>) => {
        const p = sync()
        await h.flushMicrotasks()
        if (h.pendingCommits().length > 0) {
            h.resolveNextCommit()
        }
        await p
    }

    // ── document: serverTimestamp ─────────────────────────────────────────
    it('a document serverTimestamp write returns to synced once the server confirms the resolved value', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ title: 'x', updatedAt: Timestamp.fromMillis(1000) })

        sub.getHandle().update({ updatedAt: serverTimestamp() })
        expect(sub.getState().isSynced).toBe(false)

        await settleWrite(sub.sync)

        // Server resolved the sentinel and broadcasts the concrete Timestamp.
        h.fireDocConfirmed({ title: 'x', updatedAt: Timestamp.fromMillis(2000) })

        expect(sub.getState().isSynced).toBe(true)
        expect(sub.getState().data?.updatedAt).toEqual(Timestamp.fromMillis(2000))
        sub.stop()
    })

    it('a confirmed document serverTimestamp write produces no further writes', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ title: 'x', updatedAt: Timestamp.fromMillis(1000) })

        sub.getHandle().update({ updatedAt: serverTimestamp() })
        await settleWrite(sub.sync)
        h.fireDocConfirmed({ title: 'x', updatedAt: Timestamp.fromMillis(2000) })

        const commitsBefore = h.commitCount()
        // Not awaited: a held sentinel queues another updateDoc whose commit
        // would never resolve here, so awaiting would hang. We only need to
        // observe whether a write was issued.
        void sub.sync()
        await h.flushMicrotasks()
        expect(h.commitCount()).toBe(commitsBefore)
        sub.stop()
    })

    // ── document: increment (non-idempotent — the corruption case) ────────
    it('a document increment is applied to the server exactly once', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ count: 5 })

        sub.getHandle().update({ count: increment(1) })

        // Drive the round-trip the way a live autosave would, but bounded.
        // Each sync that issues a write is one server-side increment.
        let serverCount = 5
        let rounds = 0
        while (!sub.getState().isSynced && rounds < 5) {
            rounds++
            const p = sub.sync()
            await h.flushMicrotasks()
            if (h.pendingCommits().length === 0) {
                await p
                break
            }
            // Server applies the increment, acks, then broadcasts the result.
            serverCount += 1
            h.resolveNextCommit()
            await p
            h.fireDocConfirmed({ count: serverCount })
        }

        expect(rounds).toBe(1)
        expect(serverCount).toBe(6) // incremented once, not once per loop
        expect(sub.getState().isSynced).toBe(true)
        expect(sub.getState().data?.count).toBe(6)
        sub.stop()
    })

    // ── document: arrayUnion (idempotent, but must still settle) ──────────
    it('a document arrayUnion write returns to synced once the server confirms', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ tags: ['a'] })

        sub.getHandle().update({ tags: arrayUnion('b') as unknown as string[] })
        await settleWrite(sub.sync)

        h.fireDocConfirmed({ tags: ['a', 'b'] })

        expect(sub.getState().isSynced).toBe(true)
        expect(sub.getState().data?.tags).toEqual(['a', 'b'])
        sub.stop()
    })

    // ── document: echo interleaves the in-flight write ────────────────────
    // Real Firestore fires a local-cache echo (hasPendingWrites: true) almost
    // immediately after a write — BEFORE the server acks the commit. The
    // resolve-first tests above never exercise that ordering. These pin that
    // the committed-sentinel record survives an echo landing mid-flight, so the
    // write still converges and a non-idempotent sentinel still applies once.
    it('a document increment is applied exactly once even when a local echo snapshot interleaves the in-flight write', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ count: 5 })

        sub.getHandle().update({ count: increment(1) })

        let serverCount = 5
        let rounds = 0
        let echoFired = false
        while (!sub.getState().isSynced && rounds < 5) {
            rounds++
            const p = sub.sync()
            await h.flushMicrotasks()
            if (h.pendingCommits().length === 0) {
                await p
                break
            }
            // Server applies the increment...
            serverCount += 1
            // ...and Firestore fires the optimistic local-cache echo BEFORE the
            // commit resolves. This must not erase the committed-sentinel record.
            if (!echoFired) {
                echoFired = true
                h.fireDocEcho({ count: serverCount })
            }
            h.resolveNextCommit()
            await p
            h.fireDocConfirmed({ count: serverCount })
        }

        expect(rounds).toBe(1)
        expect(serverCount).toBe(6) // incremented once, not once per loop
        expect(sub.getState().isSynced).toBe(true)
        expect(sub.getState().data?.count).toBe(6)
        sub.stop()
    })

    it('a document serverTimestamp write converges when a local echo snapshot interleaves the in-flight write', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ title: 'x', updatedAt: Timestamp.fromMillis(1000) })

        sub.getHandle().update({ updatedAt: serverTimestamp() })

        const p = sub.sync()
        await h.flushMicrotasks()
        // Local-cache echo (hasPendingWrites: true) arrives before the commit
        // resolves — the real-world ordering the resolve-first tests miss.
        h.fireDocEcho({ title: 'x', updatedAt: Timestamp.fromMillis(1500) })
        h.resolveNextCommit()
        await p

        // Server resolves the sentinel and broadcasts the concrete Timestamp.
        h.fireDocConfirmed({ title: 'x', updatedAt: Timestamp.fromMillis(2000) })

        expect(sub.getState().isSynced).toBe(true)
        expect(sub.getState().data?.updatedAt).toEqual(
            Timestamp.fromMillis(2000)
        )

        // A held sentinel would queue another updateDoc on the next tick.
        const commitsBefore = h.commitCount()
        void sub.sync()
        await h.flushMicrotasks()
        expect(h.commitCount()).toBe(commitsBefore)
        sub.stop()
    })

    // ── collection: increment ─────────────────────────────────────────────
    it('a collection increment is applied to the server exactly once', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ A: { count: 5 } })

        sub.getHandle().update({ A: { count: increment(1) } })

        let serverCount = 5
        let rounds = 0
        while (!sub.getState().isSynced && rounds < 5) {
            rounds++
            const p = sub.sync()
            await h.flushMicrotasks()
            if (h.pendingCommits().length === 0) {
                await p
                break
            }
            serverCount += 1
            h.resolveNextCommit()
            await p
            h.fireCollectionSnapshot({ A: { count: serverCount } })
        }

        expect(rounds).toBe(1)
        expect(serverCount).toBe(6)
        expect(sub.getState().isSynced).toBe(true)
        expect(sub.getState().data.A?.count).toBe(6)
        sub.stop()
    })

    it('a confirmed collection serverTimestamp write produces no further writes', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({
            A: { updatedAt: Timestamp.fromMillis(1000) },
        })

        sub.getHandle().update({ A: { updatedAt: serverTimestamp() } })
        await settleWrite(sub.sync)
        h.fireCollectionSnapshot({ A: { updatedAt: Timestamp.fromMillis(2000) } })

        const commitsBefore = h.commitCount()
        void sub.sync()
        await h.flushMicrotasks()
        expect(h.commitCount()).toBe(commitsBefore)
        sub.stop()
    })
})
