import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { where } from 'firebase/firestore'
import { createCollectionSubscription } from './collection'
import { defineCollection } from './schema'
import { createStore } from './store'
import { mockFirestore } from './test-utils/firestore-mock'

vi.mock('firebase/firestore', async () => {
    const m = await import('./test-utils/firestore-mock')
    return m.firestoreMockModule
})

interface Item extends Record<string, unknown> {
    id: string
    name: string
    priority?: 'low' | 'high'
}

const itemsCollection = defineCollection<Item>({
    path: 'items',
})

beforeEach(() => {
    vi.useFakeTimers()
})

afterEach(() => {
    vi.runOnlyPendingTimers()
    vi.useRealTimers()
})

describe('createCollectionSubscription', () => {
    describe('handle caching', () => {
        it('getHandle() returns the same identity until notify() is called', async () => {
            const store = createStore({ firestore: mockFirestore.firestore })
            const sub = createCollectionSubscription({
                store,
                definition: itemsCollection,
            })
            sub.load()
            await vi.advanceTimersByTimeAsync(0)

            const a = sub.getHandle()
            const b = sub.getHandle()
            expect(b).toBe(a)
        })

        it('getHandle() returns a new identity after a snapshot arrives', async () => {
            const store = createStore({ firestore: mockFirestore.firestore })
            const sub = createCollectionSubscription({
                store,
                definition: itemsCollection,
            })
            sub.load()
            await vi.advanceTimersByTimeAsync(0)
            const before = sub.getHandle()

            mockFirestore.setRemote('items/x', { id: 'x', name: 'remote' })

            const after = sub.getHandle()
            expect(after).not.toBe(before)
            expect(after.data['x']).toMatchObject({ name: 'remote' })
        })
    })

    describe('queryConstraints', () => {
        it('concatenates definition-level and caller-provided constraints', () => {
            mockFirestore.seedMany({
                'items/a': { id: 'a', name: 'A', priority: 'low' },
                'items/b': { id: 'b', name: 'B', priority: 'high' },
                'items/c': { id: 'c', name: 'C', priority: 'high' },
            })
            const filteredCollection = defineCollection<Item>({
                path: 'items',
                queryConstraints: [where('priority', '==', 'high')],
            })
            const store = createStore({ firestore: mockFirestore.firestore })
            const sub = createCollectionSubscription({
                store,
                definition: filteredCollection,
                queryConstraints: [where('name', '==', 'B')],
            })
            sub.load()

            // Both constraints applied: priority high AND name B.
            const data = sub.getHandle().data
            expect(Object.keys(data)).toEqual(['b'])
        })
    })

    describe('lazy + load()', () => {
        it('does not start a listener until load() is called', () => {
            const lazy = defineCollection<Item>({ path: 'items', lazy: true })
            const store = createStore({ firestore: mockFirestore.firestore })
            const sub = createCollectionSubscription({ store, definition: lazy })
            expect(mockFirestore.listenerCount()).toBe(0)
            expect(sub.getHandle().isActive).toBe(false)

            sub.load()
            expect(mockFirestore.listenerCount()).toBe(1)
            expect(sub.getHandle().isActive).toBe(true)
        })

        it('is idempotent — calling load() twice does not attach two listeners', () => {
            const store = createStore({ firestore: mockFirestore.firestore })
            const sub = createCollectionSubscription({
                store,
                definition: itemsCollection,
            })
            sub.load()
            sub.load()
            expect(mockFirestore.listenerCount()).toBe(1)
        })
    })

    describe('add() before first snapshot', () => {
        it('returns undefined and does not write', () => {
            const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
            const store = createStore({ firestore: mockFirestore.firestore })
            const sub = createCollectionSubscription({
                store,
                definition: itemsCollection,
            })
            // Don't load() — no first snapshot.
            const id = sub.getHandle().add({ id: 'x', name: 'orphan' })
            expect(id).toBeUndefined()
            expect(warnSpy).toHaveBeenCalled()
            warnSpy.mockRestore()
        })
    })

    describe('writeBatch flow', () => {
        it('commits create + update + delete in a single batch', async () => {
            mockFirestore.seedMany({
                'items/keep': { id: 'keep', name: 'keep' },
                'items/drop': { id: 'drop', name: 'drop' },
            })
            const store = createStore({
                firestore: mockFirestore.firestore,
                autosave: 50,
            })
            const sub = createCollectionSubscription({
                store,
                definition: itemsCollection,
            })
            sub.load()
            await vi.advanceTimersByTimeAsync(0)

            // Compose three different operations in one tick.
            const handle = sub.getHandle()
            handle.add('new', { id: 'new', name: 'fresh' })
            handle.update({ keep: { name: 'renamed' } })
            handle.remove('drop')

            await vi.advanceTimersByTimeAsync(50)

            expect(mockFirestore.getDoc('items/new')).toMatchObject({ name: 'fresh' })
            expect(mockFirestore.getDoc('items/keep')).toMatchObject({ name: 'renamed' })
            expect(mockFirestore.getDoc('items/drop')).toBeUndefined()
        })
    })

    describe('stop() lifecycle', () => {
        it('unregisters the sync key on stop', async () => {
            mockFirestore.seed('items/x', { id: 'x', name: 'existing' })
            const store = createStore({
                firestore: mockFirestore.firestore,
                autosave: 100,
            })
            const sub = createCollectionSubscription({
                store,
                definition: itemsCollection,
            })
            sub.load()
            await vi.advanceTimersByTimeAsync(0)

            sub.getHandle().update({ x: { name: 'changed' } })
            expect(store.isSynced).toBe(false)

            sub.stop()
            expect(mockFirestore.listenerCount()).toBe(0)
            expect(store.isSynced).toBe(true)
        })
    })
})
