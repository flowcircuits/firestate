import {
    collection,
    queryEqual,
    type CollectionReference,
    type Query,
    type QueryConstraint,
} from 'firebase/firestore'
import type {
    CollectionDefinition,
    CollectionHandle,
    CollectionState,
    DocumentDefinition,
    DocumentHandle,
    DocumentState,
    FirestoreObject,
    UpdateOptions,
} from '../types'
import type { FirestateStore } from './store'
import { markAtomicUpdateReadOnly } from './atomic'
import { createDocumentSubscription } from './document'
import {
    buildCollectionQuery,
    createCollectionSubscription,
} from './collection'

/**
 * Shared, ref-counted subscription registry.
 *
 * Every `useDocument` / `useCollection` call for the *same* resource — same
 * `(definition, resolved path, doc id / query)` — transparently
 * shares ONE underlying `createDocumentSubscription` / `createCollectionSubscription`
 * instance, and therefore one `onSnapshot` listener and one
 * reconciled/optimistic state. A write through any handle is instantly visible
 * to every reader on that resource, and the per-hook `selector` slices that one
 * shared state instead of building a private subscription per call.
 *
 * `readOnly` is deliberately NOT part of the key. It is a *per-handle
 * capability* over the shared state, not a state fork: a writable hook (the
 * typical provider — the sole writer, which needs full data for its undo bridge
 * and global sync tracking) and any number of `readOnly: true` hooks (leaves
 * that only read-select) resolve the SAME entry, so a write through the writable
 * handle is instantly visible to every read-only reader. The shared
 * subscription is always built writable; a read-only facade neuters its own
 * handle's writers (and `sync`) and leaves the shared undo flag untouched, while
 * passing reads straight through (see {@link readOnlyDocumentHandle}).
 *
 * Lifecycle is ref-counted and lazy:
 * - A facade is built when a hook resolves the resource (its render-phase
 *   `useMemo`): it reuses the already-registered shared entry if one exists, or
 *   builds a DETACHED entry (subscription created, no listener attached) left
 *   out of the registry. `getHandle()`/`load()` work off it either way.
 * - `acquire()` (called from the hook's `subscribe` effect) registers the entry
 *   on first lease — adopting whatever a sibling registered first — bumps the
 *   ref count, and registers the hook's change callback. Deferring registration
 *   to commit means an aborted/suspended/discarded render (whose effect never
 *   runs) leaves nothing stranded in the registry. `load()` activates the
 *   shared Firestore listener (idempotent — only the first activation attaches).
 * - The last lease to `release()` tears the listener down (the underlying
 *   `stop()`) and evicts the entry, so a subsequent mount starts a fresh
 *   subscription — a lazy collection resets to `isActive: false` exactly as a
 *   single hook does today.
 *
 * The registry is scoped per {@link FirestateStore} (a WeakMap keyed by store)
 * and within that per *definition* (a WeakMap keyed by the definition object).
 * Keying by definition — not just the resolved path string — means two distinct
 * definitions that happen to resolve to the same path keep independent
 * subscriptions (their schema/autosave config may differ), while every hook
 * built from one registry entry shares correctly. This matches the headline use
 * case: a registry resource is one definition object referenced everywhere.
 */

// `ReturnType<typeof fn>` resolves the generic to its `FirestoreObject`
// constraint, giving a concrete subscription shape we can store heterogeneously
// in the registry. Handles are cast back to the caller's `TData` at the facade
// boundary — sound because the data shape only narrows the same stored object.
type AnyDocumentSubscription = ReturnType<typeof createDocumentSubscription>
type AnyCollectionSubscription = ReturnType<typeof createCollectionSubscription>

/**
 * A registry entry: the shared subscription plus its lease bookkeeping.
 * `undoableEnabled` gates the entry's `onPushUndo` and is shared across all
 * leases (see {@link DocumentShared.setUndoable}).
 */
interface DocumentEntry {
    sub: AnyDocumentSubscription
    refCount: number
    undoableEnabled: boolean
    /**
     * False once the entry has been torn down (`sub.stop()` on release-to-zero).
     * A re-acquire of a non-live entry rebuilds `sub`, since `stop()` leaves
     * stale loaded/loading state (see {@link getDocumentShared}).
     */
    live: boolean
}

