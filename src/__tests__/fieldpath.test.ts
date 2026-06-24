/**
 * Contract: a partial `update()` to a sub-field of a MAP whose key contains a
 * "." (emails — `users["a@b.com"]`) must reach Firestore as a literal path
 * segment, never a dot-joined STRING key.
 *
 * Firestore parses a dotted string key as a nested field path, so
 * `updateDoc(ref, { "users.a@b.com.role": 4 })` would mis-split the email at
 * `.com` and write `users → "a@b" → "com" → role` instead of the literal key.
 * To prevent that, partial updates travel through `flattenDiffToFieldPaths` +
 * `new FieldPath(...segments)` and the variadic `updateDoc(ref, fp, value, …)`
 * form, where each segment is literal.
 *
 * These tests pin the call shape that actually reaches `updateDoc`, asserted
 * with `FieldPath.isEqual` — the public-API guarantee that a path constructed
 * from segments can never mis-split.
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

import { FieldPath, deleteField } from 'firebase/firestore'
import { createHarness, type Harness } from './test-harness'
import { createDocumentSubscription } from '../core/document'
import { createCollectionSubscription } from '../core/collection'
import { defineDocument, defineCollection } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'

interface Member {
    role?: number
}
interface Project {
    users?: Record<string, Member>
    name?: string
}

const projectDef = defineDocument<Project>({ collection: 'projects', id: 'p1' })
const projectsColl = defineCollection<Project>({ path: 'projects' })

describe('dotted map keys (email) survive partial updates', () => {
    let store: FirestateStore
    let h: Harness

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        store = createStore({ firestore: {} as never, autosave: 0 })
        h = createHarness()
    })

    const makeDoc = () => {
        const sub = createDocumentSubscription({
            store,
            definition: projectDef,
            docId: 'p1',
            collectionPath: 'projects',
        })
        sub.load()
        return sub
    }

    const makeColl = () => {
        const sub = createCollectionSubscription({
            store,
            definition: projectsColl,
            collectionPath: 'projects',
        })
        sub.load()
        return sub
    }

    it('updates an email-keyed sub-field via a literal FieldPath, not a dotted string', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ users: { 'a@b.com': { role: 1 } } })

        sub.getHandle().update({ users: { 'a@b.com': { role: 4 } } })
        const p = sub.sync()
        await h.flushMicrotasks()

        const commits = h.pendingCommits()
        expect(commits).toHaveLength(1)
        const { fieldArgs } = commits[0]!
        expect(fieldArgs).toBeDefined()
        // [FieldPath('users','a@b.com','role'), 4] — the email is one segment.
        expect(fieldArgs).toHaveLength(2)
        expect(fieldArgs![0]).toBeInstanceOf(FieldPath)
        expect(
            (fieldArgs![0] as FieldPath).isEqual(
                new FieldPath('users', 'a@b.com', 'role')
            )
        ).toBe(true)
        // A mis-split would have produced ('users','a@b','com','role').
        expect(
            (fieldArgs![0] as FieldPath).isEqual(
                new FieldPath('users', 'a@b', 'com', 'role')
            )
        ).toBe(false)
        expect(fieldArgs![1]).toBe(4)

        h.resolveNextCommit()
        await p
        sub.stop()
    })

    it('adds a brand-new email key under its literal name', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ users: { 'old@x.com': { role: 2 } } })

        sub.getHandle().update({ users: { 'new@x.com': { role: 1 } } })
        const p = sub.sync()
        await h.flushMicrotasks()

        const { fieldArgs } = h.pendingCommits()[0]!
        expect(
            (fieldArgs![0] as FieldPath).isEqual(
                new FieldPath('users', 'new@x.com', 'role')
            )
        ).toBe(true)
        expect(fieldArgs![1]).toBe(1)

        h.resolveNextCommit()
        await p
        sub.stop()
    })

    it('carries a deleteField() sentinel through at an email-keyed path', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({
            users: { 'a@b.com': { role: 1 }, 'c@d.com': { role: 2 } },
        })

        sub.getHandle().update({ users: { 'a@b.com': deleteField() } })
        const p = sub.sync()
        await h.flushMicrotasks()

        const { fieldArgs } = h.pendingCommits()[0]!
        expect(
            (fieldArgs![0] as FieldPath).isEqual(
                new FieldPath('users', 'a@b.com')
            )
        ).toBe(true)
        expect((fieldArgs![1] as { isEqual: (o: unknown) => boolean }).isEqual(
            deleteField()
        )).toBe(true)

        h.resolveNextCommit()
        await p
        sub.stop()
    })

    it('writes a dot-free nested key correctly', async () => {
        const sub = makeDoc()
        h.fireDocConfirmed({ name: 'before' })

        sub.getHandle().update({ name: 'after' })
        const p = sub.sync()
        await h.flushMicrotasks()

        const { fieldArgs } = h.pendingCommits()[0]!
        expect(
            (fieldArgs![0] as FieldPath).isEqual(new FieldPath('name'))
        ).toBe(true)
        expect(fieldArgs![1]).toBe('after')

        h.resolveNextCommit()
        await p
        sub.stop()
    })

    it('collection update of an email-keyed sub-field uses a literal FieldPath in the batch', async () => {
        const sub = makeColl()
        h.fireCollectionSnapshot({ p1: { users: { 'a@b.com': { role: 1 } } } })

        sub.getHandle().update({ p1: { users: { 'a@b.com': { role: 4 } } } })
        const p = sub.sync()
        await h.flushMicrotasks()

        const commits = h.pendingCommits()
        expect(commits).toHaveLength(1)
        const ops = commits[0]!.ops
        expect(ops).toHaveLength(1)
        const op = ops![0]!
        expect(op.type).toBe('update')
        expect(
            (op.fieldArgs![0] as FieldPath).isEqual(
                new FieldPath('users', 'a@b.com', 'role')
            )
        ).toBe(true)
        expect(op.fieldArgs![1]).toBe(4)

        h.resolveNextCommit()
        await p
        sub.stop()
    })
})
