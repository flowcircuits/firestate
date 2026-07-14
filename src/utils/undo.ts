import type {
    Subscriber,
    Unsubscribe,
    UndoAction,
    UndoManager,
    UndoManagerState,
} from '../types'

/**
 * Configuration for creating an undo manager
 */
export interface UndoManagerConfig {
    /** Maximum number of undo actions to keep, default 20 */
    maxLength?: number
    /** Callback when navigation is requested (for path-aware undo) */
    onNavigate?: (path: string) => void
    /** Callback after an undo action has been successfully applied */
    onUndo?: (action: UndoAction) => void
    /** Callback after a redo action has been successfully applied */
    onRedo?: (action: UndoAction) => void
    /** Callback when an undo or redo action fails */
    onError?: (
        error: Error,
        action: UndoAction,
        operation: 'undo' | 'redo'
    ) => void
}

/** A merged group keeps its original actions so it can execute atomically. */
interface GroupedUndoAction extends UndoAction {
    actions?: readonly UndoAction[]
}

const getGroupedActions = (action: GroupedUndoAction): readonly UndoAction[] =>
    action.actions ?? [action]

/**
 * Apply a group in the required direction. If a member fails, compensate the
 * members already applied so a failed undo/redo does not leave the group
 * partially applied (provided the compensating actions themselves succeed).
 */
const applyGroup = async (
    actions: readonly UndoAction[],
    operation: 'undo' | 'redo'
): Promise<void> => {
    const ordered = operation === 'undo' ? [...actions].reverse() : actions
    const applied: UndoAction[] = []

    try {
        for (const action of ordered) {
            await action[operation]()
            applied.push(action)
        }
    } catch (error) {
        const compensate = operation === 'undo' ? 'redo' : 'undo'
        for (const action of applied.reverse()) {
            await action[compensate]()
        }
        throw error
    }
}

const mergeGroupedActions = (
    older: GroupedUndoAction,
    newer: UndoAction
): GroupedUndoAction => {
    const actions = [...getGroupedActions(older), newer]

    return {
        undo: () => applyGroup(actions, 'undo'),
        redo: () => applyGroup(actions, 'redo'),
        groupId: newer.groupId,
        path: newer.path ?? older.path,
        description: newer.description ?? older.description,
        actions,
    }
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
): UndoManager & {
    subscribe: (fn: Subscriber<UndoManagerState>) => Unsubscribe
    getState: () => UndoManagerState
} => {
    const { maxLength = 20, onNavigate, onUndo, onRedo, onError } = config

    let undoStack: UndoAction[] = []
    let redoStack: UndoAction[] = []
    const subscribers = new Set<Subscriber<UndoManagerState>>()
    // Cached snapshot — returns the same reference until notify() invalidates
    // it. Required so React's useSyncExternalStore consumers (useUndoManager)
    // see a stable snapshot across the multiple getSnapshot() calls React
    // makes per commit; otherwise the inequality on Object.is triggers an
    // infinite re-render and the "getSnapshot should be cached" warning.
    let cachedState: UndoManagerState | null = null

    const getState = (): UndoManagerState => {
        if (cachedState === null) {
            cachedState = {
                undoStack,
                redoStack,
                canUndo: undoStack.length > 0,
                canRedo: redoStack.length > 0,
            }
        }
        return cachedState
    }

    const notify = () => {
        cachedState = null
        const state = getState()
        subscribers.forEach((fn) => fn(state))
    }

    const push = (action: UndoAction) => {
        // Check if we should merge with previous action (same groupId)
        if (action.groupId && undoStack.length > 0) {
            const last = undoStack[undoStack.length - 1] as
                | GroupedUndoAction
                | undefined
            if (last?.groupId === action.groupId) {
                // Keep the individual group members so the group can apply
                // newest→oldest on undo and oldest→newest on redo.
                undoStack.pop()
                undoStack.push(mergeGroupedActions(last, action))
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

        try {
            // Navigate if path is set.
            if (action.path && onNavigate) {
                onNavigate(action.path)
            }
            await action.undo()
        } catch (error) {
            // Put it back on undo stack if it failed
            undoStack.push(action)
            if (onError) {
                onError(error as Error, action, 'undo')
            } else {
                console.error('Undo failed:', error)
            }
            throw error
        }

        redoStack.push(action)
        notify()
        onUndo?.(action)
    }

    const redo = async () => {
        const action = redoStack.pop()
        if (!action) return

        try {
            // Navigate if path is set.
            if (action.path && onNavigate) {
                onNavigate(action.path)
            }
            await action.redo()
        } catch (error) {
            // Put it back on redo stack if it failed
            redoStack.push(action)
            if (onError) {
                onError(error as Error, action, 'redo')
            } else {
                console.error('Redo failed:', error)
            }
            throw error
        }

        undoStack.push(action)

        // Enforce max length
        if (undoStack.length > maxLength) {
            undoStack.shift()
        }

        notify()
        onRedo?.(action)
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
        getState,
    }
}

/**
 * Type for the undo manager with subscription capability
 */
export type UndoManagerWithSubscribe = ReturnType<typeof createUndoManager>