interface CollectionEntry {
    sub: AnyCollectionSubscription
    refCount: number
    undoableEnabled: boolean
    /** See {@link DocumentEntry.live}. */
    live: boolean
    /**
     * The query this entry's listener runs, built with
     * {@link buildCollectionQuery}. Used to match a prospective hook against
     * existing entries via Firestore's `queryEqual` — semantic query identity,
     * not array reference (see {@link getCollectionShared}).
     */
    query: Query<unknown>
}

interface StoreRegistry {
    docs: WeakMap<
        DocumentDefinition<FirestoreObject>,
        Map<string, DocumentEntry>
    >
    /**
     * Keyed by definition → `collectionPath` → bucket of entries that differ
     * only by query. A bucket is scanned with `queryEqual` to find the entry
     * for a given query; distinct queries on the same path live as separate
     * entries in the same bucket.
     */
    cols: WeakMap<
        CollectionDefinition<FirestoreObject>,
        Map<string, CollectionEntry[]>
    >
}

const registries = new WeakMap<FirestateStore, StoreRegistry>()

const getRegistry = (store: FirestateStore): StoreRegistry => {
    let reg = registries.get(store)
    if (!reg) {
        reg = { docs: new WeakMap(), cols: new WeakMap() }
        registries.set(store, reg)
    }
    return reg
}

// `readOnly` is intentionally absent from both keys: read-only and writable
// hooks on the same resource must resolve the SAME entry (one shared state).
const docKey = (collectionPath: string, docId: string): string =>
    `${collectionPath}\0${docId}`

const colBucketKey = (collectionPath: string): string => collectionPath

/**
 * Semantic query match, hardened for two cases the raw `queryEqual` does not
 * cover here: the same reference (the common case — a hook reuses its memoized
 * query) short-circuits true, and a `queryEqual` that throws (test harnesses
 * that mock the query builders pass non-`Query` placeholders) is treated as a
 * non-match rather than crashing the lookup.
 */
const sameQuery = (a: Query<unknown>, b: Query<unknown>): boolean => {
    if (a === b) return true
    try {
        return queryEqual(a, b)
    } catch {
        return false
    }
}

/** Push to the store-global undo manager, gated by the entry's shared flag. */
const makeOnPushUndo =
    (store: FirestateStore, entry: { undoableEnabled: boolean }) =>
    (undoAction: () => void, redoAction: () => void, opts?: UpdateOptions) => {
        if (!entry.undoableEnabled) return
        store.undoManager.push({
            undo: undoAction,
            redo: redoAction,
            groupId: opts?.undoGroupId,
            // Stamp the current router path so onNavigate can return the user
            // to where this write happened before reverting it. Merged groups
            // keep the newest action's path (see mergeGroupedActions).
            path: store.getUndoPath(),
        })
    }

// A read-only handle is the shared handle with its writers (and `sync`)
// replaced by no-ops. Reads — `data`, status, `ref`, and a collection's `load`
// (activating a lazy listener is a read, not a write) — pass straight through,
// so a read-only facade observes every optimistic edit the writer makes while
// being unable to author or flush a write itself.
const noop = (): void => {}
const asyncNoop = async (): Promise<void> => {}
const noopAdd = (): undefined => undefined

const readOnlyDocumentHandle = <T extends FirestoreObject>(
    handle: DocumentHandle<T>
): DocumentHandle<T> => {
    const readOnlyHandle = {
        ...handle,
        update: noop,
        set: noop,
        delete: noop,
        sync: asyncNoop,
    }
    markAtomicUpdateReadOnly(readOnlyHandle.update)
    return readOnlyHandle
}

const readOnlyCollectionHandle = <T extends FirestoreObject>(
    handle: CollectionHandle<T>
): CollectionHandle<T> => {
    const readOnlyHandle = {
        ...handle,
        update: noop,
        add: noopAdd,
        remove: noop,
        sync: asyncNoop,
    }
    markAtomicUpdateReadOnly(readOnlyHandle.update)
    return readOnlyHandle
}

