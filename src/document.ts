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
    definition: DocumentDefinition<TData>
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
    let minLoadTimeout: ReturnType<typeof setTimeout> | null = null
    let minLoadTimeElapsed = false
    let loaded = false
    // Cached handle — returns the same reference until notify() invalidates
    // it. Lets useSyncExternalStore consumers rely on handle identity.
    let cachedHandle: DocumentHandle<TData> | null = null

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
        cachedHandle = null
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
            state.error = error as Error
            store.reportError(error as Error, {
                type: 'document',
                path: `${collectionPath}/${documentId}`,
                operation: 'write',
            })
            notify()
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
        if (!state.localState) return

        // No-op if local state already matches what the server holds.
        if (state.syncState && isDeepEqual(state.localState, state.syncState)) {
            state.localState = undefined
            state.inflightLocalState = undefined
            notify()
            return
        }

        const wasSetOperation = state.isSetOperation
        state.isSetOperation = false

        // A creation occurs when there's no server state to diff against —
        // either the user explicitly called set() to create the document, or
        // the listener has reported the doc as missing. In both cases we use
        // setDoc and push a creation-aware undo (delete to undo, set to redo).
        const isCreation = !state.syncState
        const useSetDoc = wasSetOperation || isCreation

        const diff = state.syncState
            ? computeDiff(state.syncState, state.localState)
            : undefined

        state.inflightLocalState = deepClone(state.localState)
        const currentUndoOptions = state.pendingUndoOptions
        state.pendingUndoOptions = undefined

        // Push undo action if enabled
        if (currentUndoOptions?.undoable !== false && onPushUndo) {
            if (isCreation) {
                // Undo a creation by deleting the doc; redo by setting it
                // again with the data that was just written.
                const dataForRedo = deepClone(state.localState)
                onPushUndo(
                    () => deleteDocument({ undoable: false }),
                    () => setData(dataForRedo, { undoable: false }),
                    currentUndoOptions
                )
            } else if (diff) {
                const undoDiff = computeDiff(state.localState, state.syncState!)
                onPushUndo(
                    () => updateState(undoDiff as WithFieldValue<DeepPartial<TData>>, { undoable: false }),
                    () => updateState(diff as WithFieldValue<DeepPartial<TData>>, { undoable: false }),
                    currentUndoOptions
                )
            }
        }

        state.waitingForUpdate = true

        try {
            if (useSetDoc) {
                // Full set / creation — use setDoc to create or completely
                // replace the document.
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
            // Surface to React: handle.error reflects the failure and the
            // listener will keep state.localState so consumers can retry by
            // calling sync() or by issuing another update. Autosave is not
            // automatically rescheduled to avoid retry loops on permission
            // errors — that policy is left to the consumer.
            state.error = error as Error
            store.reportError(error as Error, {
                type: 'document',
                path: `${collectionPath}/${documentId}`,
                operation: 'write',
            })
            notify()
        }
    }

    const handleSnapshot = (newSyncData: TData) => {
        state.syncState = newSyncData
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

        // If local edits exist and aren't currently being synced, schedule an
        // autosave. Covers the case where set() ran before the first snapshot
        // arrived and the initial sync attempt bailed early.
        if (state.localState !== undefined) {
            scheduleAutosave()
        }

        notify()
    }

    // A document that does not exist is not an error condition — consumers
    // commonly use that state to render a "create" UI. Clear loading and
    // leave error undefined; data will be undefined via getMergedData().
    const handleMissingDocument = () => {
        state.syncState = undefined
        state.error = undefined
        if (state.waitingForUpdate) {
            state.waitingForUpdate = false
            state.inflightLocalState = undefined
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
            // Don't leave consumers stuck on a loading spinner — the listener
            // has reported a terminal error, so loading is done.
            state.isLoading = false
            loaded = true
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
                } else if (!snapshot.metadata.fromCache) {
                    handleMissingDocument()
                }
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
        if (minLoadTimeout) {
            clearTimeout(minLoadTimeout)
            minLoadTimeout = null
        }
        // Drop this subscription's entry from the global sync-state map so
        // an unmounted hook does not leave useIsSynced stuck at false.
        store.unregisterSyncState(syncKey)
    }

    const subscribe = (fn: Subscriber<DocumentState<TData>>): Unsubscribe => {
        subscribers.add(fn)
        return () => subscribers.delete(fn)
    }

    const buildHandle = (): DocumentHandle<TData> => ({
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

    const getHandle = (): DocumentHandle<TData> => {
        if (cachedHandle === null) {
            cachedHandle = buildHandle()
        }
        return cachedHandle
    }

    return {
        start,
        stop,
        subscribe,
        getState: getPublicState,
        getHandle,
        sync,
    }
}
