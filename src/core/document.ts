import {
    doc,
    collection,
    onSnapshot,
    setDoc,
    updateDoc,
    deleteDoc,
    DocumentReference,
    type FieldPath,
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
} from '../types'
import type { FirestateStore } from './store'
import {
    applyDiff,
    applyDiffMutable,
    applyOverridesAtPaths,
    computeDiff,
    deepClone,
    diffToFieldPathArgs,
    dropCommittedSentinels,
    isDeepEqual,
    observableStateChanged,
    reconcileDisplayOverrides,
    valuesEqualForNoOp,
} from '../utils/diff'

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
    /**
     * Resolved collection path. If omitted and `definition.collection` is a
     * string, that value is used. If `definition.collection` is a function,
     * this option is required.
     */
    collectionPath?: string
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
 * The same convention applies to `inflightLocalState` and `committedWrite`.
 */
interface DocumentInternalState<T extends FirestoreObject> {
    syncState: T | undefined
    localState: T | null | undefined
    isLoading: boolean
    error: Error | undefined
    waitingForUpdate: boolean
    inflightLocalState: T | null | undefined
    /**
     * The payload of the last write the server durably accepted (set the
     * moment the write promise resolves, consumed by the next snapshot's
     * rebase). Lets the rebase recognize a committed FieldValue sentinel and
     * drop it instead of re-deriving and re-writing it forever — see
     * `dropCommittedSentinels`.
     */
    committedWrite: T | null | undefined
    /** Whether the pending operation is a full set (create/replace) vs a partial update */
    isSetOperation: boolean
    /**
     * Frozen display values for `serverTimestamp()` sentinels currently
     * sitting in `localState`. Keyed by dotted path. Captured at the
     * moment a sentinel first appears, dropped when the sentinel leaves
     * `localState` (sync ack or overwrite). Substituted into the merged
     * view by `getMergedData` so consumers always see a renderable
     * `Timestamp`, never a raw FieldValue, while the write is in flight.
     */
    displayOverrides: Map<string, unknown>
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
    const { store, definition, docId, collectionPath: resolvedCollectionPath, readOnly, onPushUndo } = options
    const { firestore, autosave: defaultAutosave, minLoadTime: defaultMinLoadTime } = store

