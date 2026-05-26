import {
    collection,
    doc,
    onSnapshot,
    query,
    writeBatch,
    deleteField,
    WithFieldValue,
    QueryConstraint,
    type CollectionReference,
} from 'firebase/firestore'
import type {
    CollectionDefinition,
    CollectionHandle,
    CollectionState,
    DeepPartial,
    FirestoreObject,
    Subscriber,
    Unsubscribe,
    UpdateOptions,
} from './types'
import type { FirestateStore } from './store'
import { applyDiffMutable, computeDiff, deepClone, flattenDiff, isDeepEqual } from './diff'

// Module-level counter so each subscription instance gets a unique sync key,
// even when multiple instances target the same collection path.
let syncKeyCounter = 0

/**
 * Options for creating a collection subscription
 */
export interface CollectionOptions<TData extends FirestoreObject> {
    /** The store instance */
    store: FirestateStore
    /** Collection definition from defineCollection() */
    definition: CollectionDefinition<TData>
    /**
     * Resolved collection path. If omitted and `definition.path` is a string,
     * that value is used. If `definition.path` is a function, this option is
     * required.
     */
    collectionPath?: string
    /** Override read-only setting */
    readOnly?: boolean
    /** Additional query constraints */
    queryConstraints?: QueryConstraint[]
    /** Callback for pushing undo actions */
    onPushUndo?: (
        undoAction: () => void,
        redoAction: () => void,
        options?: UpdateOptions
    ) => void
}

/**
 * Internal state for a collection subscription
 */
interface CollectionInternalState<T extends FirestoreObject> {
    syncState: Record<string, T> | undefined
    localState: Record<string, T> | undefined
    isLoading: boolean
    isActive: boolean
    error: Error | undefined
    waitingForUpdate: boolean
    inflightLocalState: Record<string, T> | undefined
    pendingUndoOptions: UpdateOptions | undefined
}

/**
 * Create a collection subscription.
 * This is a low-level API - prefer using useCollection hook in React.
 *
 * @example
 * ```ts
 * const subscription = createCollectionSubscription({
 *   store,
 *   definition: spacesCollection,
 *   collectionPath: 'projects/123/spaces',
 * })
 *
 * const unsubscribe = subscription.subscribe((state) => {
 *   console.log('Collection state:', state)
 * })
 *
 * subscription.load() // For lazy collections
 * ```
 */
