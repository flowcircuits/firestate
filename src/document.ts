import {
    doc,
    collection,
    onSnapshot,
    setDoc,
    updateDoc,
    deleteDoc,
    DocumentReference,
    WithFieldValue,
} from 'firebase/firestore'
import type { z } from 'zod'
import type {
    DeepPartial,
    DocumentDefinition,
    DocumentHandle,
    DocumentState,
    FirestoreObject,
    Subscriber,
    Unsubscribe,
    UpdateOptions,
} from './types'
import type { FirestateStore } from './store'
import { applyDiffMutable, computeDiff, deepClone, flattenDiff, isDeepEqual } from './diff'

/**
 * Options for creating a document subscription
 */
export interface DocumentOptions<TData extends FirestoreObject> {
    /** The store instance */
    store: FirestateStore
    /** Document definition from defineDocument() */
    definition: DocumentDefinition<z.ZodType<TData>>
    /** Route/path parameters for dynamic paths */
    params?: Record<string, string>
    /** Override read-only setting */
    readOnly?: boolean
    /** Callback for pushing undo actions */
    onPushUndo?: (
        undoAction: () => void,
        redoAction: () => void,
        options?: UpdateOptions
    ) => void
}

/**
 * Internal state for a document subscription
 */
interface DocumentInternalState<T extends FirestoreObject> {
    syncState: T | undefined
    localState: T | undefined
    isLoading: boolean
    error: Error | undefined
    waitingForUpdate: boolean
    inflightLocalState: T | undefined
    pendingUndoOptions: UpdateOptions | undefined
    /** Whether the pending operation is a full set (create/replace) vs a partial update */
    isSetOperation: boolean
}

/**
 * Create a document subscription.
 * This is a low-level API - prefer using useDocument hook in React.
 *
 * @example
 * ```ts
 * const subscription = createDocumentSubscription({
 *   store,
 *   definition: projectDoc,
 *   params: { projectId: '123' },
 * })
 *
 * const unsubscribe = subscription.subscribe((state) => {
 *   console.log('Document state:', state)
 * })
 *
 * subscription.start()
 * ```
 */
