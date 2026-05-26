import { describe, it, expect, vi } from 'vitest'
import { createStore } from './store'

// Mock Firestore instance
const mockFirestore = {} as any

describe('createStore', () => {
    describe('initialization', () => {
        it('creates store with required config', () => {
            const store = createStore({
                firestore: mockFirestore,
            })

            expect(store.firestore).toBe(mockFirestore)
            expect(store.undoManager).toBeDefined()
            expect(store.autosave).toBe(1000) // default
            expect(store.minLoadTime).toBe(0) // default
        })

        it('uses custom autosave interval', () => {
            const store = createStore({
                firestore: mockFirestore,
                autosave: 500,
            })

            expect(store.autosave).toBe(500)
        })

        it('uses custom minLoadTime', () => {
            const store = createStore({
                firestore: mockFirestore,
                minLoadTime: 200,
            })

            expect(store.minLoadTime).toBe(200)
        })

        it('configures undo manager with maxUndoLength', () => {
            const store = createStore({
                firestore: mockFirestore,
                maxUndoLength: 10,
            })

            // Push more than maxUndoLength actions
            for (let i = 0; i < 15; i++) {
                store.undoManager.push({
                    undo: vi.fn(),
                    redo: vi.fn(),
                })
            }

            expect(store.undoManager.undoStack.length).toBe(10)
        })
    })

    describe('error reporting', () => {
        it('calls custom onError handler', () => {
            const onError = vi.fn()
            const store = createStore({
                firestore: mockFirestore,
                onError,
            })

            const error = new Error('Test error')
            const context = {
                type: 'document' as const,
                path: 'projects/123',
                operation: 'read' as const,
            }

            store.reportError(error, context)

            expect(onError).toHaveBeenCalledWith(error, context)
        })

        it('logs to console if no onError handler', () => {
            const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
            const store = createStore({
                firestore: mockFirestore,
            })

            const error = new Error('Test error')
            store.reportError(error, {
                type: 'collection',
                path: 'items',
                operation: 'write',
            })

            expect(consoleSpy).toHaveBeenCalled()
            consoleSpy.mockRestore()
        })
    })

    describe('sync state tracking', () => {
        it('starts with isSynced true', () => {
            const store = createStore({
                firestore: mockFirestore,
            })

            expect(store.isSynced).toBe(true)
        })

        it('reports sync state changes', () => {
            const store = createStore({
                firestore: mockFirestore,
            })

            store.reportSyncState('doc:projects/123', false)

            expect(store.isSynced).toBe(false)
        })

        it('returns true when all resources are synced', () => {
            const store = createStore({
                firestore: mockFirestore,
            })

            store.reportSyncState('doc:a', false)
            store.reportSyncState('doc:b', false)
            expect(store.isSynced).toBe(false)

            store.reportSyncState('doc:a', true)
            expect(store.isSynced).toBe(false)

            store.reportSyncState('doc:b', true)
            expect(store.isSynced).toBe(true)
        })

        it('notifies subscribers of sync state changes', () => {
            const store = createStore({
                firestore: mockFirestore,
            })
            const subscriber = vi.fn()

            store.subscribeToSyncState(subscriber)

            // Initial state is read via store.isSynced, not by an eager
            // synchronous notification on subscribe.
            expect(subscriber).not.toHaveBeenCalled()

            store.reportSyncState('doc:test', false)
            expect(subscriber).toHaveBeenCalledWith(false)

            store.reportSyncState('doc:test', true)
            expect(subscriber).toHaveBeenCalledWith(true)
        })

        it('allows unsubscribing from sync state', () => {
            const store = createStore({
                firestore: mockFirestore,
            })
            const subscriber = vi.fn()

            const unsubscribe = store.subscribeToSyncState(subscriber)

            unsubscribe()
            store.reportSyncState('doc:test', false)

            expect(subscriber).not.toHaveBeenCalled()
        })

        it('tracks multiple instances of the same resource independently', () => {
            // Regression: previously, sync state was keyed only by resource
            // path, so two subscriptions to the same path shared one entry
            // and unmounting one would erase tracking for the other.
            const store = createStore({
                firestore: mockFirestore,
            })

            // Two instances of `doc:users/123`, distinguished by suffix.
            const instanceA = 'doc:users/123#1'
            const instanceB = 'doc:users/123#2'

            store.reportSyncState(instanceA, false)
            store.reportSyncState(instanceB, true)
            expect(store.isSynced).toBe(false)

            // Unmount instance B — A is still unsynced, so global stays false.
            store.unregisterSyncState(instanceB)
            expect(store.isSynced).toBe(false)

            // A finally syncs — global flips to true.
            store.reportSyncState(instanceA, true)
            expect(store.isSynced).toBe(true)
        })

        it('only notifies when sync state actually changes', () => {
            const store = createStore({
                firestore: mockFirestore,
            })
            const subscriber = vi.fn()

            // First set a known state
            store.reportSyncState('doc:test', true)

            store.subscribeToSyncState(subscriber)
            subscriber.mockClear()

            // Same state, should not notify
            store.reportSyncState('doc:test', true)
            expect(subscriber).not.toHaveBeenCalled()

            // Changed state, should notify
            store.reportSyncState('doc:test', false)
            expect(subscriber).toHaveBeenCalledTimes(1)

            // Same state again, should not notify
            store.reportSyncState('doc:test', false)
            expect(subscriber).toHaveBeenCalledTimes(1)
        })
    })

    describe('undo manager integration', () => {
        it('provides access to undo manager', () => {
            const store = createStore({
                firestore: mockFirestore,
            })

            expect(store.undoManager.push).toBeDefined()
            expect(store.undoManager.undo).toBeDefined()
            expect(store.undoManager.redo).toBeDefined()
            expect(store.undoManager.clear).toBeDefined()
            expect(store.undoManager.canUndo).toBe(false)
            expect(store.undoManager.canRedo).toBe(false)
        })

        it('undo manager is functional', async () => {
            const store = createStore({
                firestore: mockFirestore,
            })

            let value = 'old'
            store.undoManager.push({
                undo: () => {
                    value = 'old'
                },
                redo: () => {
                    value = 'new'
                },
            })
            value = 'new'

            expect(value).toBe('new')
            await store.undoManager.undo()
            expect(value).toBe('old')
            await store.undoManager.redo()
            expect(value).toBe('new')
        })
    })
})