/**
 * A per-hook facade over a shared registry entry. Multiple hooks on the same
 * resource hold distinct facades bound to the *same* entry, so `getHandle()`
 * returns the same identity-stable handle to all of them and `acquire()` /
 * `release()` ref-count one shared listener.
 */
export interface DocumentShared<T extends FirestoreObject> {
    /** The shared, identity-stable handle for this resource. */
    getHandle: () => DocumentHandle<T>
    /**
     * The shared, identity-stable full observable state (data + every status
     * flag, including `isSynced`). Passes through the read-only facade
     * unchanged — state carries no writers to neuter — so a status hook reads
     * the same state a writable hook does.
     */
    getState: () => DocumentState<T>
    /** Activate the shared Firestore listener (idempotent across leases). */
    load: () => void
    /** Set whether this resource records undo entries (shared across leases). */
    setUndoable: (enabled: boolean) => void
    /**
     * Register `onChange` and bump the ref count. Returns a release function
     * that unregisters it and, when it was the last lease, stops the listener
     * and evicts the entry. Release is idempotent.
     */
    acquire: (onChange: () => void) => () => void
}

export interface CollectionShared<T extends FirestoreObject> {
    getHandle: () => CollectionHandle<T>
    /** See {@link DocumentShared.getState}. */
    getState: () => CollectionState<T>
    load: () => void
    setUndoable: (enabled: boolean) => void
    acquire: (onChange: () => void) => () => void
}

export interface DocumentSharedParams<T extends FirestoreObject> {
    store: FirestateStore
    definition: DocumentDefinition<T>
    collectionPath: string
    docId: string
    /**
     * Per-handle read-only capability. Neuters only THIS facade's handle
     * writers; it is not part of the share key, so a read-only and a writable
     * hook on the same document share one listener and one optimistic state.
     */
    readOnly?: boolean
}

/**
 * Find or create the shared subscription for a document resource and return a
 * facade bound to it. Creating the entry attaches no listener. Intended to be
 * called from a hook's render-phase `useMemo`.
 */
export const getDocumentShared = <T extends FirestoreObject>({
    store,
    definition,
    collectionPath,
    docId,
    readOnly,
}: DocumentSharedParams<T>): DocumentShared<T> => {
    const map = getDocMap(store, definition)
    const key = docKey(collectionPath, docId)
    // Per-handle capability, resolved exactly as the subscription used to:
    // explicit hook override wins, then the definition default, then writable.
    // It gates ONLY this facade's handle — never the shared state or its key.
    const facadeReadOnly = readOnly ?? definition.readOnly ?? false

    // Build a fresh subscription bound to `entry`. Used for a newly built entry
    // and to revive an evicted one on re-acquire (its `sub` was stop()ed, which
    // leaves stale loaded/loading state).
    //
    // The shared subscription is ALWAYS writable: the provider (sole writer)
    // needs functional writers, and read-only facades neuter their own handle
    // rather than fork a separate read-only subscription. Passing
    // `readOnly: false` also overrides a read-only *definition*, so a hook that
    // opts back in with `readOnly: false` gets a writable handle off the same
    // shared state.
    const buildSub = (entry: DocumentEntry): AnyDocumentSubscription =>
        createDocumentSubscription({
            store,
            definition: definition as DocumentDefinition<FirestoreObject>,
            docId,
            collectionPath,
            readOnly: false,
            onPushUndo: makeOnPushUndo(store, entry),
        })

    const buildEntry = (): DocumentEntry => {
        const entry: DocumentEntry = {
            sub: null as unknown as AnyDocumentSubscription,
            refCount: 0,
            undoableEnabled: false,
            live: true,
        }
        entry.sub = buildSub(entry)
        return entry
    }

    // Reuse the already-registered shared entry if one exists; otherwise build a
    // DETACHED entry and leave it OUT of the map. Registration is deferred to
    // acquire() (commit time) so an aborted/suspended/discarded render — whose
    // effect, and therefore acquire()/release(), never runs — leaves no
    // refCount-0 entry stranded. getHandle()/load() operate on `ent` regardless.
    let ent: DocumentEntry = map.get(key) ?? buildEntry()
    let desiredUndoable = false
    // Memoize the neutered read-only handle on the underlying handle's identity,
    // so getHandle() stays referentially stable between notifies (a
    // useSyncExternalStore requirement) and rebuilds the wrapper only when the
    // shared subscription publishes a new handle.
    let readOnlySource: DocumentHandle<T> | null = null
    let readOnlyHandle: DocumentHandle<T> | null = null

    return {
        getHandle: () => {
            const handle = ent.sub.getHandle() as DocumentHandle<T>
            if (!facadeReadOnly) return handle
            if (handle !== readOnlySource) {
                readOnlySource = handle
                readOnlyHandle = readOnlyDocumentHandle(handle)
            }
            return readOnlyHandle as DocumentHandle<T>
        },
        getState: () => ent.sub.getState() as DocumentState<T>,
        load: () => ent.sub.load(),
        setUndoable: (enabled) => {
            // A read-only facade can't write, so it must not influence the
            // shared undo flag the writer relies on (last-writer-wins).
            if (facadeReadOnly) return
            desiredUndoable = enabled
            ent.undoableEnabled = enabled
        },
        acquire: (onChange) => {
            // Commit time: adopt the already-registered shared entry if one
            // exists (a sibling registered first, or this resource is still
            // live), else register ours. The map thus holds only committed
            // entries, each with refCount >= 1 — discarded renders leave nothing
            // behind. Revive a torn-down entry with a fresh sub (stop() leaves
            // stale state), honoring "a subsequent mount starts fresh".
            const committed = map.get(key)
            if (committed) {
                ent = committed
            } else {
                map.set(key, ent)
            }
            if (!ent.live) {
                ent.sub = buildSub(ent)
                ent.live = true
            }
            // Only writers set the shared undo flag; a read-only lease leaves it
            // as the writer (or default) left it (see setUndoable).
            if (!facadeReadOnly) ent.undoableEnabled = desiredUndoable
            ent.refCount++
            const notifyUnsub = ent.sub.subscribe(onChange)
            let released = false
            return () => {
                if (released) return
                released = true
                notifyUnsub()
                ent.refCount--
                if (ent.refCount <= 0) {
                    ent.sub.stop()
                    ent.live = false
                    if (map.get(key) === ent) map.delete(key)
                }
            }
        },
    }
}

