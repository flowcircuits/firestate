import type { Firestore } from 'firebase/firestore'
import type { ErrorContext, FirestateConfig, Subscriber, Unsubscribe } from '../types'
import { createUndoManager, type UndoManagerWithSubscribe } from '../utils/undo'

/**
 * Firestate store that holds configuration and shared state
 */
export interface FirestateStore {
    /** Firestore instance */
    readonly firestore: Firestore
    /** Undo manager instance */
    readonly undoManager: UndoManagerWithSubscribe
    /** Default autosave interval (ms) */
    readonly autosave: number
    /** Default minimum load time (ms) */
    readonly minLoadTime: number
    /** Report an error */
    reportError: (error: Error, context: ErrorContext) => void
    /**
     * Replace the error handler at runtime. Used by FirestateProvider to keep
     * the store identity stable when consumers pass an inline `onError`
     * callback that changes reference on every render.
     */
    setOnError: (handler?: (error: Error, context: ErrorContext) => void) => void
    /**
     * Replace the navigation handler at runtime. Used by FirestateProvider to
     * keep the store identity stable when consumers pass an inline `onNavigate`
     * callback that changes reference on every render.
     */
    setOnNavigate: (handler?: (path: string) => void) => void
    /** Subscribe to sync state changes */
    subscribeToSyncState: (fn: Subscriber<boolean>) => Unsubscribe
    /** Report a document/collection sync state change */
    reportSyncState: (key: string, isSynced: boolean) => void
    /**
     * Remove a sync-state key. Subscriptions call this on stop() so an
     * unmounted hook does not leave the global isSynced stuck at false.
     */
    unregisterSyncState: (key: string) => void
    /** Get whether all tracked resources are synced */
    readonly isSynced: boolean
}

/**
 * Create a Firestate store.
 * This is the central configuration point for your Firestore state management.
 *
 * @example
 * ```ts
 * import { createStore } from 'firestate'
 * import { db } from './firebase'
 *
 * export const store = createStore({
 *   firestore: db,
 *   autosave: 1000,
 *   maxUndoLength: 20,
 *   onError: (error, context) => {
 *     console.error(`Error in ${context.type} ${context.path}:`, error)
 *   },
 * })
 * ```
 */
export const createStore = (config: FirestateConfig): FirestateStore => {
    const {
        firestore,
        autosave = 1000,
        minLoadTime = 0,
        maxUndoLength = 20,
    } = config

    // Mutable so the provider can update them without re-creating the store.
    let onError = config.onError
    let onNavigate = config.onNavigate

    const undoManager = createUndoManager({
        maxLength: maxUndoLength,
        // Stable wrapper — delegates to the mutable onNavigate ref so the
        // undo manager doesn't need to be recreated when the callback changes.
        onNavigate: (path) => onNavigate?.(path),
    })

    // Track sync state of all documents/collections
    const syncStates = new Map<string, boolean>()
    const syncSubscribers = new Set<Subscriber<boolean>>()

    const computeIsSynced = (): boolean => {
        for (const synced of syncStates.values()) {
            if (!synced) return false
        }
        return true
    }

    const notifySyncSubscribers = () => {
        const isSynced = computeIsSynced()
        syncSubscribers.forEach((fn) => fn(isSynced))
    }

    return {
        firestore,
        undoManager,
        autosave,
        minLoadTime,

        reportError: (error, context) => {
            if (onError) {
                onError(error, context)
            } else {
                console.error(
                    `Firestate error in ${context.type} ${context.path} during ${context.operation}:`,
                    error
                )
            }
        },

        setOnError: (handler) => {
            onError = handler
        },

        setOnNavigate: (handler) => {
            onNavigate = handler
        },

        subscribeToSyncState: (fn) => {
            syncSubscribers.add(fn)
            return () => syncSubscribers.delete(fn)
        },

        reportSyncState: (key, isSynced) => {
            const prev = syncStates.get(key)
            if (prev !== isSynced) {
                syncStates.set(key, isSynced)
                notifySyncSubscribers()
            }
        },

        unregisterSyncState: (key) => {
            const prev = syncStates.get(key)
            if (prev === undefined) return
            syncStates.delete(key)
            // Removing a `false` entry can flip global isSynced to true.
            if (prev === false) {
                notifySyncSubscribers()
            }
        },

        get isSynced() {
            return computeIsSynced()
        },
    }
}

/**
 * Type alias for the store type
 */
export type Store = ReturnType<typeof createStore>
