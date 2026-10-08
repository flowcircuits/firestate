/**
 * Structural sharing: an edit or a snapshot keeps the identity of every
 * document and nested object it does not change, so reference-based
 * memoization (`React.memo`, `useMemo`) in consumers holds. Published state is
 * frozen outside production, so code that mutates shared state throws.
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
    occupancy?: number
    processed?: boolean
    edges?: { a: { x: number; y: number } }
}

const spaces = defineCollection<Space>({ path: 'spaces' })

interface Project {
    name?: string
    building?: { floors: number }
    weather?: { station: string }
}

const projectDef = defineDocument<Project>({ collection: 'projects', id: 'p1' })

const serverSpaces = () => ({
    A: { name: 'Janitor', occupancy: 0, edges: { a: { x: 0, y: 0 } } },
    B: { name: 'Kitchen', occupancy: 2, edges: { a: { x: 1, y: 1 } } },
    C: { name: 'Lounge', occupancy: 4, edges: { a: { x: 2, y: 2 } } },
})

describe('structural sharing', () => {
    let store: FirestateStore
    let h: Harness

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        store = createStore({ firestore: {} as never, autosave: 0 })
        h = createHarness()
    })

    const makeColl = () => {
        const sub = createCollectionSubscription({
            store,
            definition: spaces,
            collectionPath: 'spaces',
        })
        sub.load()
        h.fireCollectionSnapshot(serverSpaces())
        return sub
    }

    const makeDoc = () => {
        const sub = createDocumentSubscription({
            store,
            definition: projectDef,
            docId: 'p1',
            collectionPath: 'projects',
        })
        sub.load()
        h.fireDocSnapshot({
            name: 'Student Union',
            building: { floors: 2 },
            weather: { station: 'KSEA' },
        })
        return sub
    }

    describe('collection', () => {
        it('an edit to one document keeps every other document', () => {
            const sub = makeColl()
            const before = sub.getState().data

            sub.getHandle().update({ A: { occupancy: 4 } })

            const after = sub.getState().data
            expect(after.A?.occupancy).toBe(4)
            expect(after.A).not.toBe(before.A)
            expect(after.A?.edges).toBe(before.A?.edges)
            expect(after.B).toBe(before.B)
            expect(after.C).toBe(before.C)
        })

        it('a snapshot that changes one document keeps every other document', () => {
            const sub = makeColl()
            const before = sub.getState().data

            h.fireCollectionSnapshot({
                ...serverSpaces(),
                A: { ...serverSpaces().A, processed: true },
            })

            const after = sub.getState().data
            expect(after.A?.processed).toBe(true)
            expect(after.A).not.toBe(before.A)
            expect(after.A?.edges).toBe(before.A?.edges)
            expect(after.B).toBe(before.B)
            expect(after.C).toBe(before.C)
        })

        it('confirming our own write keeps the edited document', async () => {
            const sub = makeColl()
            sub.getHandle().update({ A: { occupancy: 4 } })
            const edited = sub.getState().data

            void sub.sync()
            await h.flushMicrotasks()
            h.resolveNextCommit()
            await h.flushMicrotasks()
            h.fireCollectionSnapshot({
                ...serverSpaces(),
                A: { ...serverSpaces().A, occupancy: 4 },
            })

            const after = sub.getState()
            expect(after.isSynced).toBe(true)
            expect(after.data.A).toBe(edited.A)
            expect(after.data.B).toBe(edited.B)
        })

        it('a server write-back during a pending edit keeps other documents', () => {
            const sub = makeColl()
            sub.getHandle().update({ A: { occupancy: 4 } })
            const edited = sub.getState().data

            h.fireCollectionSnapshot({
                ...serverSpaces(),
                A: { ...serverSpaces().A, processed: true },
            })

            const after = sub.getState().data
            expect(after.A).toMatchObject({ occupancy: 4, processed: true })
            expect(after.A?.edges).toBe(edited.A?.edges)
            expect(after.B).toBe(edited.B)
            expect(after.C).toBe(edited.C)
        })

        it('add and remove keep every other document', () => {
            const sub = makeColl()
            const before = sub.getState().data

            sub.getHandle().add('D', { name: 'Office' })
            const added = sub.getState().data
            expect(added.D).toMatchObject({ id: 'D', name: 'Office' })
            expect(added.A).toBe(before.A)

            sub.getHandle().remove('B')
            const removed = sub.getState().data
            expect(removed.B).toBeUndefined()
            expect(removed.A).toBe(before.A)
            expect(removed.D).toBe(added.D)
        })

        it('undo restores the value and keeps every other document', () => {
            const undo: Array<() => void> = []
            const sub = createCollectionSubscription({
                store,
                definition: spaces,
                collectionPath: 'spaces',
                onPushUndo: (undoAction) => undo.push(undoAction),
            })
            sub.load()
            h.fireCollectionSnapshot(serverSpaces())
            const before = sub.getState().data

            sub.getHandle().update({ A: { occupancy: 4 } })
            undo.pop()?.()

            const after = sub.getState().data
            expect(after.A?.occupancy).toBe(0)
            expect(after.B).toBe(before.B)
        })

        it('freezes published state', () => {
            const sub = makeColl()
            const space = sub.getState().data.A!
            expect(() => {
                space.occupancy = 9
            }).toThrow(TypeError)
            expect(() => {
                space.edges!.a.x = 9
            }).toThrow(TypeError)
        })
    })

    describe('document', () => {
        it('an edit keeps every untouched nested object', () => {
            const sub = makeDoc()
            const before = sub.getState().data!

            sub.getHandle().update({ building: { floors: 3 } })

            const after = sub.getState().data!
            expect(after.building?.floors).toBe(3)
            expect(after.weather).toBe(before.weather)
        })

        it('a snapshot keeps every unchanged nested object', () => {
            const sub = makeDoc()
            const before = sub.getState().data!

            h.fireDocSnapshot({
                name: 'Renamed',
                building: { floors: 2 },
                weather: { station: 'KSEA' },
            })

            const after = sub.getState().data!
            expect(after.name).toBe('Renamed')
            expect(after.building).toBe(before.building)
            expect(after.weather).toBe(before.weather)
        })

        it('freezes published state', () => {
            const sub = makeDoc()
            const data = sub.getState().data!
            expect(() => {
                data.building!.floors = 9
            }).toThrow(TypeError)
        })
    })
})