export const createCollectionSubscription = <TData extends FirestoreObject>(
    options: CollectionOptions<TData>
): {
    /** Activate the subscription (for lazy loading) */
    load: () => void
    /** Stop the Firestore listener */
    stop: () => void
    /** Subscribe to state changes */
    subscribe: (fn: Subscriber<CollectionState<TData>>) => Unsubscribe
    /** Get current state */
    getState: () => CollectionState<TData>
    /** Get collection handle for updates */
    getHandle: () => CollectionHandle<TData>
    /** Force sync now */
    sync: () => Promise<void>
} => {
    const { store, definition, collectionPath: resolvedPath, readOnly, queryConstraints: extraConstraints, onPushUndo } = options
    const { firestore, autosave: defaultAutosave, minLoadTime: defaultMinLoadTime } = store

    const {
        path,
        autosave = defaultAutosave,
        minLoadTime = defaultMinLoadTime,
        readOnly: definitionReadOnly,
        lazy = false,
        queryConstraints: definitionConstraints,
        retryOnError = false,
        retryInterval = 5000,
    } = definition

    const isReadOnly = readOnly ?? definitionReadOnly ?? false
    // Prefer the caller-resolved path. Fall back to a string `definition.path`
    // for ergonomic direct use; if both are missing, the caller forgot to
    // resolve a function path.
    const collectionPath = resolvedPath ?? (typeof path === 'string' ? path : undefined)
    if (collectionPath === undefined) {
        throw new Error(
            `createCollectionSubscription: definition.path is a function; pass a resolved collectionPath in options.`
        )
    }
    const allConstraints = [...(definitionConstraints ?? []), ...(extraConstraints ?? [])]

    // Create collection reference
    const collectionRef = collection(firestore, collectionPath) as CollectionReference<TData>

    // Internal state
    const state: CollectionInternalState<TData> = {
        syncState: undefined,
        localState: undefined,
        isLoading: !lazy,
        isActive: !lazy,
        error: undefined,
        waitingForUpdate: false,
        inflightLocalState: undefined,
        pendingUndoOptions: undefined,
    }

    const subscribers = new Set<Subscriber<CollectionState<TData>>>()
    let unsubscribeListener: Unsubscribe | null = null
    let autosaveTimeout: ReturnType<typeof setTimeout> | null = null
    let minLoadTimeout: ReturnType<typeof setTimeout> | null = null
    let retryTimeout: ReturnType<typeof setTimeout> | null = null
    let minLoadTimeElapsed = false
    let loaded = false
    // Cached handle — returns the same reference until notify() invalidates
    // it. Lets useSyncExternalStore consumers rely on handle identity.
    let cachedHandle: CollectionHandle<TData> | null = null

    // Unique key for sync tracking, scoped per-instance so multiple
    // subscriptions to the same path don't share (or clobber) one entry.
    const syncKey = `col:${collectionPath}#${++syncKeyCounter}`

    const getMergedData = (): Record<string, TData> =>
        state.localState ?? state.syncState ?? {}

    const getPublicState = (): CollectionState<TData> => ({
        data: getMergedData(),
        isLoading: state.isLoading,
        isSynced: state.localState === undefined,
        isActive: state.isActive,
        error: state.error,
    })

    const notify = () => {
        cachedHandle = null
        const publicState = getPublicState()
        subscribers.forEach((fn) => fn(publicState))
        store.reportSyncState(syncKey, publicState.isSynced)
    }

    // Pre-snapshot mutations are unsafe because computing a partial-update
    // local state without knowing the existing server fields would cause the
    // subsequent diff to mark unrelated fields as deleted. Document mutations
    // bail the same way when there's no current data.
    const warnNoSnapshot = (method: string) => {
        if (process.env.NODE_ENV !== 'production') {
            console.warn(
                `[firestate] ${method}() on ${collectionPath} was ignored: the first snapshot has not arrived yet. ` +
                    `Gate calls on the collection's isLoading/isActive state, or await the first data before mutating.`
            )
        }
    }

    const updateState = (
        diff: WithFieldValue<DeepPartial<Record<string, TData>>>,
        undoOptions: UpdateOptions = {}
    ) => {
        if (isReadOnly) return
        if (state.syncState === undefined) {
            warnNoSnapshot('update')
            return
        }

        const currentData = getMergedData()
        const newLocalState = deepClone(currentData)
        applyDiffMutable(newLocalState, diff as Record<string, unknown>)

        // Ensure each document has its id
        for (const [docId, docData] of Object.entries(newLocalState)) {
            if (docData && typeof docData === 'object') {
                ;(docData as Record<string, unknown>).id = docId
            }
        }

        state.localState = newLocalState
        state.pendingUndoOptions = undoOptions

        notify()
        scheduleAutosave()
    }

    // Overloaded: callers can pass (id, data, opts) or (data, opts). The
    // no-id form generates a Firestore auto-id via doc(collectionRef).id and
    // returns it so the caller can reference the new doc immediately.
    function addDocument(
        id: string,
        data: Omit<TData, 'id'>,
        undoOptions?: UpdateOptions
    ): string
    function addDocument(
        data: Omit<TData, 'id'>,
        undoOptions?: UpdateOptions
    ): string
    function addDocument(
        idOrData: string | Omit<TData, 'id'>,
        dataOrOptions?: Omit<TData, 'id'> | UpdateOptions,
        maybeUndoOptions?: UpdateOptions
    ): string {
        const hasExplicitId = typeof idOrData === 'string'
        const id = hasExplicitId ? idOrData : doc(collectionRef).id
        const data = (hasExplicitId ? dataOrOptions : idOrData) as Omit<TData, 'id'>
        const undoOptions = (hasExplicitId
            ? maybeUndoOptions
            : (dataOrOptions as UpdateOptions | undefined)) ?? {}

        if (isReadOnly) return id
        if (state.syncState === undefined) {
            // Even add() bails — an explicit id that happens to exist on the
            // server would round-trip through computeDiff and clobber any
            // remote-only fields. The id we returned is still a valid Firestore
            // id but the caller's data was not queued.
            warnNoSnapshot('add')
            return id
        }

        const currentData = getMergedData()
        const newLocalState = deepClone(currentData)
        newLocalState[id] = { ...data, id } as unknown as TData

        state.localState = newLocalState
        state.pendingUndoOptions = undoOptions

        notify()
        scheduleAutosave()

        return id
    }

    const removeDocument = (id: string, undoOptions: UpdateOptions = {}) => {
        if (isReadOnly) return
        if (state.syncState === undefined) {
            warnNoSnapshot('remove')
            return
        }

        const currentData = getMergedData()
        if (!(id in currentData)) return

        const newLocalState = deepClone(currentData)
        delete newLocalState[id]

        state.localState = newLocalState
        state.pendingUndoOptions = undoOptions

        notify()
        scheduleAutosave()
    }

    const scheduleAutosave = () => {
        if (autosaveTimeout) {
            clearTimeout(autosaveTimeout)
        }
        if (autosave > 0) {
            autosaveTimeout = setTimeout(() => {
                sync()
            }, autosave)
        }
    }

    const sync = async () => {
        if (!state.localState) return
        // syncState is guaranteed defined here: every mutation that can set
        // localState bails when syncState is undefined. This guard is purely
        // defensive against a direct sync() call after stop().
        if (state.syncState === undefined) return

        const syncState = state.syncState

        if (isDeepEqual(state.localState, syncState)) {
            state.localState = undefined
            state.inflightLocalState = undefined
            notify()
            return
        }

        const diff = computeDiff(
            syncState as FirestoreObject,
            state.localState as FirestoreObject
        )
        state.inflightLocalState = deepClone(state.localState)
        const currentUndoOptions = state.pendingUndoOptions
        state.pendingUndoOptions = undefined

        // Push undo action if enabled
        if (currentUndoOptions?.undoable !== false && onPushUndo) {
            const undoDiff = computeDiff(
                state.localState as FirestoreObject,
                syncState as FirestoreObject
            )
            const redoDiff = diff
            onPushUndo(
                () => updateState(undoDiff as WithFieldValue<DeepPartial<Record<string, TData>>>, { undoable: false }),
                () => updateState(redoDiff as WithFieldValue<DeepPartial<Record<string, TData>>>, { undoable: false }),
                currentUndoOptions
            )
        }

        state.waitingForUpdate = true

        try {
            const batch = writeBatch(firestore)
            const deleteFieldSentinel = deleteField()

            for (const [docId, docDiff] of Object.entries(diff)) {
                const docRef = doc(collectionRef, docId)

                // Check if this is a delete operation
                if (
                    docDiff !== null &&
                    typeof docDiff === 'object' &&
                    'isEqual' in docDiff &&
                    typeof docDiff.isEqual === 'function' &&
                    (docDiff as { isEqual: (v: unknown) => boolean }).isEqual(deleteFieldSentinel)
                ) {
                    batch.delete(docRef)
                } else if (!(docId in syncState)) {
                    // New document - use set to create it
                    batch.set(docRef, docDiff as Record<string, unknown>)
                } else {
                    // Existing document - use update with flattened diff to prevent
                    // accidentally recreating deleted documents
                    const flatDiff = flattenDiff(docDiff as Record<string, unknown>)
                    batch.update(docRef, flatDiff)
                }
            }

            await batch.commit()
        } catch (error) {
            console.error('Collection sync failed:', error)
            state.waitingForUpdate = false
            state.inflightLocalState = undefined
            // Surface to React: handle.error reflects the failure and the
            // listener will keep state.localState so consumers can retry by
            // calling sync(). Autosave is not automatically rescheduled to
            // avoid retry loops on permission errors.
            state.error = error as Error
            store.reportError(error as Error, {
                type: 'collection',
                path: collectionPath,
                operation: 'write',
            })
            notify()
        }
    }

    const handleSnapshot = (docs: Array<{ id: string; data: TData }>) => {
        const newSyncState: Record<string, TData> = {}
        for (const { id, data } of docs) {
            newSyncState[id] = { ...data, id } as TData
        }

        state.syncState = newSyncState
        // A successful snapshot supersedes any previous read or write error.
        state.error = undefined

        if (state.waitingForUpdate) {
            state.waitingForUpdate = false
            const inflightState = state.inflightLocalState
            state.inflightLocalState = undefined
            const currentLocal = state.localState

            // Rebase local changes if they changed since we started the sync
            if (
                inflightState &&
                currentLocal &&
                !isDeepEqual(currentLocal, inflightState)
            ) {
                const changesSinceInflight = computeDiff(
                    inflightState as FirestoreObject,
                    currentLocal as FirestoreObject
                )
                const rebasedLocalState = deepClone(newSyncState)
                applyDiffMutable(rebasedLocalState, changesSinceInflight as Record<string, unknown>)
                // Re-add ids
                for (const [docId, docData] of Object.entries(rebasedLocalState)) {
                    if (docData && typeof docData === 'object') {
                        ;(docData as Record<string, unknown>).id = docId
                    }
                }
                state.localState = rebasedLocalState
            } else {
                state.localState = undefined
            }
        }

        if (minLoadTimeElapsed) {
            state.isLoading = false
        }
        loaded = true

        // If a rebase produced fresh local edits, ensure they flush. The
        // user's update() during the inflight write already scheduled an
        // autosave, so this is mostly defensive.
        if (state.localState !== undefined) {
            scheduleAutosave()
        }

        notify()
    }

    const handleError = (error: Error) => {
        if (retryOnError) {
            console.warn('Collection listener error, retrying:', error)
            retryTimeout = setTimeout(() => {
                stop()
                startListener()
            }, retryInterval)
        } else {
            state.error = error
            // Don't leave consumers stuck on a loading spinner — the listener
            // has reported a terminal error, so loading is done.
            state.isLoading = false
            loaded = true
            store.reportError(error, {
                type: 'collection',
                path: collectionPath,
                operation: 'read',
            })
            notify()
        }
    }

    const startListener = () => {
        if (unsubscribeListener) return

        loaded = false
        minLoadTimeElapsed = false

        const q = allConstraints.length > 0
            ? query(collectionRef, ...allConstraints)
            : collectionRef

        unsubscribeListener = onSnapshot(
            q,
            (snapshot) => {
                const docs = snapshot.docs.map((docSnap) => ({
                    id: docSnap.id,
                    data: docSnap.data() as TData,
                }))
                handleSnapshot(docs)
            },
            handleError
        )

        // Min load time handler — tracked so stop() can cancel it.
        minLoadTimeout = setTimeout(() => {
            minLoadTimeout = null
            if (loaded) {
                state.isLoading = false
                notify()
            }
            minLoadTimeElapsed = true
        }, minLoadTime)
    }

    const load = () => {
        // Listener-level idempotency so the hook can safely call load() on
        // every mount (including Strict Mode's mount-cleanup-remount cycle).
        if (unsubscribeListener) return
        if (!state.isActive) {
            state.isActive = true
            state.isLoading = true
            notify()
        }
        startListener()
    }

    const stop = () => {
        if (retryTimeout) {
            clearTimeout(retryTimeout)
            retryTimeout = null
        }
        if (unsubscribeListener) {
            unsubscribeListener()
            unsubscribeListener = null
        }
        if (autosaveTimeout) {
            clearTimeout(autosaveTimeout)
            autosaveTimeout = null
        }
        if (minLoadTimeout) {
            clearTimeout(minLoadTimeout)
            minLoadTimeout = null
        }
        // Drop this subscription's entry from the global sync-state map so
        // an unmounted hook does not leave useIsSynced stuck at false.
        store.unregisterSyncState(syncKey)
    }

    const subscribe = (fn: Subscriber<CollectionState<TData>>): Unsubscribe => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
    }

    const buildHandle = (): CollectionHandle<TData> => ({
        data: getMergedData(),
        update: updateState,
        add: addDocument,
        remove: removeDocument,
        isLoading: state.isLoading,
        isSynced: state.localState === undefined,
        isActive: state.isActive,
        load,
        sync,
        error: state.error,
        ref: collectionRef,
    })

    const getHandle = (): CollectionHandle<TData> => {
        if (cachedHandle === null) {
            cachedHandle = buildHandle()
        }
        return cachedHandle
    }

    // No constructor-side auto-start: callers (the hook for non-lazy, or
    // users directly for lazy) invoke load() to attach the listener. This
    // keeps subscription creation side-effect-free, matching document.ts.

    return {
        load,
        stop,
        subscribe,
        getState: getPublicState,
        getHandle,
        sync,
    }
}
