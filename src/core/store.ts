import {
    writeBatch,
    type Firestore,
    type WithFieldValue,
} from 'firebase/firestore'
import type {
    CollectionHandle,
    DeepPartial,
    DocumentHandle,
    ErrorContext,
    FirestateConfig,
    FirestoreObject,
    Subscriber,
    UndoAction,
    Unsubscribe,
} from '../types'
import { createUndoManager, type UndoManagerWithSubscribe } from '../utils/undo'
import {
    getAtomicUpdateAdapter,
    type AtomicUpdateAdapter,
    type AtomicWriteOwner,
    type PreparedAtomicUpdate,
} from './atomic'

export interface AtomicWriter {
    update: {
        <T extends FirestoreObject>(
            handle: Pick<DocumentHandle<T>, 'update'>,
            diff: WithFieldValue<DeepPartial<T>>
        ): void
        <T extends FirestoreObject>(
            handle: Pick<CollectionHandle<T>, 'update'>,
            diff: WithFieldValue<DeepPartial<Record<string, T>>>
        ): void
    }
}

export interface AtomicOptions {
    /** Optional label stored on the single undo action. */
    description?: string
}

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
    setOnError: (
        handler?: (error: Error, context: ErrorContext) => void
    ) => void
    /**
     * Replace the navigation handler at runtime. Used by FirestateProvider to
     * keep the store identity stable when consumers pass an inline `onNavigate`
     * callback that changes reference on every render.
     */
    setOnNavigate: (handler?: (path: string) => void) => void
    /**
     * Resolve the router path to stamp onto a handle-pushed undo action.
     * Delegates to the config's `getUndoPath`; returns `undefined` when none
     * is configured. Called by handle writers as they push undo actions.
     */
    getUndoPath: () => string | undefined
    /**
     * Replace the undo-path resolver at runtime. Used by FirestateProvider to
     * keep the store identity stable when consumers pass an inline
     * `getUndoPath` callback that changes reference on every render.
     */
    setGetUndoPath: (handler?: () => string | undefined) => void
    /** Replace the successful-undo handler without recreating the store. */
    setOnUndo: (handler?: (action: UndoAction) => void) => void
    /** Replace the successful-redo handler without recreating the store. */
    setOnRedo: (handler?: (action: UndoAction) => void) => void
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
    /** Whether any resource has a debounced or in-flight write. */
    readonly hasPendingWrites: boolean
    /** Immediately start and await every pending or in-flight write. */
    flush: () => Promise<void>
    /** Optimistically update multiple resources and persist one atomic batch. */
    atomic: (
        operation: (writer: AtomicWriter) => void,
        options?: AtomicOptions
    ) => Promise<void>
    /** @internal Register or refresh a pending write source. */
    registerPendingWrite: (key: string, flush: () => Promise<void>) => number
    /** @internal Clear a pending source if it has not been refreshed. */
    resolvePendingWrite: (key: string, version: number) => void
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
    let getUndoPath = config.getUndoPath
    let onUndo = config.onUndo
    let onRedo = config.onRedo

    const undoManager = createUndoManager({
        maxLength: maxUndoLength,
        // Stable wrapper — delegates to the mutable onNavigate ref so the
        // undo manager doesn't need to be recreated when the callback changes.
        onNavigate: (path) => onNavigate?.(path),
        // Like onNavigate, these wrappers keep the undo manager and store
        // stable while FirestateProvider replaces inline callback identities.
        onUndo: (action) => onUndo?.(action),
        onRedo: (action) => onRedo?.(action),
        // UndoManager owns action execution; delegate failures through the
        // store's established onError channel rather than adding undo-specific
        // error callbacks to FirestateConfig.
        onError: (error, action, operation) => {
            const context: ErrorContext = {
                type: 'undo',
                path: action.path ?? 'undo',
                operation,
            }
            if (onError) {
                onError(error, context)
            } else {
                console.error(
                    `Firestate error in ${context.type} ${context.path} during ${context.operation}:`,
                    error
                )
            }
        },
    })

    // Track sync state of all documents/collections
    const syncStates = new Map<string, boolean>()
    const syncSubscribers = new Set<Subscriber<boolean>>()
    const pendingWrites = new Map<
        string,
        { version: number; flush: () => Promise<void> }
    >()
    let pendingWriteVersion = 0
    let activeFlush: Promise<void> | null = null
    let atomicOperationCounter = 0

    const computeIsSynced = (): boolean => {
        if (pendingWrites.size > 0) return false
        for (const synced of syncStates.values()) {
            if (!synced) return false
        }
        return true
    }

    // Dedupe on both aggregate values readable through this channel:
    // `isSynced` alone would mask pending-write changes while another
    // resource is unsynced, leaving `hasPendingWrites` snapshots stale
    // (e.g. useFirestateBeforeUnloadWarning).
    let lastNotifiedIsSynced = computeIsSynced()
    let lastNotifiedHasPendingWrites = pendingWrites.size > 0
    const notifySyncSubscribers = () => {
        const isSynced = computeIsSynced()
        const hasPendingWrites = pendingWrites.size > 0
        if (
            isSynced === lastNotifiedIsSynced &&
            hasPendingWrites === lastNotifiedHasPendingWrites
        ) {
            return
        }
        lastNotifiedIsSynced = isSynced
        lastNotifiedHasPendingWrites = hasPendingWrites
        syncSubscribers.forEach((fn) => fn(isSynced))
    }

    const flushPendingWrites = (): Promise<void> => {
        if (activeFlush) return activeFlush

        const run = async () => {
            while (pendingWrites.size > 0) {
                const versionBefore = pendingWriteVersion
                const sources = [...pendingWrites.values()]
                const results = await Promise.allSettled(
                    sources.map((source) => source.flush())
                )
                const failures = results.filter(
                    (result): result is PromiseRejectedResult =>
                        result.status === 'rejected'
                )
                if (failures.length > 0) {
                    throw failures[0]!.reason
                }

                if (
                    pendingWrites.size > 0 &&
                    pendingWriteVersion === versionBefore
                ) {
                    throw new Error(
                        'Firestate flush source completed without resolving its pending write.'
                    )
                }
            }
        }

        activeFlush = run().finally(() => {
            activeFlush = null
        })
        return activeFlush
    }

    const registerPendingWrite = (
        key: string,
        flush: () => Promise<void>
    ): number => {
        const version = ++pendingWriteVersion
        pendingWrites.set(key, { version, flush })
        notifySyncSubscribers()
        return version
    }

    const resolvePendingWrite = (key: string, version: number): void => {
        const pending = pendingWrites.get(key)
        if (!pending || pending.version !== version) return
        pendingWrites.delete(key)
        notifySyncSubscribers()
    }

    interface AtomicRequest {
        adapter: AtomicUpdateAdapter
        diff: unknown
        allowCreate?: boolean
    }

    const runAtomicRequests = (
        requests: AtomicRequest[],
        options: AtomicOptions,
        recordUndo: boolean
    ): Promise<void> => {
        let prepared: Array<{
            adapter: AtomicUpdateAdapter
            update: PreparedAtomicUpdate
        }>
        try {
            const seen = new Set<AtomicUpdateAdapter>()
            prepared = requests.map(({ adapter, diff, allowCreate }) => {
                if (seen.has(adapter)) {
                    throw new Error(
                        `Firestate atomic update rejected: ${adapter.path} was updated more than once in one operation.`
                    )
                }
                seen.add(adapter)
                return {
                    adapter,
                    update: adapter.prepareUpdate(diff, { allowCreate }),
                }
            })
            const writeCount = prepared.reduce(
                (total, item) => total + item.update.writeCount,
                0
            )
            if (writeCount > 500) {
                throw new Error(
                    `Firestate atomic update rejected: ${writeCount} writes exceeds Firestore's 500-write atomic limit.`
                )
            }
            if (writeCount === 0) return Promise.resolve()
        } catch (error) {
            return Promise.reject(error)
        }

        const key = `atomic:${++atomicOperationCounter}`
        const owner: AtomicWriteOwner = { attempt: null }
        let pendingVersion = 0
        let commitPromise: Promise<void> | null = null
        const commit = (): Promise<void> => {
            if (commitPromise) return commitPromise
            try {
                const batch = writeBatch(firestore)
                prepared.forEach(({ update }) => update.addToBatch(batch))
                commitPromise = batch
                    .commit()
                    .then(() => {
                        prepared.forEach(({ update }) => update.committed())
                        resolvePendingWrite(key, pendingVersion)
                    })
                    .catch((error) => {
                        prepared.forEach(({ update }) =>
                            update.failed(error as Error)
                        )
                        throw error
                    })
                    .finally(() => {
                        commitPromise = null
                    })
                owner.attempt = commitPromise
            } catch (error) {
                prepared.forEach(({ update }) => update.failed(error as Error))
                return Promise.reject(error)
            }
            return commitPromise
        }

        pendingVersion = registerPendingWrite(key, commit)
        prepared.forEach(({ update }) => update.apply(owner))
        return commit().then(() => {
            if (!recordUndo) return
            const reverse = prepared.map(({ adapter, update }) => ({
                adapter,
                diff: update.reverseDiff,
                allowCreate: true,
            }))
            const forward = prepared.map(({ adapter, update }) => ({
                adapter,
                diff: update.forwardDiff,
            }))
            undoManager.push({
                undo: () => runAtomicRequests(reverse, {}, false),
                redo: () => runAtomicRequests(forward, {}, false),
                path: getUndoPath?.(),
                description: options.description,
            })
        })
    }

    const atomic = (
        operation: (writer: AtomicWriter) => void,
        options: AtomicOptions = {}
    ): Promise<void> => {
        const requests: AtomicRequest[] = []
        const writer: AtomicWriter = {
            update: ((handle: { update: Function }, diff: unknown) => {
                requests.push({ adapter: getAtomicUpdateAdapter(handle), diff })
            }) as AtomicWriter['update'],
        }
        try {
            operation(writer)
        } catch (error) {
            return Promise.reject(error)
        }
        return runAtomicRequests(requests, options, true)
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

        getUndoPath: () => getUndoPath?.(),

        setGetUndoPath: (handler) => {
            getUndoPath = handler
        },

        setOnUndo: (handler) => {
            onUndo = handler
        },

        setOnRedo: (handler) => {
            onRedo = handler
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

        registerPendingWrite,

        resolvePendingWrite,

        flush: flushPendingWrites,

        atomic,

        get isSynced() {
            return computeIsSynced()
        },

        get hasPendingWrites() {
            return pendingWrites.size > 0
        },
    }
}

/**
 * Type alias for the store type
 */
export type Store = ReturnType<typeof createStore>
