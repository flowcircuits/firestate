import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import type { Firestore } from 'firebase/firestore'
import type { FirestateStore } from '../core/store'
import { FirestateProvider } from './provider'
import { useStore } from './hooks'

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
