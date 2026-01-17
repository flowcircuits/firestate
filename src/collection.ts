import {
    collection,
    doc,
    onSnapshot,
    query,
    writeBatch,
    deleteField,
    WithFieldValue,
    QueryConstraint,
} from 'firebase/firestore'
import type { z } from 'zod'
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

/**
 * Options for creating a collection subscription
 */
export interface CollectionOptions<TData extends FirestoreObject> {
    /** The store instance */
    store: FirestateStore
    /** Collection definition from defineCollection() */
    definition: CollectionDefinition<z.ZodType<TData>>
    /** Route/path parameters for dynamic paths */
    params?: Record<string, string>
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
 *   params: { projectId: '123' },
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
    const { store, definition, params = {}, readOnly, queryConstraints: extraConstraints, onPushUndo } = options
    const { firestore, autosave: defaultAutosave, minLoadTime: defaultMinLoadTime } = store

    const {
        path,
        autosave = defaultAutosave,
        minLoadTime = defaultMinLoadTime,
        readOnly: definitionReadOnly,
        lazy = false,
        queryConstraints: definitionConstraints,
    } = definition

    const isReadOnly = readOnly ?? definitionReadOnly ?? false
    const collectionPath = typeof path === 'function' ? path(params) : path
    const allConstraints = [...(definitionConstraints ?? []), ...(extraConstraints ?? [])]

    // Create collection reference
    const collectionRef = collection(firestore, collectionPath)

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
    let minLoadTimeElapsed = false
    let loaded = false

    // Unique key for sync tracking
    const syncKey = `col:${collectionPath}`

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
        const publicState = getPublicState()
        subscribers.forEach((fn) => fn(publicState))
        store.reportSyncState(syncKey, publicState.isSynced)
    }

    const updateState = (
        diff: WithFieldValue<DeepPartial<Record<string, TData>>>,
        undoOptions: UpdateOptions = {}
    ) => {
        if (isReadOnly) return

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

    const addDocument = (
        id: string,
        data: Omit<TData, 'id'>,
        undoOptions: UpdateOptions = {}
    ) => {
        if (isReadOnly) return

        const currentData = getMergedData()
        const newLocalState = deepClone(currentData)
        newLocalState[id] = { ...data, id } as unknown as TData

        state.localState = newLocalState
        state.pendingUndoOptions = undoOptions

        notify()
        scheduleAutosave()
    }

    const removeDocument = (id: string, undoOptions: UpdateOptions = {}) => {
        if (isReadOnly) return

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
        if (!state.localState || !state.syncState) return
        if (isDeepEqual(state.localState, state.syncState)) {
            state.localState = undefined
            state.inflightLocalState = undefined
            notify()
            return
        }

        const diff = computeDiff(
            state.syncState as FirestoreObject,
            state.localState as FirestoreObject
        )
        state.inflightLocalState = deepClone(state.localState)
        const currentUndoOptions = state.pendingUndoOptions
        state.pendingUndoOptions = undefined

        // Push undo action if enabled
        if (currentUndoOptions?.undoable !== false && onPushUndo) {
            const undoDiff = computeDiff(
                state.localState as FirestoreObject,
                state.syncState as FirestoreObject
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
                } else if (state.syncState && !(docId in state.syncState)) {
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
            store.reportError(error as Error, {
                type: 'collection',
                path: collectionPath,
                operation: 'write',
            })
        }
    }

    const handleSnapshot = (docs: Array<{ id: string; data: TData }>) => {
        const newSyncState: Record<string, TData> = {}
        for (const { id, data } of docs) {
            newSyncState[id] = { ...data, id } as TData
        }

        state.syncState = newSyncState

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
        notify()
    }

    const handleError = (error: Error) => {
        state.error = error
        store.reportError(error, {
            type: 'collection',
            path: collectionPath,
            operation: 'read',
        })
        notify()
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

        // Min load time handler
        setTimeout(() => {
            if (loaded) {
                state.isLoading = false
                notify()
            }
            minLoadTimeElapsed = true
        }, minLoadTime)
    }

    const load = () => {
        if (state.isActive) return
        state.isActive = true
        state.isLoading = true
        notify()
        startListener()
    }

    const stop = () => {
        if (unsubscribeListener) {
            unsubscribeListener()
            unsubscribeListener = null
        }
        if (autosaveTimeout) {
            clearTimeout(autosaveTimeout)
            autosaveTimeout = null
        }
    }

    const subscribe = (fn: Subscriber<CollectionState<TData>>): Unsubscribe => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
    }

    const getHandle = (): CollectionHandle<TData> => ({
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
    })

    // Auto-start for non-lazy collections
    if (!lazy) {
        startListener()
    }

    return {
        load,
        stop,
        subscribe,
        getState: getPublicState,
        getHandle,
        sync,
    }
}
