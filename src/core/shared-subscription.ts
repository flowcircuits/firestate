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
    DocumentDefinition,
    DocumentHandle,
    FirestoreObject,
    UpdateOptions,
} from '../types'
import type { FirestateStore } from './store'
import { createDocumentSubscription } from './document'
import {
    buildCollectionQuery,
    createCollectionSubscription,
} from './collection'

/**
 * Shared, ref-counted subscription registry.
 *
 * Every `useDocument` / `useCollection` call for the *same* resource — same
 * `(definition, resolved path, doc id / query, readOnly)` — transparently
 * shares ONE underlying `createDocumentSubscription` / `createCollectionSubscription`
 * instance, and therefore one `onSnapshot` listener and one
 * reconciled/optimistic state. A write through any handle is instantly visible
 * to every reader on that resource, and the per-hook `selector` slices that one
 * shared state instead of building a private subscription per call.
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
 * subscriptions (their schema/autosave/readOnly config may differ), while every
 * hook built from one registry entry shares correctly. This matches the headline
 * use case: a registry resource is one definition object referenced everywhere.
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
     * Keyed by definition → `${collectionPath}\0${readOnly}` → bucket of entries
     * that differ only by query. A bucket is scanned with `queryEqual` to find
     * the entry for a given query; distinct queries on the same path live as
     * separate entries in the same bucket.
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

const docKey = (
    collectionPath: string,
    docId: string,
    readOnly: boolean | undefined
): string => `${collectionPath}\0${docId}\0${readOnly ? 1 : 0}`

const colBucketKey = (
    collectionPath: string,
    readOnly: boolean | undefined
): string => `${collectionPath}\0${readOnly ? 1 : 0}`

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
        })
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
    load: () => void
    setUndoable: (enabled: boolean) => void
    acquire: (onChange: () => void) => () => void
}

export interface DocumentSharedParams<T extends FirestoreObject> {
    store: FirestateStore
    definition: DocumentDefinition<T>
    collectionPath: string
    docId: string
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
    const key = docKey(collectionPath, docId, readOnly)

    // Build a fresh subscription bound to `entry`. Used for a newly built entry
    // and to revive an evicted one on re-acquire (its `sub` was stop()ed, which
    // leaves stale loaded/loading state).
    const buildSub = (entry: DocumentEntry): AnyDocumentSubscription =>
        createDocumentSubscription({
            store,
            definition: definition as DocumentDefinition<FirestoreObject>,
            docId,
            collectionPath,
            readOnly,
            onPushUndo: makeOnPushUndo(store, entry),
        })

    const buildEntry = (): DocumentEntry => {
        const entry: DocumentEntry = {
            sub: null as unknown as AnyDocumentSubscription,
            refCount: 0,
            undoableEnabled: true,
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
    let desiredUndoable = true

    return {
        getHandle: () => ent.sub.getHandle() as DocumentHandle<T>,
        load: () => ent.sub.load(),
        setUndoable: (enabled) => {
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
            ent.undoableEnabled = desiredUndoable
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
    const bucket = getColBucket(store, definition, collectionPath, readOnly)

    const buildSub = (entry: CollectionEntry): AnyCollectionSubscription =>
        createCollectionSubscription({
            store,
            definition: definition as CollectionDefinition<FirestoreObject>,
            collectionPath,
            readOnly,
            queryConstraints,
            onPushUndo: makeOnPushUndo(store, entry),
        })

    const buildEntry = (): CollectionEntry => {
        const entry: CollectionEntry = {
            sub: null as unknown as AnyCollectionSubscription,
            refCount: 0,
            undoableEnabled: true,
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
    let desiredUndoable = true

    return {
        getHandle: () => ent.sub.getHandle() as CollectionHandle<T>,
        load: () => ent.sub.load(),
        setUndoable: (enabled) => {
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
            ent.undoableEnabled = desiredUndoable
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
    collectionPath: string,
    readOnly: boolean | undefined
): CollectionEntry[] => {
    const reg = getRegistry(store)
    let byKey = reg.cols.get(definition)
    if (!byKey) {
        byKey = new Map()
        reg.cols.set(definition, byKey)
    }
    const key = colBucketKey(collectionPath, readOnly)
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