export const createDocumentSubscription = <TData extends FirestoreObject>(
    options: DocumentOptions<TData>
): {
    /** Start the Firestore listener */
    start: () => void
    /** Stop the Firestore listener */
    stop: () => void
    /** Subscribe to state changes */
    subscribe: (fn: Subscriber<DocumentState<TData>>) => Unsubscribe
    /** Get current state */
    getState: () => DocumentState<TData>
    /** Get document handle for updates */
    getHandle: () => DocumentHandle<TData>
    /** Force sync now */
    sync: () => Promise<void>
} => {
    const { store, definition, params = {}, readOnly, onPushUndo } = options
    const { firestore, autosave: defaultAutosave, minLoadTime: defaultMinLoadTime } = store

    const {
        collection: collectionPath,
        id,
        autosave = defaultAutosave,
        minLoadTime = defaultMinLoadTime,
        readOnly: definitionReadOnly,
        retryOnError = false,
        retryInterval = 5000,
    } = definition

    const isReadOnly = readOnly ?? definitionReadOnly ?? false
    const documentId = typeof id === 'function' ? id(params) : id

    // Create document reference
    const docRef = doc(
        collection(firestore, collectionPath),
        documentId
    ) as DocumentReference<TData>

    // Internal state
    const state: DocumentInternalState<TData> = {
        syncState: undefined,
        localState: undefined,
        isLoading: true,
        error: undefined,
        waitingForUpdate: false,
        inflightLocalState: undefined,
        pendingUndoOptions: undefined,
        isSetOperation: false,
    }

    const subscribers = new Set<Subscriber<DocumentState<TData>>>()
    let unsubscribeListener: Unsubscribe | null = null
    let autosaveTimeout: ReturnType<typeof setTimeout> | null = null
    let retryTimeout: ReturnType<typeof setTimeout> | null = null
    let minLoadTimeElapsed = false
    let loaded = false

    // Unique key for sync tracking
    const syncKey = `doc:${collectionPath}/${documentId}`

    const getMergedData = (): TData | undefined =>
        state.localState ?? state.syncState

    const getPublicState = (): DocumentState<TData> => ({
        data: getMergedData(),
        isLoading: state.isLoading,
        isSynced: state.localState === undefined,
        error: state.error,
    })

    const notify = () => {
        const publicState = getPublicState()
        subscribers.forEach((fn) => fn(publicState))
        store.reportSyncState(syncKey, publicState.isSynced)
    }

    const updateState = (
        diff: WithFieldValue<DeepPartial<TData>>,
        undoOptions: UpdateOptions = {}
    ) => {
        if (isReadOnly) return

        const currentData = getMergedData()
        if (!currentData) return

        const newLocalState = deepClone(currentData)
        applyDiffMutable(newLocalState, diff as Record<string, unknown>)
        state.localState = newLocalState
        state.pendingUndoOptions = undoOptions
        state.isSetOperation = false

        notify()
        scheduleAutosave()
    }

    const setData = (data: TData, undoOptions: UpdateOptions = {}) => {
        if (isReadOnly) return

        state.localState = deepClone(data)
        state.pendingUndoOptions = undoOptions
        state.isSetOperation = true

        notify()
        scheduleAutosave()
    }

    const deleteDocument = async (undoOptions: UpdateOptions = {}) => {
        if (isReadOnly) return

        const currentData = getMergedData()

        // Push undo action if enabled
        if (undoOptions?.undoable !== false && onPushUndo && currentData) {
            const dataToRestore = deepClone(currentData)
            onPushUndo(
                () => setData(dataToRestore, { undoable: false }),
                () => deleteDocument({ undoable: false }),
                undoOptions
            )
        }

        try {
            await deleteDoc(docRef)
        } catch (error) {
            console.error('Delete failed:', error)
            store.reportError(error as Error, {
                type: 'document',
                path: `${collectionPath}/${documentId}`,
                operation: 'write',
            })
        }
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

        const diff = computeDiff(state.syncState, state.localState)
        state.inflightLocalState = deepClone(state.localState)
        const currentUndoOptions = state.pendingUndoOptions
        state.pendingUndoOptions = undefined

        // Push undo action if enabled
        if (currentUndoOptions?.undoable !== false && onPushUndo) {
            const undoDiff = computeDiff(state.localState, state.syncState)
            const redoDiff = diff
            onPushUndo(
                () => updateState(undoDiff as WithFieldValue<DeepPartial<TData>>, { undoable: false }),
                () => updateState(redoDiff as WithFieldValue<DeepPartial<TData>>, { undoable: false }),
                currentUndoOptions
            )
        }

        state.waitingForUpdate = true
        const wasSetOperation = state.isSetOperation
        state.isSetOperation = false

        try {
            if (wasSetOperation) {
                // Full set operation - use setDoc to create or completely replace
                // This is intentional when the user calls set() to create a document
                await setDoc(docRef, state.localState as TData)
            } else {
                // Partial update - use updateDoc with flattened diff to prevent
                // accidentally recreating deleted documents. updateDoc will fail
                // if the document doesn't exist.
                const flatDiff = flattenDiff(diff as Record<string, unknown>)
                await updateDoc(docRef, flatDiff)
            }
        } catch (error) {
            console.error('Sync failed:', error)
            state.waitingForUpdate = false
            state.inflightLocalState = undefined
            store.reportError(error as Error, {
                type: 'document',
                path: `${collectionPath}/${documentId}`,
                operation: 'write',
            })
        }
    }

    const handleSnapshot = (newSyncData: TData) => {
        state.syncState = newSyncData

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
                const changesSinceInflight = computeDiff(inflightState, currentLocal)
                const rebasedLocalState = deepClone(newSyncData)
                applyDiffMutable(rebasedLocalState, changesSinceInflight as Record<string, unknown>)
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
        if (retryOnError) {
            console.warn('Document listener error, retrying:', error)
            retryTimeout = setTimeout(() => {
                stop()
                start()
            }, retryInterval)
        } else {
            state.error = error
            store.reportError(error, {
                type: 'document',
                path: `${collectionPath}/${documentId}`,
                operation: 'read',
            })
            notify()
        }
    }

    const start = () => {
        if (unsubscribeListener) return

        loaded = false
        minLoadTimeElapsed = false

        unsubscribeListener = onSnapshot(
            docRef,
            (snapshot) => {
                if (snapshot.exists()) {
                    handleSnapshot(snapshot.data())
                } else {
                    if (!snapshot.metadata.fromCache) {
                        handleError(new Error('Document not found'))
                    }
                }
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

    const stop = () => {
        if (unsubscribeListener) {
            unsubscribeListener()
            unsubscribeListener = null
        }
        if (autosaveTimeout) {
            clearTimeout(autosaveTimeout)
            autosaveTimeout = null
        }
        if (retryTimeout) {
            clearTimeout(retryTimeout)
            retryTimeout = null
        }
    }

    const subscribe = (fn: Subscriber<DocumentState<TData>>): Unsubscribe => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
    }

    const getHandle = (): DocumentHandle<TData> => ({
        data: getMergedData(),
        update: updateState,
        set: setData,
        delete: deleteDocument,
        isLoading: state.isLoading,
        isSynced: state.localState === undefined,
        sync,
        error: state.error,
        ref: docRef,
    })

    return {
        start,
        stop,
        subscribe,
        getState: getPublicState,
        getHandle,
        sync,
    }
}
