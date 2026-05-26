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

// Module-level counter so each subscription instance gets a unique sync key,
// even when multiple instances target the same document path.
let syncKeyCounter = 0

/**
 * Options for creating a document subscription
 */
export interface DocumentOptions<TData extends FirestoreObject> {
    /** The store instance */
    store: FirestateStore
    /** Document definition from defineDocument() */
    definition: DocumentDefinition<TData>
    /**
     * Resolved document id. If omitted and `definition.id` is a string, that
     * value is used. If `definition.id` is a function, this option is required.
     */
    docId?: string
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
 * Internal state for a document subscription.
 *
 * `localState` uses three distinct values:
 * - `undefined`: no pending local changes
 * - `null`: pending delete (the autosave-driven sync will issue deleteDoc)
 * - object: pending update/set (synced via updateDoc/setDoc)
 *
 * The same convention applies to `inflightLocalState`.
 */
interface DocumentInternalState<T extends FirestoreObject> {
    syncState: T | undefined
    localState: T | null | undefined
    isLoading: boolean
    error: Error | undefined
    waitingForUpdate: boolean
    inflightLocalState: T | null | undefined
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
 *   docId: '123',
 * })
 *
 * const unsubscribe = subscription.subscribe((state) => {
 *   console.log('Document state:', state)
 * })
 *
 * subscription.load()
 * ```
 */
export const createDocumentSubscription = <TData extends FirestoreObject>(
    options: DocumentOptions<TData>
): {
    /** Attach the Firestore listener */
    load: () => void
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
    const { store, definition, docId, readOnly, onPushUndo } = options
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
    // Prefer the caller-resolved docId. Fall back to a string `definition.id`
    // for ergonomic direct use; if both are missing, the caller forgot to
    // resolve a function id and we surface that immediately.
    const documentId = docId ?? (typeof id === 'string' ? id : undefined)
    if (documentId === undefined) {
        throw new Error(
            `createDocumentSubscription: definition.id is a function; pass a resolved docId in options.`
        )
    }

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

    // Unique key for sync tracking, scoped per-instance so multiple
    // subscriptions to the same path don't share (or clobber) one entry.
    const syncKey = `doc:${collectionPath}/${documentId}#${++syncKeyCounter}`

    const getMergedData = (): TData | undefined => {
        // null localState marks a pending delete — surface as no data.
        if (state.localState === null) return undefined
        return state.localState ?? state.syncState
    }

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
        if (!currentData) {
            if (process.env.NODE_ENV !== 'production') {
                console.warn(
                    `[firestate] update() on ${collectionPath}/${documentId} was ignored: there is no current data to diff against. ` +
                        `This happens when the document is still loading, has been deleted, or doesn't exist yet. ` +
                        `Use set() to create the document, or gate update calls on a non-undefined data value.`
                )
            }
            return
        }

        const newLocalState = deepClone(currentData)
        applyDiffMutable(newLocalState, diff as Record<string, unknown>)

        // Push undo eagerly against the pre-mutation state. Cmd+Z within the
        // autosave window pops this entry, applies the inverse via updateState,
        // and the sync() no-op shortcut absorbs the resulting same-as-syncState
        // case without a Firestore write.
        if (undoOptions?.undoable !== false && onPushUndo) {
            const undoDiff = computeDiff(
                newLocalState as FirestoreObject,
                currentData as FirestoreObject
            )
            const redoDiff = computeDiff(
                currentData as FirestoreObject,
                newLocalState as FirestoreObject
            )
            onPushUndo(
                () => updateState(undoDiff as WithFieldValue<DeepPartial<TData>>, { undoable: false }),
                () => updateState(redoDiff as WithFieldValue<DeepPartial<TData>>, { undoable: false }),
                undoOptions
            )
        }

        state.localState = newLocalState
        state.isSetOperation = false

        notify()
        scheduleAutosave()
    }

    const setData = (data: TData, undoOptions: UpdateOptions = {}) => {
        if (isReadOnly) return

        const currentData = getMergedData()

        // Push undo eagerly. A set against undefined data is a creation;
        // its undo is a delete. Otherwise we restore the prior snapshot via
        // setData, which is symmetric and handles full-replace semantics
        // (including field removals) correctly.
        if (undoOptions?.undoable !== false && onPushUndo) {
            const dataForRedo = deepClone(data)
            if (currentData === undefined) {
                onPushUndo(
                    () => deleteDocument({ undoable: false }),
                    () => setData(dataForRedo, { undoable: false }),
                    undoOptions
                )
            } else {
                const dataToRestore = deepClone(currentData)
                onPushUndo(
                    () => setData(dataToRestore, { undoable: false }),
                    () => setData(dataForRedo, { undoable: false }),
                    undoOptions
                )
            }
        }

        state.localState = deepClone(data)
        state.isSetOperation = true

        notify()
        scheduleAutosave()
    }

    const deleteDocument = (undoOptions: UpdateOptions = {}) => {
        if (isReadOnly) return

        const currentData = getMergedData()
        // Nothing to delete — bail rather than queueing a no-op deleteDoc.
        if (currentData === undefined) return

        // Push undo against the pre-delete data (which includes any pending
        // local edits at this moment).
        if (undoOptions?.undoable !== false && onPushUndo) {
            const dataToRestore = deepClone(currentData)
            onPushUndo(
                () => setData(dataToRestore, { undoable: false }),
                () => deleteDocument({ undoable: false }),
                undoOptions
            )
        }

        // Mark localState as a pending delete and let scheduleAutosave drive
        // the actual deleteDoc call — same flow as set/update.
        state.localState = null
        state.isSetOperation = false

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
        if (state.localState === undefined) return

        // Pending delete — issue deleteDoc and let the listener confirm via
        // handleMissingDocument. Undo was already pushed at mutation time.
        if (state.localState === null) {
            state.inflightLocalState = null
            state.waitingForUpdate = true

            try {
                await deleteDoc(docRef)
            } catch (error) {
                console.error('Sync failed:', error)
                state.waitingForUpdate = false
                state.inflightLocalState = undefined
                state.error = error as Error
                store.reportError(error as Error, {
                    type: 'document',
                    path: `${collectionPath}/${documentId}`,
                    operation: 'write',
                })
                notify()
            }
            return
        }

        // No-op if local state already matches what the server holds. This is
        // the path that an undo-of-pending-local takes: the inverse update
        // brings localState back to syncState, and we exit without a write.
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
        // setDoc.
        const isCreation = !state.syncState
        const useSetDoc = wasSetOperation || isCreation

        const diff = state.syncState
            ? computeDiff(state.syncState, state.localState)
            : undefined

        state.inflightLocalState = deepClone(state.localState)

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

            if (inflightState === null) {
                // Inflight was a delete but the listener fired with the doc
                // still present. The deleteDoc result is still in flight (or
                // failed and reverted). Leave localState alone — it's either
                // still null (we still want the delete) or non-null (user
                // changed their mind), and either way the next sync handles it.
            } else if (currentLocal === null) {
                // User issued a delete while a set/update was inflight. The
                // pending delete is the latest intent; preserve it for the
                // next sync.
            } else if (
                inflightState &&
                currentLocal &&
                !isDeepEqual(currentLocal, inflightState)
            ) {
                // Rebase local changes onto the new sync state.
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

        // The only localState that should clear when the doc goes missing is
        // our own pending-delete marker. Any other pending edits (object
        // value) represent the user's intent to recreate the doc — the next
        // sync() will issue a setDoc against the now-missing doc and create
        // it from scratch.
        if (state.localState === null) {
            state.localState = undefined
            state.isSetOperation = false
            if (autosaveTimeout) {
                clearTimeout(autosaveTimeout)
                autosaveTimeout = null
            }
        }

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
                load()
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

    const load = () => {
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
        load,
        stop,
        subscribe,
        getState: getPublicState,
        getHandle,
        sync,
    }
}