    const {
        collection: collectionConfig,
        id,
        autosave = defaultAutosave,
        minLoadTime = defaultMinLoadTime,
        readOnly: definitionReadOnly,
        retryOnError = false,
        retryInterval = 5000,
        schema,
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
    // Same shape as docId: prefer a caller-resolved path, fall back to a
    // string `definition.collection` for direct use. Function definitions
    // must come pre-resolved from the hook layer.
    const collectionPath = resolvedCollectionPath ?? (typeof collectionConfig === 'string' ? collectionConfig : undefined)
    if (collectionPath === undefined) {
        throw new Error(
            `createDocumentSubscription: definition.collection is a function; pass a resolved collectionPath in options.`
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
        committedWrite: undefined,
        isSetOperation: false,
        displayOverrides: new Map(),
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
        const base = state.localState ?? state.syncState
        if (base === undefined) return undefined
        return applyOverridesAtPaths(base, state.displayOverrides)
    }

    const getPublicState = (): DocumentState<TData> => ({
        data: getMergedData(),
        isLoading: state.isLoading,
        // The completion of isLoading: the first snapshot has arrived (and any
        // minLoadTime has elapsed). isLoading already folds in both, so the
        // inverse is the "ready to render" signal.
        isLoaded: !state.isLoading,
        isSynced: state.localState === undefined,
        error: state.error,
    })

    // Last public state actually published. Used to suppress redundant
    // notifies (§3/§4 snapshot-side no-op collapse): a snapshot or write that
    // leaves every observable field unchanged must not invalidate the handle
    // or wake consumers, or the write-back render loop survives.
    let lastPublished: DocumentState<TData> | null = null
    // Cached public state — like cachedHandle, returns the same reference until
    // notify() invalidates it, so the hook layer can use getState() as a stable
    // useSyncExternalStore snapshot.
    let cachedState: DocumentState<TData> | null = null

    const publicStateChanged = observableStateChanged

    const notify = () => {
        // Reconcile display overrides against the current localState
        // before publishing — captures Timestamp.now() for any newly
        // arrived serverTimestamp() sentinel and drops entries whose
        // sentinels have been overwritten or acked away.
        reconcileDisplayOverrides(
            state.localState && typeof state.localState === 'object'
                ? (state.localState as Record<string, unknown>)
                : undefined,
            state.displayOverrides
        )
        const publicState = getPublicState()
        // Snapshot-side no-op collapse: nothing a consumer can observe
        // changed → publish nothing. Keeps the cached handle identity stable
        // so useSyncExternalStore does not re-render.
        if (lastPublished !== null && !publicStateChanged(lastPublished, publicState)) {
            return
        }
        lastPublished = publicState
        cachedHandle = null
        // Reuse the just-built state as the cached snapshot so getState() and
        // the published value share one identity-stable reference.
        cachedState = publicState
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

        // Use raw localState as the mutation base so serverTimestamp() sentinels
        // in localState survive into newLocalState. getMergedData() substitutes
        // display-override Timestamps at sentinel paths, which would erase the
        // sentinel from state.localState on the next update() call.
        const rawBase = (state.localState ?? state.syncState) as TData
        const newLocalState = deepClone(rawBase)
        applyDiffMutable(newLocalState, diff as Record<string, unknown>)

        // No-op collapse (§3): a write whose merged result equals the current
        // view must produce NO new state identity, undo entry, notify, or
        // autosave — otherwise the write-back render loop survives. Compare
        // raw states (decides whether to STORE); valuesEqualForNoOp closes the
        // NaN and explicit-undefined gaps that let the loop slip past a naive
        // equality check.
        if (valuesEqualForNoOp(rawBase, newLocalState)) {
            return
        }

        // Push undo eagerly against the pre-mutation state. Cmd+Z within the
        // autosave window pops this entry, applies the inverse via updateState,
        // and the sync() no-op shortcut absorbs the resulting same-as-syncState
        // case without a Firestore write.
        if (undoOptions?.undoable !== false && onPushUndo) {
            const undoDiff = computeDiff(
                newLocalState as FirestoreObject,
                rawBase as FirestoreObject
            )
            const redoDiff = computeDiff(
                rawBase as FirestoreObject,
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

        // Use schema.parse as a validation guard — throw on bad input — but
        // discard the parsed result and store the caller's original object.
        // Storing parsed output would (a) silently drop unknown keys via
        // Zod's default `.strip()` behavior, and (b) cause undo/redo replay
        // through this same path to re-apply any schema transforms a second
        // time. Partial update() diffs are intentionally NOT validated:
        // diffs commonly carry Firestore sentinels (serverTimestamp,
        // arrayUnion, deleteField) that aren't representable in a strict
        // schema.
        if (schema) schema.parse(data)

        const currentData = getMergedData()

        // No-op collapse (§3): a set() whose payload equals the current stored
        // value is a complete no-op. Skip only when there IS a current value —
        // a set against undefined data is a creation and must proceed. Compare
        // raw state so a held serverTimestamp() sentinel isn't masked by its
        // display Timestamp.
        if (
            currentData !== undefined &&
            valuesEqualForNoOp(state.localState ?? state.syncState, data)
        ) {
            return
        }

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
                // Snapshot raw localState so the restore payload contains
                // serverTimestamp() sentinels, not the frozen Timestamps that
                // getMergedData() substitutes for display purposes.
                const dataToRestore = deepClone((state.localState ?? state.syncState) as TData)
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
        if (currentData === undefined) {
            return
        }

        // Push undo against the pre-delete data (which includes any pending
        // local edits at this moment).
        if (undoOptions?.undoable !== false && onPushUndo) {
            // Snapshot raw localState — same reason as in setData above.
            const dataToRestore = deepClone((state.localState ?? state.syncState) as TData)
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
        if (state.localState === undefined) {
            return
        }

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

        // Snapshot exactly what we're committing so the next snapshot's rebase
        // can recognize committed FieldValue sentinels and drop them. Captured
        // in a local const before the await — NOT read back from shared state —
        // because Firestore fires a local-cache echo snapshot (hasPendingWrites:
        // true) before this write acks, and handleSnapshot clears
        // state.inflightLocalState. Reading it back at line `committedWrite = …`
        // would then capture `undefined`, losing the sentinel record and making
        // serverTimestamp churn / increment double-apply. Mirrors collection.ts.
        const committing = deepClone(state.localState)
        state.inflightLocalState = committing

        state.waitingForUpdate = true

        try {
            if (useSetDoc) {
                // Full set / creation — use setDoc to create or completely
                // replace the document.
                await setDoc(docRef, state.localState as TData)
            } else {
                // Partial update — use updateDoc with the variadic FieldPath
                // form (not a flattened dotted-key object) so that a "." inside
                // a map key (e.g. an email key `a@b.com`) is preserved as a
                // literal segment instead of being re-parsed as a path
                // separator. updateDoc still fails if the document doesn't
                // exist, so deleted docs are not accidentally recreated.
                const args = diffToFieldPathArgs(
                    diff as Record<string, unknown>
                )
                if (args.length) {
                    await updateDoc(
                        docRef,
                        ...(args as [
                            string | FieldPath,
                            unknown,
                            ...unknown[]
                        ])
                    )
                }
            }
            // The server durably accepted this payload. Record it so the next
            // snapshot's rebase can recognize committed FieldValue sentinels
            // (serverTimestamp, increment, …) and drop them instead of
            // re-deriving and re-writing them forever.
            state.committedWrite = committing
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
        // `prevSync` is the BASELINE: the server snapshot our pending local
        // edits are measured against. We advance it to `newSyncData` below,
        // after using it to re-derive the user's own edits.
        const prevSync = state.syncState
        state.syncState = newSyncData
        // A successful snapshot supersedes any previous read or write error.
        state.error = undefined

        // The rebase below runs on EVERY snapshot, using `prevSync` as the
        // baseline, regardless of whether one of our own writes happened to be
        // in flight. This is the fix for the collaborator-clobber class of bugs
        // — previously the rebase only ran inside the `waitingForUpdate`
        // window, so a snapshot from another client left `localState` sitting
        // on a stale base.
        state.waitingForUpdate = false
        state.inflightLocalState = undefined
        // Capture and consume the last committed write before the rebase: a
        // FieldValue sentinel present in this payload has landed on the server,
        // so the rebase must drop it rather than re-derive it (see below).
        const committed = state.committedWrite
        state.committedWrite = undefined
        const currentLocal = state.localState

        if (currentLocal === null) {
            // Pending delete — our delete intent is the latest word. The doc
            // is still present on the server here; preserve the tombstone so
            // the next sync issues deleteDoc.
        } else if (currentLocal !== undefined && prevSync !== undefined) {
            // Field-level merge (Bug 1 fix). Re-derive the user's OWN edits
            // relative to the baseline, then re-apply only those over the new
            // server truth. Untouched fields follow the server; the client's
            // actual edits survive. Same-field concurrent edits stay
            // last-write-wins — the local edit is preserved and re-sent on the
            // next sync.
            const userEdits = computeDiff(prevSync, currentLocal)
            // Drop FieldValue sentinels we already committed: they've been
            // resolved by the server, so newSyncData is the truth. Without
            // this a sentinel never compares equal to its resolved value and
            // would be re-derived and re-written on every snapshot forever.
            dropCommittedSentinels(
                userEdits as Record<string, unknown>,
                committed as Record<string, unknown> | null | undefined
            )
            const rebasedLocalState = applyDiff(newSyncData, userEdits)
            // If the rebase leaves nothing that differs from the server, the
            // edit has been fully absorbed → drop localState so isSynced flips
            // back to true and no redundant write is queued.
            const absorbed = isDeepEqual(rebasedLocalState, newSyncData)
            state.localState = absorbed ? undefined : rebasedLocalState
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
        // Drop any committed-write record: it described a now-deleted doc and
        // must not be matched against a future recreation snapshot.
        state.committedWrite = undefined

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
        if (unsubscribeListener) {
            return
        }

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
        isLoaded: !state.isLoading,
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

    // Identity-stable like getHandle: rebuilt only after notify() invalidates
    // the cache, so useSyncExternalStore can treat it as the snapshot.
    const getState = (): DocumentState<TData> => {
        if (cachedState === null) {
            cachedState = getPublicState()
        }
        return cachedState
    }

    return {
        load,
        stop,
        subscribe,
        getState,
        getHandle,
        sync,
    }
}
