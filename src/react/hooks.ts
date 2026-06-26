import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useSyncExternalStore,
} from 'react'
import { useSyncExternalStoreWithSelector } from 'use-sync-external-store/shim/with-selector'
import { collection, queryEqual } from 'firebase/firestore'
import type {
    CollectionReference,
    Firestore,
    Query,
    QueryConstraint,
} from 'firebase/firestore'
import type {
    CollectionDefinition,
    CollectionHandle,
    CollectionState,
    DocumentDefinition,
    DocumentHandle,
    DocumentState,
    FirestoreObject,
    LoadingStatus,
    SelectedCollectionHandle,
    SelectedDocumentHandle,
    SyncStatus,
    UndoManager,
    UndoManagerState,
} from '../types'
import { valuesEqualForNoOp } from '../utils/diff'
import type { FirestateStore } from '../core/store'
import { buildCollectionQuery } from '../core/collection'
import {
    buildSharedCollectionQuery,
    getCollectionShared,
    getDocumentShared,
} from '../core/shared-subscription'

/**
 * Whether two hook-level `queryConstraints` arrays produce the same Firestore
 * query for a collection. `QueryConstraint` objects are opaque, so instead of
 * hand-rolling a deep compare we build both queries — with the same
 * `buildCollectionQuery` the subscription itself uses, so this check can never
 * drift from the query that actually runs — and defer to Firestore's own
 * `queryEqual`, which structurally compares filters, ordering, limits, and
 * cursors. This is what lets the subscription survive reference churn (e.g.
 * constraint inputs read from a deep-cloned document) while still rebuilding
 * when the query genuinely changes — no caller-supplied key.
 *
 * Building a query can throw: callers commonly gate with a deliberately invalid
 * placeholder like `where(documentId(), 'in', [])` while real IDs are pending,
 * and Firestore refuses to construct that. If building the prior snapshot
 * throws, no live listener could ever have run it, so there is nothing to
 * preserve — we treat the snapshots as unequal and let the caller adopt the
 * new constraints. This matters most for lazy collections, where a render can
 * carry such a placeholder before `load()` attaches any listener.
 */
const queryConstraintsEqual = (
    firestore: Firestore,
    collectionPath: string,
    definitionConstraints: QueryConstraint[] | undefined,
    a: QueryConstraint[] | undefined,
    b: QueryConstraint[] | undefined
): boolean => {
    if (a === b) return true
    const ref = collection(firestore, collectionPath) as CollectionReference
    try {
        return queryEqual(
            buildCollectionQuery(ref, definitionConstraints, a),
            buildCollectionQuery(ref, definitionConstraints, b)
        )
    } catch {
        return false
    }
}

/**
 * Returned when a hook is called with `enabled: false`. Module-level constants
 * so getSnapshot returns a stable reference and useSyncExternalStore doesn't
 * re-render. Cast at the call site to the generic handle type — every method
 * is a no-op so the cast is sound.
 */
const NOOP = () => {}
const ASYNC_NOOP = async () => {}
const EMPTY_RECORD: Record<string, never> = {}

const DISABLED_DOCUMENT_HANDLE: DocumentHandle<FirestoreObject> = {
    data: undefined,
    update: NOOP,
    set: NOOP,
    delete: NOOP,
    isLoaded: false,
    sync: ASYNC_NOOP,
    error: undefined,
    ref: undefined,
}

// The disabled add() satisfies both overloads but performs no work and
// returns undefined to match the bail-path contract from collection.ts.
// Consumers using `enabled: false` should not be calling mutation methods
// on the disabled handle.
const DISABLED_ADD = () => undefined

const DISABLED_COLLECTION_HANDLE: CollectionHandle<FirestoreObject> = {
    data: EMPTY_RECORD,
    update: NOOP,
    add: DISABLED_ADD,
    remove: NOOP,
    isLoaded: false,
    isActive: false,
    load: NOOP,
    sync: ASYNC_NOOP,
    error: undefined,
    ref: undefined,
}

// State snapshots for the disabled (`enabled: false`) path. A disabled resource
// is *idle*: not loading, not loaded, synced (no pending writes), no data/error.
// getStateSnapshot returns these so the selector — and the no-selector default
// projection — run against a consistent shape (e.g. a disabled sync-status hook
// yields `{ isSynced: true, isSaving: false }`, a disabled data handle
// `isLoaded: false`). `isLoaded` is set explicitly false because `!isLoading`
// would wrongly read as loaded here.
const DISABLED_DOCUMENT_STATE: DocumentState<FirestoreObject> = {
    data: undefined,
    isLoading: false,
    isLoaded: false,
    isSynced: true,
    error: undefined,
}

const DISABLED_COLLECTION_STATE: CollectionState<FirestoreObject> = {
    data: EMPTY_RECORD,
    isLoading: false,
    isLoaded: false,
    isSynced: true,
    isActive: false,
    error: undefined,
}

/**
 * Opts a {@link useDocument} call into a selected slice. The hook still returns
 * a full handle (writers, `ref`, status) — only `data` is narrowed to whatever
 * `selector` returns.
 */