const getDocMap = (
    store: FirestateStore,
    definition: DocumentDefinition<FirestoreObject>
): Map<string, DocumentEntry> => {
    const reg = getRegistry(store)
    let map = reg.docs.get(definition)
    if (!map) {
        map = new Map()
        reg.docs.set(definition, map)
    }
    return map
}

export interface CollectionSharedParams<T extends FirestoreObject> {
    store: FirestateStore
    definition: CollectionDefinition<T>
    collectionPath: string
    /** Per-handle read-only capability — see {@link DocumentSharedParams.readOnly}. */
    readOnly?: boolean
    /** Hook-level extra constraints, passed through to the subscription verbatim. */
    queryConstraints: QueryConstraint[] | undefined
    /**
     * The built query for this `(path, constraints)`, used to match existing
     * entries by semantic identity. Built by the caller (it can throw for
     * placeholder queries like an empty `in`); the caller only resolves a shared
     * entry when it is a valid, non-null query.
     */
    query: Query<unknown>
}

/**
 * Find or create the shared subscription whose query is `queryEqual` to
 * `params.query` and return a facade bound to it. Entries on the same path but
 * with a different query coexist in the same bucket.
 */
export const getCollectionShared = <T extends FirestoreObject>({
    store,
    definition,
    collectionPath,
    readOnly,
    queryConstraints,
    query,
}: CollectionSharedParams<T>): CollectionShared<T> => {
    const bucket = getColBucket(store, definition, collectionPath)
    // See getDocumentShared: per-handle capability, never part of the key.
    const facadeReadOnly = readOnly ?? definition.readOnly ?? false

    // Always writable — read-only facades neuter their own handle. See
    // getDocumentShared.buildSub for the full rationale.
    const buildSub = (entry: CollectionEntry): AnyCollectionSubscription =>
        createCollectionSubscription({
            store,
            definition: definition as CollectionDefinition<FirestoreObject>,
            collectionPath,
            readOnly: false,
            queryConstraints,
            onPushUndo: makeOnPushUndo(store, entry),
        })

    const buildEntry = (): CollectionEntry => {
        const entry: CollectionEntry = {
            sub: null as unknown as AnyCollectionSubscription,
            refCount: 0,
            undoableEnabled: false,
            live: true,
            query,
        }
        entry.sub = buildSub(entry)
        return entry
    }

    // Reuse the already-registered entry whose query matches; otherwise build a
    // DETACHED one and leave it OUT of the bucket. Registration is deferred to
    // acquire() so a discarded render leaves no refCount-0 entry behind —
    // important for collections, whose buckets are linearly scanned by every
    // lookup (see getDocumentShared for the full rationale).
    let ent: CollectionEntry =
        bucket.find((e) => sameQuery(e.query, query)) ?? buildEntry()
    let desiredUndoable = false
    // Memoize the neutered read-only handle on the underlying handle's identity.
    // See getDocumentShared.
    let readOnlySource: CollectionHandle<T> | null = null
    let readOnlyHandle: CollectionHandle<T> | null = null

    return {
        getHandle: () => {
            const handle = ent.sub.getHandle() as CollectionHandle<T>
            if (!facadeReadOnly) return handle
            if (handle !== readOnlySource) {
                readOnlySource = handle
                readOnlyHandle = readOnlyCollectionHandle(handle)
            }
            return readOnlyHandle as CollectionHandle<T>
        },
        getState: () => ent.sub.getState() as CollectionState<T>,
        load: () => ent.sub.load(),
        setUndoable: (enabled) => {
            // See getDocumentShared.setUndoable.
            if (facadeReadOnly) return
            desiredUndoable = enabled
            ent.undoableEnabled = enabled
        },
        acquire: (onChange) => {
            // Commit time: adopt the matching registered entry if one exists,
            // else register ours. The bucket thus holds only committed entries
            // (refCount >= 1). Revive a torn-down entry with a fresh sub. See
            // getDocumentShared.acquire for the full rationale.
            const committed = bucket.find((e) => sameQuery(e.query, query))
            if (committed) {
                ent = committed
            } else {
                bucket.push(ent)
            }
            if (!ent.live) {
                ent.sub = buildSub(ent)
                ent.live = true
            }
            // Only writers set the shared undo flag (see setUndoable).
            if (!facadeReadOnly) ent.undoableEnabled = desiredUndoable
            ent.refCount++
            const notifyUnsub = ent.sub.subscribe(onChange)
            let released = false
            return () => {
                if (released) return
                released = true
                notifyUnsub()
                ent.refCount--
                if (ent.refCount <= 0) {
                    ent.sub.stop()
                    ent.live = false
                    const idx = bucket.indexOf(ent)
                    if (idx !== -1) bucket.splice(idx, 1)
                }
            }
        },
    }
}

