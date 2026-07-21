import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { Firestore } from 'firebase/firestore'
import type { FirestateStore } from '../core/store'
import {
    FirestateProvider,
    FirestateStoreProvider,
    useFirestateBeforeUnloadWarning,
} from './provider'
import { useStore } from './hooks'
import { createStore } from '../core/store'

const firestore = {} as Firestore

describe('FirestateProvider undo callbacks', () => {
    it('replaces onUndo and onRedo without recreating the store', async () => {
        let currentStore: FirestateStore | undefined
        const Probe = () => {
            currentStore = useStore()
            return null
        }
        const firstUndo = vi.fn()
        const secondUndo = vi.fn()
        const firstRedo = vi.fn()
        const secondRedo = vi.fn()
        let renderer: ReactTestRenderer

        await act(async () => {
            renderer = create(
                createElement(FirestateProvider, {
                    firestore,
                    onUndo: firstUndo,
                    onRedo: firstRedo,
                    children: createElement(Probe),
                })
            )
        })

        const initialStore = currentStore

        await act(async () => {
            renderer!.update(
                createElement(FirestateProvider, {
                    firestore,
                    onUndo: secondUndo,
                    onRedo: secondRedo,
                    children: createElement(Probe),
                })
            )
        })

        expect(currentStore).toBe(initialStore)

        currentStore!.undoManager.push({ undo: vi.fn(), redo: vi.fn() })
        await currentStore!.undoManager.undo()
        await currentStore!.undoManager.redo()

        expect(firstUndo).not.toHaveBeenCalled()
        expect(firstRedo).not.toHaveBeenCalled()
        expect(secondUndo).toHaveBeenCalledTimes(1)
        expect(secondRedo).toHaveBeenCalledTimes(1)

        renderer!.unmount()
    })
})

describe('useFirestateBeforeUnloadWarning', () => {
    it('registers only while a write is pending or in flight', async () => {
        const addEventListener = vi.fn()
        const removeEventListener = vi.fn()
        vi.stubGlobal('window', { addEventListener, removeEventListener })
        const store = createStore({ firestore })
        const Probe = () => {
            useFirestateBeforeUnloadWarning()
            return null
        }
        let renderer: ReactTestRenderer

        await act(async () => {
            renderer = create(
                createElement(FirestateStoreProvider, {
                    store,
                    children: createElement(Probe),
                })
            )
        })
        expect(addEventListener).not.toHaveBeenCalled()

        let version = 0
        await act(async () => {
            version = store.registerPendingWrite('doc:a', async () => {})
        })
        expect(addEventListener).toHaveBeenCalledWith(
            'beforeunload',
            expect.any(Function)
        )

        await act(async () => {
            store.resolvePendingWrite('doc:a', version)
        })
        expect(removeEventListener).toHaveBeenCalledWith(
            'beforeunload',
            addEventListener.mock.calls[0]![1]
        )

        renderer!.unmount()
        vi.unstubAllGlobals()
    })

    it('tracks pending writes while another resource is already unsynced', async () => {
        // A resource reporting unsynced keeps aggregate isSynced false, which
        // used to mask pending-write notifications and leave the warning
        // listener out of sync with hasPendingWrites.
        const addEventListener = vi.fn()
        const removeEventListener = vi.fn()
        vi.stubGlobal('window', { addEventListener, removeEventListener })
        const store = createStore({ firestore })
        store.reportSyncState('doc:other', false)
        const Probe = () => {
            useFirestateBeforeUnloadWarning()
            return null
        }
        let renderer: ReactTestRenderer

        await act(async () => {
            renderer = create(
                createElement(FirestateStoreProvider, {
                    store,
                    children: createElement(Probe),
                })
            )
        })
        expect(addEventListener).not.toHaveBeenCalled()

        let version = 0
        await act(async () => {
            version = store.registerPendingWrite('doc:a', async () => {})
        })
        expect(addEventListener).toHaveBeenCalledWith(
            'beforeunload',
            expect.any(Function)
        )

        await act(async () => {
            store.resolvePendingWrite('doc:a', version)
        })
        expect(removeEventListener).toHaveBeenCalledWith(
            'beforeunload',
            addEventListener.mock.calls[0]![1]
        )

        renderer!.unmount()
        vi.unstubAllGlobals()
    })
})