export interface DocumentSelectorOptions<
    TData extends FirestoreObject,
    TSelected,
> {
    /**
     * Project the document's observable state down to the slice this component
     * reacts to. The selector receives the full {@link DocumentState} —
     * `{ data, isLoading, isLoaded, isSynced, error }`, where `data` is
     * `undefined` while the document is loading or the hook is disabled — and
     * the component
     * re-renders *only* when the returned slice changes (per `isEqual`). Status
     * is not a freebie: read `s.isLoading`/`s.isSynced`/`s.error` here if you
     * want to react to them (e.g. `s => ({ title: s.data?.title, saving:
     * !s.isSynced })`). What you select is exactly what re-renders, and the
     * returned handle exposes only the slice plus writers/`ref`.
     */
    selector: (state: DocumentState<TData>) => TSelected
    /**
     * Decide whether two consecutive slices are equal; the hook re-renders only
     * when this returns `false`. Defaults to a deep value comparison, so a
     * selector that returns a fresh object/array of the same shape does not
     * over-render. Pass {@link shallow} for a one-level compare, or a custom
     * comparator.
     */
    isEqual?: (a: TSelected, b: TSelected) => boolean
}

/**
 * Opts a {@link useCollection} call into a selected slice. See
 * {@link DocumentSelectorOptions}; the only difference is the selector receives
 * the collection's keyed record.
 */
export interface CollectionSelectorOptions<
    TData extends FirestoreObject,
    TSelected,
> {
    /**
     * Project the collection's observable state down to the slice this component
     * reacts to. The selector receives the full {@link CollectionState} —
     * `{ data, isLoading, isLoaded, isSynced, isActive, error }`, where `data` is
     * the keyed record (e.g. `s => s.data[id]` or `s => Object.keys(s.data)`) —
     * and the
     * component re-renders *only* when the returned slice changes. As with
     * {@link DocumentSelectorOptions.selector}, status is reactive only if you
     * select it, and the returned handle exposes just the slice plus
     * writers/`ref`.
     */
    selector: (state: CollectionState<TData>) => TSelected
    /** See {@link DocumentSelectorOptions.isEqual}. */
    isEqual?: (a: TSelected, b: TSelected) => boolean
}

/**
 * Shape used by the non-selector hook overload to *exclude* selector options,
 * so passing a real `selector` falls through to the selector overload (which
 * infers `TSelected`) instead of silently resolving to the full-data return.
 */
type WithoutSelector = { selector?: undefined; isEqual?: undefined }

/**
 * The projection used by the **no-selector (default) path** of each hook: the
 * *sync-agnostic* public view — `data` plus `isLoaded` and `error` (and a
 * collection's `isActive`; `undefined` for documents, so it no-ops in
 * {@link defaultSelectionEqual}). It deliberately OMITS `isSynced`, so a write
 * settling (the `isSynced` flip on every autosave) does NOT re-render a plain
 * data consumer — "just render the record" is the cheap default. Components that
 * render save state opt into the per-entry sync-status hook. The raw
 * `isLoading`/`isSynced` flags remain on the full state the selector path sees.
 *
 * It also omits the handle's methods and `ref`: those are read *live* from the
 * subscription in the final merge, never memoized here. If they rode along, a
 * subscription rebuild (id/path/query/enabled change) whose projection happened
 * to be value-equal would be collapsed by the equality check, and the hook would
 * keep returning the *previous* subscription's `load()`/`update()` — e.g. firing
 * against torn-down, empty-`in` constraints. This holds for the selector path
 * too, which is why it also reads methods/`ref` live.
 */
interface DefaultSelection<TSelected> {
    data: TSelected
    isLoaded: boolean
    error: Error | undefined
    isActive?: boolean
}

/**
 * Equality over a {@link DefaultSelection} (no-selector path): `isLoaded`,
 * `error`, and a collection's `isActive` compared by identity, the `data` slice
 * by `dataEqual` (the default value comparison). `isSynced` is absent by design,
 * so a sync flip cannot re-render the plain handle; a change to value-equal
 * `data` is still collapsed, while a load transition re-renders.
 */
const defaultSelectionEqual = <TSelected>(
    a: DefaultSelection<TSelected>,
    b: DefaultSelection<TSelected>,
    dataEqual: (a: TSelected, b: TSelected) => boolean
): boolean =>
    a.isLoaded === b.isLoaded &&
    a.error === b.error &&
    a.isActive === b.isActive &&
    dataEqual(a.data, b.data)

// Default slice comparison: the same value-based no-op compare the subscription
// itself uses (`valuesEqualForNoOp`), so an identity selector reproduces the
// pre-selector re-render behavior exactly, and a selector returning a fresh
// object does not over-render.
const defaultDataEqual = valuesEqualForNoOp as <TSelected>(
    a: TSelected,
    b: TSelected
) => boolean

/**
 * Context for providing the Firestate store
 */