const getColBucket = (
    store: FirestateStore,
    definition: CollectionDefinition<FirestoreObject>,
    collectionPath: string
): CollectionEntry[] => {
    const reg = getRegistry(store)
    let byKey = reg.cols.get(definition)
    if (!byKey) {
        byKey = new Map()
        reg.cols.set(definition, byKey)
    }
    const key = colBucketKey(collectionPath)
    let bucket = byKey.get(key)
    if (!bucket) {
        bucket = []
        byKey.set(key, bucket)
    }
    return bucket
}

/**
 * Build the query a collection hook would subscribe to, or `null` when the
 * constraints cannot form a valid query (e.g. a gated empty-`in` placeholder
 * Firestore refuses to construct). The hook only resolves a shared entry when
 * this is non-null — matching the lazy-before-load and `enabled`-gating
 * contracts where no listener should run yet.
 */
export const buildSharedCollectionQuery = (
    store: FirestateStore,
    collectionPath: string,
    definitionConstraints: QueryConstraint[] | undefined,
    extraConstraints: QueryConstraint[] | undefined
): Query<unknown> | null => {
    const ref = collection(
        store.firestore,
        collectionPath
    ) as CollectionReference
    try {
        return buildCollectionQuery(
            ref,
            definitionConstraints,
            extraConstraints
        )
    } catch {
        return null
    }
}
