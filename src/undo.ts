import type { Subscriber, Unsubscribe, UndoAction, UndoManager, UndoManagerState } from './types'

/**
 * Configuration for creating an undo manager
 */
export interface UndoManagerConfig {
    /** Maximum number of undo actions to keep, default 20 */
    maxLength?: number
    /** Callback when navigation is requested (for path-aware undo) */
    onNavigate?: (path: string) => void
}

/**
 * Create an undo manager instance.
 * This is a standalone, framework-agnostic implementation.
 *
 * @example
 * ```ts
 * const undoManager = createUndoManager({ maxLength: 10 })
 *
 * undoManager.push({
 *   undo: () => restoreOldValue(),
 *   redo: () => applyNewValue(),
 *   description: 'Update project name',
 * })
 *
 * await undoManager.undo() // Calls restoreOldValue()
 * await undoManager.redo() // Calls applyNewValue()
 * ```
 */
export const createUndoManager = (
    config: UndoManagerConfig = {}
): UndoManager & { subscribe: (fn: Subscriber<UndoManagerState>) => Unsubscribe } => {
    const { maxLength = 20, onNavigate } = config

    let undoStack: UndoAction[] = []
    let redoStack: UndoAction[] = []
    const subscribers = new Set<Subscriber<UndoManagerState>>()

    const getState = (): UndoManagerState => ({
        undoStack,
        redoStack,
        canUndo: undoStack.length > 0,
        canRedo: redoStack.length > 0,
    })

    const notify = () => {
        const state = getState()
        subscribers.forEach((fn) => fn(state))
    }

    const push = (action: UndoAction) => {
        // Check if we should merge with previous action (same groupId)
        if (action.groupId && undoStack.length > 0) {
            const last = undoStack[undoStack.length - 1]
            if (last?.groupId === action.groupId) {
                // Pop and merge
                undoStack.pop()
                undoStack.push({
                    undo: async () => {
                        await last.undo()
                        await action.undo()
                    },
                    redo: async () => {
                        await action.redo()
                        await last.redo()
                    },
                    groupId: action.groupId,
                    path: action.path ?? last.path,
                    description: action.description ?? last.description,
                })
                // Clear redo stack on any new action
                redoStack = []
                notify()
                return
            }
        }

        undoStack.push(action)

        // Enforce max length
        if (undoStack.length > maxLength) {
            undoStack.shift()
        }

        // Clear redo stack on any new action
        redoStack = []
        notify()
    }

    const undo = async () => {
        const action = undoStack.pop()
        if (!action) return

        // Navigate if path is set
        if (action.path && onNavigate) {
            onNavigate(action.path)
        }

        try {
            await action.undo()
            redoStack.push(action)
        } catch (error) {
            // Put it back on undo stack if it failed
            undoStack.push(action)
            console.error('Undo failed:', error)
            throw error
        }

        notify()
    }

    const redo = async () => {
        const action = redoStack.pop()
        if (!action) return

        // Navigate if path is set
        if (action.path && onNavigate) {
            onNavigate(action.path)
        }

        try {
            await action.redo()
            undoStack.push(action)

            // Enforce max length
            if (undoStack.length > maxLength) {
                undoStack.shift()
            }
        } catch (error) {
            // Put it back on redo stack if it failed
            redoStack.push(action)
            console.error('Redo failed:', error)
            throw error
        }

        notify()
    }

    const clear = () => {
        undoStack = []
        redoStack = []
        notify()
    }

    const subscribe = (fn: Subscriber<UndoManagerState>): Unsubscribe => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
    }

    return {
        get undoStack() {
            return undoStack
        },
        get redoStack() {
            return redoStack
        },
        get canUndo() {
            return undoStack.length > 0
        },
        get canRedo() {
            return redoStack.length > 0
        },
        push,
        undo,
        redo,
        clear,
        subscribe,
    }
}

/**
 * Type for the undo manager with subscription capability
 */
export type UndoManagerWithSubscribe = ReturnType<typeof createUndoManager>
