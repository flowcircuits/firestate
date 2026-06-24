import {
    collection,
    doc,
    onSnapshot,
    query,
    writeBatch,
    deleteField,
    type FieldPath,
    WithFieldValue,
    QueryConstraint,
    type CollectionReference,
    type Query,
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
// even when multiple instances target the same collection path.
let syncKeyCounter = 0

/**
 * Build the Firestore query a collection subscription runs: `definition`-level
 * constraints first, then hook-level `extraConstraints`. With no constraints at
 * all the bare collection reference is itself a valid `Query`.
 *
 * Single source of truth for query assembly. `useCollection` decides whether a
 * fresh `queryConstraints` array is semantically the same query — and so
 * whether to keep the existing listener instead of tearing it down — by
 * building the prospective query with this exact function and comparing via
 * Firestore's `queryEqual` (see hooks.ts). That comparison is only correct if
 * it assembles the query the same way the subscription does, so both paths MUST
 * go through here. Don't re-inline the merge order at either call site.
 */
export const buildCollectionQuery = <TData>(
    ref: CollectionReference<TData>,
    definitionConstraints: QueryConstraint[] | undefined,
    extraConstraints: QueryConstraint[] | undefined
): Query<TData> => {
    const all = [...(definitionConstraints ?? []), ...(extraConstraints ?? [])]
    return all.length > 0 ? query(ref, ...all) : ref
}

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
    /**
     * The payload of the last batch the server durably accepted (set the
     * moment `batch.commit()` resolves, consumed by the next snapshot's
     * rebase). Lets the rebase recognize a committed FieldValue sentinel and
     * drop it instead of re-deriving and re-writing it forever — see
     * `dropCommittedSentinels`.
     */
    committedWrite: Record<string, T> | undefined
    /**
     * Frozen display values for `serverTimestamp()` sentinels currently
     * sitting in `localState`. Keyed by dotted path (e.g.
     * `"<docId>.updatedAt"`). See document.ts for the full contract.
     */
    displayOverrides: Map<string, unknown>
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
        schema,
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
    // Create collection reference
    const collectionRef = collection(firestore, collectionPath) as CollectionReference<TData>

    // Internal state
    const state: CollectionInternalState<TData> = {
        syncState: undefined,
        localState: undefined,
        isLoading: !lazy,
        isActive: !lazy,
        error: undefined,
        committedWrite: undefined,
        displayOverrides: new Map(),
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

    const getMergedData = (): Record<string, TData> => {
        const base = state.localState ?? state.syncState ?? {}
        return applyOverridesAtPaths(base, state.displayOverrides)
    }

    const getPublicState = (): CollectionState<TData> => ({
        data: getMergedData(),
        isLoading: state.isLoading,
        isSynced: state.localState === undefined,
        isActive: state.isActive,
        error: state.error,
    })

    // Last public state actually published — see document.ts for the full
    // contract behind this snapshot-side no-op collapse (§3/§4).
    let lastPublished: CollectionState<TData> | null = null

    const publicStateChanged = (
        prev: CollectionState<TData>,
        next: CollectionState<TData>
    ): boolean =>
        // isActive is collection-specific (lazy loading); the rest of the
        // observable no-op collapse is shared with documents.
        prev.isActive !== next.isActive ||
        observableStateChanged(prev, next)

    const notify = () => {
        // Reconcile display overrides against the current localState
        // before publishing — see document.ts for the full contract.
        reconcileDisplayOverrides(
            state.localState as Record<string, unknown> | undefined,
            state.displayOverrides
        )
        const publicState = getPublicState()
        // Snapshot-side no-op collapse: nothing observable changed → publish
        // nothing, keeping the cached handle identity stable.
        if (lastPublished !== null && !publicStateChanged(lastPublished, publicState)) {
            return
        }
        lastPublished = publicState
        cachedHandle = null
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

        // Use raw localState as the mutation base so serverTimestamp() sentinels
        // in localState survive into newLocalState. getMergedData() substitutes
        // display-override Timestamps at sentinel paths, which would erase the
        // sentinel from state.localState on the next update() call.
        const rawBase = state.localState ?? state.syncState ?? {}
        const newLocalState = deepClone(rawBase)
        applyDiffMutable(newLocalState, diff as Record<string, unknown>)

        // Ensure each document has its id
        for (const [docId, docData] of Object.entries(newLocalState)) {
            if (docData && typeof docData === 'object') {
                ;(docData as Record<string, unknown>).id = docId
            }
        }

        // No-op collapse (§3): a write whose merged result equals the current
        // view produces NO new state identity, undo entry, notify, or
        // autosave. rawBase and newLocalState are compared after id injection
        // so both carry ids; valuesEqualForNoOp closes the NaN /
        // explicit-undefined gaps that defeat a naive guard.
        if (valuesEqualForNoOp(rawBase, newLocalState)) return

        // Push undo eagerly against the pre-mutation snapshot. Cmd+Z within
        // the autosave window pops this entry, applies the inverse via
        // updateState, and the sync() no-op shortcut absorbs the resulting
        // same-as-syncState case without a Firestore write.
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
                () => updateState(undoDiff as WithFieldValue<DeepPartial<Record<string, TData>>>, { undoable: false }),
                () => updateState(redoDiff as WithFieldValue<DeepPartial<Record<string, TData>>>, { undoable: false }),
                undoOptions
            )
        }

        state.localState = newLocalState

        notify()
        scheduleAutosave()
    }

    // Overloaded: callers can pass (id, data, opts) or (data, opts). The
    // no-id form generates a Firestore auto-id via doc(collectionRef).id and
    // returns it so the caller can reference the new doc immediately.
    // Returns undefined when the mutation is dropped so callers can't
    // accidentally route on or persist an id that was never queued.
    function addDocument(
        id: string,
        data: Omit<TData, 'id'>,
        undoOptions?: UpdateOptions
    ): string | undefined
    function addDocument(
        data: Omit<TData, 'id'>,
        undoOptions?: UpdateOptions
    ): string | undefined
    function addDocument(
        idOrData: string | Omit<TData, 'id'>,
        dataOrOptions?: Omit<TData, 'id'> | UpdateOptions,
        maybeUndoOptions?: UpdateOptions
    ): string | undefined {
        const hasExplicitId = typeof idOrData === 'string'
        const data = (hasExplicitId ? dataOrOptions : idOrData) as Omit<TData, 'id'>
        const undoOptions = (hasExplicitId
            ? maybeUndoOptions
            : (dataOrOptions as UpdateOptions | undefined)) ?? {}

        if (isReadOnly) return undefined
        if (state.syncState === undefined) {
            // Bail rather than queueing: an explicit id that happens to exist
            // on the server would round-trip through computeDiff and clobber
            // any remote-only fields, and we have no way to know without a
            // first snapshot.
            warnNoSnapshot('add')
            return undefined
        }

        // Only allocate an auto-id once we know we're going to queue the
        // write — otherwise the caller might persist an id that was dropped.
        const id = hasExplicitId ? (idOrData as string) : doc(collectionRef).id

        // Use schema.parse as a validation guard — throw on bad input — but
        // discard the parsed result and store the caller's original object
        // with id attached. Storing parsed output would silently drop
        // unknown keys via Zod's default `.strip()` and re-transform on
        // undo/redo replay. We feed `{ ...data, id }` to parse so the same
        // validation works whether the user's schema declares `id` or not.
        const newDoc = { ...data, id } as unknown as TData
        if (schema) schema.parse(newDoc)

        const currentData = getMergedData()
        const newLocalState = deepClone(currentData)
        newLocalState[id] = newDoc

        // No-op collapse (§3): adding an id that already holds identical data
        // is a complete no-op. The returned id stays meaningful (the doc
        // exists with that data) but no write/undo/notify is produced.
        if (valuesEqualForNoOp(currentData, newLocalState)) return id

        // Push undo eagerly. Inverse diff deletes the just-added doc.
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
                () => updateState(undoDiff as WithFieldValue<DeepPartial<Record<string, TData>>>, { undoable: false }),
                () => updateState(redoDiff as WithFieldValue<DeepPartial<Record<string, TData>>>, { undoable: false }),
                undoOptions
            )
        }

        state.localState = newLocalState

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

        // Push undo eagerly. Inverse diff re-adds the removed doc.
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
                () => updateState(undoDiff as WithFieldValue<DeepPartial<Record<string, TData>>>, { undoable: false }),
                () => updateState(redoDiff as WithFieldValue<DeepPartial<Record<string, TData>>>, { undoable: false }),
                undoOptions
            )
        }

        state.localState = newLocalState

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
            notify()
            return
        }

        const diff = computeDiff(
            syncState as FirestoreObject,
            state.localState as FirestoreObject
        )

        // Snapshot exactly what we're committing so the next snapshot's rebase
        // can recognize committed FieldValue sentinels and drop them. Captured
        // before the await because localState may be re-edited mid-flight.
        const committing = deepClone(state.localState)

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
                    // Existing document — use update with the variadic
                    // FieldPath form (not a flattened dotted-key object) so a
                    // "." inside a map key (e.g. an email key `a@b.com`) stays a
                    // literal segment instead of being re-parsed as a path
                    // separator. update still fails if the doc doesn't exist, so
                    // deleted docs are not accidentally recreated.
                    const args = diffToFieldPathArgs(
                        docDiff as Record<string, unknown>
                    )
                    if (args.length) {
                        batch.update(
                            docRef,
                            ...(args as [
                                string | FieldPath,
                                unknown,
                                ...unknown[]
                            ])
                        )
                    }
                }
            }

            await batch.commit()
            // The server durably accepted this batch — record it for the
            // next snapshot's rebase to drop committed sentinels.
            state.committedWrite = committing
        } catch (error) {
            console.error('Collection sync failed:', error)
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

        // `prevSync` is the BASELINE: the server snapshot our pending local
        // edits are measured against. Advanced to `newSyncState` here, after
        // capturing it for the rebase below.
        const prevSync = state.syncState
        state.syncState = newSyncState
        // A successful snapshot supersedes any previous read or write error.
        state.error = undefined

        // Capture and consume the last committed batch before the rebase: a
        // FieldValue sentinel present in this payload has landed on the server,
        // so the rebase must drop it rather than re-derive it (see below).
        const committed = state.committedWrite
        state.committedWrite = undefined

        // The rebase below runs on EVERY snapshot using `prevSync` as the
        // baseline, not only the one confirming an inflight write. Previously a
        // snapshot from another client left `localState` on a stale base, so
        // the next sync re-wrote untouched fields (collaborator clobber) and
        // recreated remotely-deleted docs (delete resurrection).
        const currentLocal = state.localState

        if (currentLocal !== undefined && prevSync !== undefined) {
            // Field-level merge: re-derive the user's OWN edits relative to the
            // baseline and re-apply only those over the new server truth.
            const userEdits = computeDiff(
                prevSync as FirestoreObject,
                currentLocal as FirestoreObject
            )
            // Drop FieldValue sentinels we already committed: the server has
            // resolved them, so newSyncState is the truth. Without this a
            // sentinel never compares equal to its resolved value and would be
            // re-derived and re-written on every snapshot forever.
            dropCommittedSentinels(
                userEdits as Record<string, unknown>,
                committed as Record<string, unknown> | undefined
            )
            const rebasedLocalState = applyDiff(
                newSyncState as FirestoreObject,
                userEdits
            ) as Record<string, TData>

            // Deletes always win (Bug 2). A doc that existed in the baseline
            // but is gone from the server was deleted remotely → drop it and
            // any pending local edits to it, and never recreate it. This is
            // unconditional: classified against the baseline, not the rebased
            // result, so a stale local copy can't resurrect a deleted doc.
            for (const docId of Object.keys(prevSync)) {
                if (!(docId in newSyncState)) {
                    delete rebasedLocalState[docId]
                }
            }

            // Re-add ids (applyDiff may have introduced docs from the snapshot
            // and merged edits onto them).
            for (const [docId, docData] of Object.entries(rebasedLocalState)) {
                if (docData && typeof docData === 'object') {
                    ;(docData as Record<string, unknown>).id = docId
                }
            }

            // If the rebase leaves nothing that differs from the server, the
            // edits are fully absorbed → drop localState so isSynced flips back
            // to true and no redundant write is queued.
            state.localState = isDeepEqual(rebasedLocalState, newSyncState)
                ? undefined
                : rebasedLocalState
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

        const q = buildCollectionQuery(
            collectionRef,
            definitionConstraints,
            extraConstraints
        )

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