export const FirestateContext = createContext<FirestateStore | null>(null)

/**
 * Hook to access the Firestate store
 */
export const useStore = (): FirestateStore => {
    const store = useContext(FirestateContext)
    if (!store) {
        throw new Error('useStore must be used within a FirestateProvider')
    }
    return store
}

/**
 * Hook to access the undo manager
 */
export const useUndoManager = (): UndoManager => {
    const store = useStore()
    const { undoManager } = store

    const subscribe = useCallback(
        (onStoreChange: () => void) => undoManager.subscribe(onStoreChange),
        [undoManager]
    )

    // Delegate to the manager's cached snapshot so getSnapshot returns a stable
    // reference across React's multiple per-commit calls. Building the snapshot
    // inline here would create a new object every call and trip the
    // "getSnapshot should be cached" warning + an infinite re-render loop.
    const getSnapshot = useCallback(
        (): UndoManagerState => undoManager.getState(),
        [undoManager]
    )

    const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

    return useMemo(
        () => ({
            ...state,
            push: undoManager.push,
            undo: undoManager.undo,
            redo: undoManager.redo,
            clear: undoManager.clear,
        }),
        [state, undoManager]
    )
}

/**
 * Hook to check if all tracked resources are synced
 */
export const useIsSynced = (): boolean => {
    const store = useStore()

    const subscribe = useCallback(
        (onChange: () => void) => store.subscribeToSyncState(() => onChange()),
        [store]
    )

    const getSnapshot = useCallback(() => store.isSynced, [store])

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Options for useDocument hook
 */
export interface UseDocumentOptions<TData extends FirestoreObject> {
    /** Document definition from defineDocument() */
    definition: DocumentDefinition<TData>
    /** Route/path parameters for dynamic paths */
    params?: Record<string, string>
    /** Override read-only setting */
    readOnly?: boolean
    /** Enable undo/redo for this document (default: true) */
    undoable?: boolean
    /**
     * If false, no subscription is created and a no-op handle is returned
     * (`{ data: undefined, isLoaded: false, ref: undefined }`). Use this to gate
     * subscriptions on route params that aren't ready yet. Default: true.
     */
    enabled?: boolean
}

/**
 * Hook to subscribe to a Firestore document with real-time updates.
 *
 * The subscription is keyed on the resolved document path (`definition` +
 * computed id). When that key changes — typically because `params` produces a
 * different id — the hook tears down the old Firestore listener and attaches a
 * new one. Toggling `undoable` does not rebuild the subscription.
 *
 * `readOnly` is a *per-handle capability*, not part of the key: a `readOnly`
 * hook shares the same listener and optimistic state as a writable hook on the
 * same document (a write through the writable handle is instantly visible to
 * the read-only reader), and only this handle's own writers (`update`/`set`/
 * `delete`) and `sync` are disabled.
 *
 * Use `enabled: false` to suppress the subscription entirely (e.g., when
 * route params aren't ready yet).
 *
 * **SSR.** On the server there is no Firestore listener, so this hook returns
 * the initial handle (`{ data: undefined, isLoaded: false }`). Mutations like
 * `update`/`set` will mutate orphaned local state with no effect — avoid
 * calling them server-side.
 *
 * The default handle is **sync-agnostic** — it carries `data`/`isLoaded`/`error`
 * but not `isSynced`, so it does not re-render when a write settles. Render save
 * state via the per-entry `use{Name}SyncStatus` hook, or fold `isSynced` into a
 * `selector`.
 *
 * @example
 * ```tsx
 * const projectDoc = defineDocument<Project>({
 *   collection: 'projects',
 *   id: (params) => params.projectId,
 * })
 *
 * function ProjectEditor({ projectId }: { projectId: string }) {
 *   const { data, update, isLoaded } = useDocument({
 *     definition: projectDoc,
 *     params: { projectId },
 *   })
 *
 *   if (!isLoaded) return <Spinner />
 *
 *   return (
 *     <input
 *       value={data?.name ?? ''}
 *       onChange={(e) => update({ name: e.target.value })}
 *     />
 *   )
 * }
 * ```
 */
export function useDocument<TData extends FirestoreObject>(
    options: UseDocumentOptions<TData> & WithoutSelector
): DocumentHandle<TData>
/**
 * Selector overload: pass `selector` to narrow the returned `data` to a slice
 * and re-render only when that slice changes. Writers (`update`/`set`/`delete`)
 * and `ref` keep operating on the full document. See
 * {@link DocumentSelectorOptions}.
 *
 * @example
 * ```tsx
 * // Re-renders only when the title changes, not on any other field.
 * const { data: title, update } = useDocument({
 *   definition: projectDoc,
 *   params: { projectId },
 *   selector: (s) => s.data?.title,
 * })
 * ```
 */
export function useDocument<TData extends FirestoreObject, TSelected>(
    options: UseDocumentOptions<TData> &
        DocumentSelectorOptions<TData, TSelected>
): SelectedDocumentHandle<TData, TSelected>
export function useDocument<TData extends FirestoreObject, TSelected>(
    options: UseDocumentOptions<TData> & {
        selector?: (state: DocumentState<TData>) => TSelected
        isEqual?: (a: TSelected, b: TSelected) => boolean
    }
): DocumentHandle<TData> | SelectedDocumentHandle<TData, TSelected> {
    const {
        definition,
        params = {},
        readOnly,
        undoable = true,
        enabled = true,
        selector,
        isEqual,
    } = options
    const store = useStore()

    // Resolve the doc id and collection path at render time. When disabled we
    // skip resolution — consumers commonly pass `enabled: false` precisely
    // because params aren't ready and definition.id(params) would fail.
    const docId = enabled
        ? typeof definition.id === 'function'
            ? definition.id(params)
            : definition.id
        : undefined

    const collectionPath = enabled
        ? typeof definition.collection === 'function'
            ? definition.collection(params)
            : definition.collection
        : undefined

    // Resolve (or create) the shared subscription for this resource. Every hook
    // targeting the same document shares one instance — and so one listener and
    // one optimistic state — instead of building a private subscription. Created
    // in render (no listener attached) so getSnapshot returns the real, live
    // handle immediately, including its `ref`.
    const shared = useMemo(
        () =>
            enabled && docId !== undefined && collectionPath !== undefined
                ? getDocumentShared<TData>({
                      store,
                      definition,
                      collectionPath,
                      docId,
                      readOnly,
                  })
                : null,
        [enabled, store, definition, docId, collectionPath, readOnly]
    )

    // Keep the shared subscription's undo flag in sync without re-subscribing
    // (toggling `undoable` must not tear the listener down). Last writer wins
    // across co-mounted hooks; the common case is a single value per resource.
    useEffect(() => {
        shared?.setUndoable(undoable)
    }, [shared, undoable])

    const subscribe = useCallback(
        (onChange: () => void) => {
            if (!shared) return NOOP
            shared.setUndoable(undoable)
            // Bump the shared ref count, register this hook's change callback, and
            // activate the listener. Release tears the listener down only when this
            // is the last lease (see shared-subscription.ts).
            const release = shared.acquire(onChange)
            // load() attaches the listener and can throw synchronously (e.g. an
            // invalid ref). acquire() has already taken the lease, so release it
            // before propagating — otherwise refCount sticks >=1, the entry is never
            // evicted, and the callback/listener leak (a later sibling on the same
            // key inherits the zombie entry).
            try {
                shared.load()
            } catch (e) {
                release()
                throw e
            }
            return release
        },
        // `undoable` intentionally omitted: the effect above syncs it without
        // resubscribing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [shared]
    )

    // The useSyncExternalStore snapshot is the full observable STATE (data +
    // every status flag, including isSynced). The selector projects from it; the
    // no-selector path projects the sync-agnostic default. getState() is
    // identity-stable between notifies, as useSyncExternalStore requires.
    const getStateSnapshot = useCallback(
        () =>
            shared
                ? shared.getState()
                : (DISABLED_DOCUMENT_STATE as DocumentState<TData>),
        [shared]
    )

    // The live handle, read for writers and `ref` only. Kept separate from the
    // state snapshot so re-renders gate on the projected slice while methods/ref
    // always come from the CURRENT subscription — a rebuild whose slice is
    // value-equal still hands back the new subscription's methods (this callback's
    // identity changes with `shared`, re-running the merge memo).
    const getHandle = useCallback(
        () =>
            shared
                ? shared.getHandle()
                : (DISABLED_DOCUMENT_HANDLE as DocumentHandle<TData>),
        [shared]
    )

    // Project the state snapshot to the value that drives re-renders. Keyed on
    // `selector` so a referentially-new selector re-projects; an inline selector
    // still dedupes against the committed value via `equal`, so callers need not
    // memoize it.
    //
    // With a `selector` (pure mode): the projection IS the selector's output over
    // the full state, gated purely by `equal`, so a status field it ignores (e.g.
    // isSynced) can neither re-render the component nor appear on its handle.
    // Without one: the sync-agnostic default — data + isLoaded + error — so a
    // write settling does not re-render.
    const select = useCallback(
        (
            state: DocumentState<TData>
        ): TSelected | DefaultSelection<TData | undefined> =>
            selector
                ? selector(state)
                : {
                      data: state.data,
                      isLoaded: state.isLoaded,
                      error: state.error,
                  },
        [selector]
    )

    const equal = useCallback(
        (
            a: TSelected | DefaultSelection<TData | undefined>,
            b: TSelected | DefaultSelection<TData | undefined>
        ): boolean =>
            selector
                ? (isEqual ?? defaultDataEqual)(a as TSelected, b as TSelected)
                : defaultSelectionEqual(
                      a as DefaultSelection<TData | undefined>,
                      b as DefaultSelection<TData | undefined>,
                      defaultDataEqual
                  ),
        [selector, isEqual]
    )

    const selection = useSyncExternalStoreWithSelector(
        subscribe,
        getStateSnapshot,
        getStateSnapshot,
        select,
        equal
    )

    // Re-wrap into a handle. Methods and `ref` are read *live* via getHandle()
    // (keyed on `shared`) so a rebuild always hands back the new subscription's
    // methods even when the projection was value-equal (see DefaultSelection).
    //
    // Keyed on selector *presence*, never its identity: an inline selector is a
    // fresh function each render yet yields a value-equal `selection`, so the
    // handle must keep referential identity (callers need not memoize it). Only
    // the handle's shape — selected vs full — depends on the selector.
    const hasSelector = selector != null
    return useMemo(() => {
        const handle = getHandle()
        if (hasSelector) {
            // Pure selected handle: `data` is the slice; status is intentionally
            // absent (select it to react to it). Writers act on the full doc.
            return {
                data: selection as TSelected,
                update: handle.update,
                set: handle.set,
                delete: handle.delete,
                sync: handle.sync,
                ref: handle.ref,
            }
        }
        // Default handle: sync-agnostic — data + isLoaded + error (no isSynced).
        const s = selection as DefaultSelection<TData | undefined>
        return {
            data: s.data,
            update: handle.update,
            set: handle.set,
            delete: handle.delete,
            isLoaded: s.isLoaded,
            sync: handle.sync,
            error: s.error,
            ref: handle.ref,
        }
    }, [selection, getHandle, hasSelector])
}

/**
 * Options for useCollection hook
 */
export interface UseCollectionOptions<TData extends FirestoreObject> {
    /** Collection definition from defineCollection() */
    definition: CollectionDefinition<TData>
    /** Route/path parameters for dynamic paths */
    params?: Record<string, string>
    /** Override read-only setting */
    readOnly?: boolean
    /** Additional query constraints */
    queryConstraints?: QueryConstraint[]
    /** Enable undo/redo for this collection (default: true) */
    undoable?: boolean
    /**
     * If false, no subscription is created and a no-op handle is returned
     * (`{ data: {}, isLoaded: false, isActive: false }`). Use this to gate on
     * route params that aren't ready yet. Default: true.
     */
    enabled?: boolean
}

/**
 * Hook to subscribe to a Firestore collection with real-time updates.
 *
 * The subscription is keyed on the resolved collection path and the *semantic
 * identity* of `queryConstraints`. When either changes, the listener is torn
 * down and re-attached with the new query. Toggling `undoable` does not rebuild
 * the subscription. `readOnly` is a per-handle capability, not part of the key —
 * a `readOnly` hook shares one listener and optimistic state with a writable
 * hook on the same query (see {@link useDocument}).
 *
 * **You do not need to memoize `queryConstraints`.** `QueryConstraint` objects
 * are opaque, so Firestate compares the *built query* with Firestore's own
 * `queryEqual` instead of comparing array references. A fresh array that
 * produces the same query (e.g. constraint inputs read from a document that
 * Firestate deep-clones on optimistic updates) does not rebuild the listener;
 * only a genuine change to the query does:
 *
 * ```tsx
 * // stationIds may change reference on every edit to its parent document,
 * // even when its contents are unchanged — the listener survives anyway.
 * const stations = useCollection({
 *   definition: weatherStations,
 *   queryConstraints: [where(documentId(), 'in', stationIds)],
 * })
 * ```
 *
 * Memoizing is still a fine micro-optimization (it skips the per-render query
 * build + compare via the reference fast-path), but it is no longer required
 * for listener stability.
 *
 * Use `enabled: false` to suppress the subscription entirely (e.g., when
 * route params aren't ready yet).
 *
 * **SSR.** On the server there is no Firestore listener, so this hook returns
 * the initial handle (`{ data: {}, isLoaded: false }`, `isActive: false` for
 * lazy). Avoid calling mutations server-side.
 *
 * Like {@link useDocument}, the default handle is **sync-agnostic** — `data`,
 * `isLoaded`, `isActive`, `error`, but not `isSynced`. `isActive` stays so a
 * lazy collection can gate a "Load" button; `isLoaded` is `isActive &&
 * !isLoading`. Render save state via `use{Name}SyncStatus`.
 *
 * @example
 * ```tsx
 * const spacesCollection = defineCollection<Space>({
 *   path: (params) => `projects/${params.projectId}/spaces`,
 *   lazy: true,
 * })
 *
 * function SpacesList({ projectId }: { projectId: string }) {
 *   const { data, update, load, isActive, isLoaded } = useCollection({
 *     definition: spacesCollection,
 *     params: { projectId },
 *   })
 *
 *   // Lazy load on mount
 *   useEffect(() => { load() }, [load])
 *
 *   if (!isActive) return <Button onClick={load}>Load Spaces</Button>
 *   if (!isLoaded) return <Spinner />
 *
 *   return (
 *     <ul>
 *       {Object.values(data).map((space) => (
 *         <li key={space.id}>{space.name}</li>
 *       ))}
 *     </ul>
 *   )
 * }
 * ```
 */
export function useCollection<TData extends FirestoreObject>(
    options: UseCollectionOptions<TData> & WithoutSelector
): CollectionHandle<TData>
/**
 * Selector overload: pass `selector` to narrow the returned `data` to a slice
 * of the collection and re-render only when that slice changes. Writers
 * (`update`/`add`/`remove`) and `ref` keep operating on the full collection.
 * See {@link CollectionSelectorOptions}.
 *
 * @example
 * ```tsx
 * // Re-renders only when this one document's slice changes.
 * const { data: space } = useCollection({
 *   definition: spacesCollection,
 *   params: { projectId },
 *   selector: (s) => s.data[spaceId],
 * })
 * ```
 */
export function useCollection<TData extends FirestoreObject, TSelected>(
    options: UseCollectionOptions<TData> &
        CollectionSelectorOptions<TData, TSelected>
): SelectedCollectionHandle<TData, TSelected>
export function useCollection<TData extends FirestoreObject, TSelected>(
    options: UseCollectionOptions<TData> & {
        selector?: (state: CollectionState<TData>) => TSelected
        isEqual?: (a: TSelected, b: TSelected) => boolean
    }
): CollectionHandle<TData> | SelectedCollectionHandle<TData, TSelected> {
    const {
        definition,
        params = {},
        readOnly,
        queryConstraints,
        undoable = true,
        enabled = true,
        selector,
        isEqual,
    } = options
    const store = useStore()

    // Resolve the collection path at render time. When disabled we skip
    // resolution — consumers commonly pass `enabled: false` precisely because
    // params aren't ready.
    const collectionPath = enabled
        ? typeof definition.path === 'function'
            ? definition.path(params)
            : definition.path
        : undefined

    // Stabilize `queryConstraints` by *query identity*. QueryConstraint objects
    // are opaque and can't be deep-compared directly, but the built query can —
    // see queryConstraintsEqual(). When the incoming array produces the same
    // query as the one we're already subscribed with (e.g. constraint inputs
    // read from a deep-cloned document churned the array reference without
    // changing the query), we keep the previous array reference so the memo
    // below does not rebuild. A genuine change adopts the new reference and
    // re-attaches the listener. When the path is unresolved we can't build a
    // query, so we just pass the constraints through (the memo returns null).
    //
    // The comparison may only run against constraints captured during an *active*
    // render (enabled with a resolved path). Constraints captured while disabled
    // or unresolved can be ones the caller is gating precisely because they don't
    // form a valid query yet — e.g. `where(documentId(), 'in', [])`, which
    // Firestore refuses to build. Building such a stale snapshot just to compare
    // would throw, so when the prior snapshot wasn't active we adopt the current
    // constraints outright. There is no live listener to preserve in that case
    // (the subscription was null), so adopting a fresh reference costs nothing.
    const stableConstraintsRef = useRef(queryConstraints)
    const stableActiveRef = useRef(false)
    const active = enabled && collectionPath !== undefined
    if (
        collectionPath === undefined ||
        !stableActiveRef.current ||
        !queryConstraintsEqual(
            store.firestore,
            collectionPath,
            definition.queryConstraints,
            stableConstraintsRef.current,
            queryConstraints
        )
    ) {
        stableConstraintsRef.current = queryConstraints
    }
    stableActiveRef.current = active
    const stableConstraints = stableConstraintsRef.current

    const isLazy = definition.lazy ?? false

    // Build the query this hook subscribes to, keyed by *query identity*
    // (stableConstraints already absorbs reference churn). This is what the shared
    // registry matches on via `queryEqual`, so two hooks with semantically equal
    // queries share one listener regardless of array identity. `null` when the
    // constraints can't form a valid query yet (e.g. a gated empty-`in`
    // placeholder, or while disabled/unresolved): no listener can run, so the hook
    // resolves no shared entry and returns the disabled handle.
    const builtQuery = useMemo<Query<unknown> | null>(
        () =>
            active
                ? buildSharedCollectionQuery(
                      store,
                      collectionPath!,
                      definition.queryConstraints,
                      stableConstraints
                  )
                : null,
        [active, store, collectionPath, definition, stableConstraints]
    )

    // Resolve (or create) the shared subscription for this resource+query. As with
    // useDocument, every hook on the same collection+query shares one instance.
    const shared = useMemo(
        () =>
            active && builtQuery !== null
                ? getCollectionShared<TData>({
                      store,
                      definition,
                      collectionPath: collectionPath!,
                      readOnly,
                      queryConstraints: stableConstraints,
                      query: builtQuery,
                  })
                : null,
        [
            active,
            store,
            definition,
            collectionPath,
            readOnly,
            stableConstraints,
            builtQuery,
        ]
    )

    useEffect(() => {
        shared?.setUndoable(undoable)
    }, [shared, undoable])

    const subscribe = useCallback(
        (onChange: () => void) => {
            if (!shared) return NOOP
            shared.setUndoable(undoable)
            const release = shared.acquire(onChange)
            // Lazy collections activate the shared listener only via `load()` on the
            // handle; non-lazy ones activate on mount. Either way the listener stays
            // up until the last lease releases.
            if (!isLazy) {
                // See useDocument's subscribe: release the lease acquire() just took if
                // load() throws synchronously, or the entry/listener/callback leak.
                try {
                    shared.load()
                } catch (e) {
                    release()
                    throw e
                }
            }
            return release
        },
        // `undoable` intentionally omitted: the effect above syncs it without
        // resubscribing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [shared, isLazy]
    )

    // Snapshot is the full collection STATE; the live handle is read separately
    // for writers/`load`/`ref`. See useDocument for the full rationale.
    const getStateSnapshot = useCallback(
        () =>
            shared
                ? shared.getState()
                : (DISABLED_COLLECTION_STATE as CollectionState<TData>),
        [shared]
    )

    const getHandle = useCallback(
        () =>
            shared
                ? shared.getHandle()
                : (DISABLED_COLLECTION_HANDLE as CollectionHandle<TData>),
        [shared]
    )

    // See useDocument. With a `selector`: project the full state. Without one:
    // the sync-agnostic default — data + isLoaded + isActive + error (no
    // isSynced). `isActive` stays so lazy collections can gate a "Load" button.
    const select = useCallback(
        (
            state: CollectionState<TData>
        ): TSelected | DefaultSelection<Record<string, TData>> =>
            selector
                ? selector(state)
                : {
                      data: state.data,
                      isLoaded: state.isLoaded,
                      isActive: state.isActive,
                      error: state.error,
                  },
        [selector]
    )

    const equal = useCallback(
        (
            a: TSelected | DefaultSelection<Record<string, TData>>,
            b: TSelected | DefaultSelection<Record<string, TData>>
        ): boolean =>
            selector
                ? (isEqual ?? defaultDataEqual)(a as TSelected, b as TSelected)
                : defaultSelectionEqual(
                      a as DefaultSelection<Record<string, TData>>,
                      b as DefaultSelection<Record<string, TData>>,
                      defaultDataEqual
                  ),
        [selector, isEqual]
    )

    const selection = useSyncExternalStoreWithSelector(
        subscribe,
        getStateSnapshot,
        getStateSnapshot,
        select,
        equal
    )

    // See useDocument: keyed on selector *presence*, not identity, so an inline
    // selector still yields a stable handle. Methods/`ref` read live from
    // getHandle; only the handle's shape depends on the selector.
    const hasSelector = selector != null
    return useMemo(() => {
        const handle = getHandle()
        if (hasSelector) {
            // Pure selected handle: status is absent (select it to react to it);
            // writers and `load` act on the full collection.
            return {
                data: selection as TSelected,
                update: handle.update,
                add: handle.add,
                remove: handle.remove,
                load: handle.load,
                sync: handle.sync,
                ref: handle.ref,
            }
        }
        // Default handle: sync-agnostic — data + isLoaded + isActive + error.
        const s = selection as DefaultSelection<Record<string, TData>>
        return {
            data: s.data,
            update: handle.update,
            add: handle.add,
            remove: handle.remove,
            isLoaded: s.isLoaded,
            isActive: s.isActive ?? false,
            load: handle.load,
            sync: handle.sync,
            error: s.error,
            ref: handle.ref,
        }
    }, [selection, getHandle, hasSelector])
}

// ---------------------------------------------------------------------------
// Per-resource status hooks (sync / loading)
//
// Thin readers over useDocument / useCollection with a fixed selector. Because
// sharing is keyed by (definition, path, query) — not readOnly, not the selector
// — these resolve the SAME shared entry as the data hook, so opting into status
// adds NO listener and reads the same optimistic state. They return the projected
// slice directly (no handle wrapper).
// ---------------------------------------------------------------------------

// Module-level selectors: stable identity keeps the underlying hook's `select`
// callback stable. Each returns a fresh object, but the default value compare
// (two booleans) collapses it, so a status hook re-renders only on a real flip.
// Typed structurally on just the field read, so one selector serves both the
// DocumentState and CollectionState selector slots.
const syncStatusSelector = (state: { isSynced: boolean }): SyncStatus => ({
    isSynced: state.isSynced,
    isSaving: !state.isSynced,
})

const loadingStatusSelector = (state: {
    isLoading: boolean
    isLoaded: boolean
}): LoadingStatus => ({
    isLoading: state.isLoading,
    isLoaded: state.isLoaded,
})

/** Options for the document status hooks (a subset of {@link UseDocumentOptions}). */
export interface UseDocumentStatusOptions<TData extends FirestoreObject> {
    /** Document definition from defineDocument(). */
    definition: DocumentDefinition<TData>
    /** Route/path parameters for dynamic paths. */
    params?: Record<string, string>
    /**
     * If false, no subscription is created and the idle status is returned
     * (`{ isSynced: true, isSaving: false }` / `{ isLoading: false, isLoaded:
     * false }`). Default: true.
     */
    enabled?: boolean
}

/** Options for the collection status hooks. Adds `queryConstraints`. */
export interface UseCollectionStatusOptions<TData extends FirestoreObject> {
    /** Collection definition from defineCollection(). */
    definition: CollectionDefinition<TData>
    /** Route/path parameters for dynamic paths. */
    params?: Record<string, string>
    /**
     * Query constraints. Must produce the same query the data hook uses, or the
     * status hook resolves a *different* shared entry (a second listener) —
     * sharing is keyed by semantic query identity.
     */
    queryConstraints?: QueryConstraint[]
    /** See {@link UseDocumentStatusOptions.enabled}. */
    enabled?: boolean
}

/**
 * Subscribe to a document's **sync status only** — `{ isSynced, isSaving }`.
 *
 * The opt-in counterpart to the sync-agnostic default handle (see
 * {@link DocumentHandle}): it re-renders when sync state flips but never on data
 * changes, and shares the resource's one `onSnapshot` listener with
 * `useDocument` and any slice hooks, so opting in adds no listener. While
 * disabled it reports `{ isSynced: true, isSaving: false }`.
 */
export function useDocumentSyncStatus<TData extends FirestoreObject>(
    options: UseDocumentStatusOptions<TData>
): SyncStatus {
    return useDocument({
        definition: options.definition,
        params: options.params,
        enabled: options.enabled,
        readOnly: true,
        selector: syncStatusSelector,
    }).data
}

/**
 * Subscribe to a document's **loading status only** — `{ isLoading, isLoaded }`.
 *
 * A spinner channel that shares the resource's listener and does NOT re-render
 * on data changes — for a progress indicator rendered apart from the data. The
 * data handle keeps `isLoaded` for the common render path; this is an extra
 * channel, not a replacement.
 */
export function useDocumentLoadingStatus<TData extends FirestoreObject>(
    options: UseDocumentStatusOptions<TData>
): LoadingStatus {
    return useDocument({
        definition: options.definition,
        params: options.params,
        enabled: options.enabled,
        readOnly: true,
        selector: loadingStatusSelector,
    }).data
}

/**
 * Collection counterpart of {@link useDocumentSyncStatus} — `{ isSynced,
 * isSaving }` over a collection query, sharing its one listener.
 *
 * **Lazy caveat.** On a `lazy` collection this hook never calls `load()` itself:
 * activating a lazy listener is the data hook's job, and a passive status reader
 * must not silently start the listener (and bill the reads) the laziness exists
 * to defer. As the *lone* subscriber it therefore attaches no listener and stays
 * at the idle `{ isSynced: true, isSaving: false }`. Mount it alongside a
 * {@link useCollection} on the same query whose `load()` has run — the status
 * hook rides that one shared listener and reports real sync state. Non-lazy
 * collections activate on mount, so this hook works standalone there.
 */
export function useCollectionSyncStatus<TData extends FirestoreObject>(
    options: UseCollectionStatusOptions<TData>
): SyncStatus {
    return useCollection({
        definition: options.definition,
        params: options.params,
        queryConstraints: options.queryConstraints,
        enabled: options.enabled,
        readOnly: true,
        selector: syncStatusSelector,
    }).data
}

/**
 * Collection counterpart of {@link useDocumentLoadingStatus} — `{ isLoading,
 * isLoaded }` over a collection query, sharing its one listener.
 *
 * Same lazy caveat as {@link useCollectionSyncStatus}: on a `lazy` collection it
 * never calls `load()`, so as the lone subscriber it attaches no listener and
 * stays at the idle `{ isLoading: false, isLoaded: false }` until a co-mounted
 * {@link useCollection} (or any active hook on the same query) activates the
 * shared listener via `load()`. Non-lazy collections activate on mount.
 */
export function useCollectionLoadingStatus<TData extends FirestoreObject>(
    options: UseCollectionStatusOptions<TData>
): LoadingStatus {
    return useCollection({
        definition: options.definition,
        params: options.params,
        queryConstraints: options.queryConstraints,
        enabled: options.enabled,
        readOnly: true,
        selector: loadingStatusSelector,
    }).data
}

/**
 * Keyboard shortcut hook for undo/redo
 *
 * @example
 * ```tsx
 * function App() {
 *   useUndoKeyboardShortcuts()
 *   return <YourApp />
 * }
 * ```
 */
export const useUndoKeyboardShortcuts = (): void => {
    // Read the manager ref directly — we only need .undo() / .redo() (stable
    // refs), not its state. Subscribing via useUndoManager would re-render
    // the host component on every undo-stack change.
    const undoManager = useStore().undoManager

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const platform =
                (
                    navigator as Navigator & {
                        userAgentData?: { platform: string }
                    }
                ).userAgentData?.platform ?? navigator.platform
            const isMac = platform.toUpperCase().includes('MAC')
            const modifier = isMac ? e.metaKey : e.ctrlKey

            if (!modifier) return

            if (e.key === 'z' && !e.shiftKey) {
                e.preventDefault()
                undoManager.undo()
            } else if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
                e.preventDefault()
                undoManager.redo()
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [undoManager])
}
