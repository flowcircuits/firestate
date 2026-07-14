import type {
    CollectionReference,
    DocumentReference,
    Firestore,
    QueryConstraint,
    WithFieldValue,
} from 'firebase/firestore'
import type { ZodType } from 'zod'

/**
 * Deep partial type that works with Records and nested objects
 */
export type DeepPartial<T> = T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T

/**
 * A generic object that can be stored in Firestore.
 *
 * Uses an `any` index signature (matching Firestore's own `DocumentData`) so
 * that plain TypeScript interfaces — which lack an implicit index signature —
 * can satisfy the constraint. Internal call sites cast through more specific
 * types where needed.
 */
export type FirestoreObject = Record<string, any>

/**
 * Options for update operations
 */
export interface UpdateOptions {
    /** If false, prevents this update from being added to undo stack */
    undoable?: boolean
    /** Group multiple updates into a single undo action */
    undoGroupId?: string
}

/**
 * The full observable state of a document subscription — what a hook `selector`
 * receives. Carries every status flag (including `isSynced`, which the default
 * data handle deliberately omits) so a selector can react to exactly the slice
 * it reads.
 */
export interface DocumentState<T> {
    /** Current merged state (local changes applied to sync state) */
    data: T | undefined
    /** Whether the initial snapshot has not arrived yet */
    isLoading: boolean
    /**
     * Whether the initial snapshot has arrived and data is ready to render — the
     * completion of {@link DocumentState.isLoading} (`!isLoading` for a live
     * subscription; `false` while the hook is disabled).
     */
    isLoaded: boolean
    /** Whether all local changes have synced to Firestore (no pending writes) */
    isSynced: boolean
    /** Error from listener, if any */
    error: Error | undefined
}

/**
 * The full observable state of a collection subscription — what a hook
 * `selector` receives. See {@link DocumentState}.
 */
export interface CollectionState<T> {
    /** Current merged state keyed by document ID */
    data: Record<string, T>
    /** Whether the initial snapshot has not arrived yet */
    isLoading: boolean
    /**
     * Whether the collection is active and its initial snapshot has arrived —
     * `isActive && !isLoading`. `false` for a lazy collection before `load()`,
     * and while the hook is disabled.
     */
    isLoaded: boolean
    /** Whether all local changes have synced to Firestore (no pending writes) */
    isSynced: boolean
    /** Whether the collection has been activated (for lazy loading) */
    isActive: boolean
    /** Error from listener, if any */
    error: Error | undefined
}

/**
 * Sync status of a single resource, returned by the per-entry
 * `use{Name}SyncStatus` hook. Opt-in: only components that render save/dirty
 * state subscribe to it, so the common data path does not re-render when a write
 * settles. Shares the resource's one `onSnapshot` listener.
 */
export interface SyncStatus {
    /** Whether all local changes have synced to Firestore (no pending writes) */
    isSynced: boolean
    /** Whether there are pending local changes still being saved (`!isSynced`) */
    isSaving: boolean
}

/**
 * Loading status of a single resource, returned by the per-entry
 * `use{Name}LoadingStatus` hook. A spinner-only channel: it re-renders on load
 * transitions but never on data changes. Shares the resource's listener.
 */
export interface LoadingStatus {
    /** Whether the initial snapshot has not arrived yet */
    isLoading: boolean
    /** Whether the initial snapshot has arrived (the completion of `isLoading`) */
    isLoaded: boolean
}

/**
 * Document handle returned by the `useDocument` hook.
 *
 * **Sync-agnostic by default.** The handle carries `data`, `isLoaded`, `error`,
 * the writers, and `ref` — but NOT `isSynced`. A document hook therefore does
 * not re-render when a write settles (the `isSynced` flip on every autosave),
 * so "just render the record" is the cheap, default path. Components that
 * actually render save/dirty state opt into the per-entry `use{Name}SyncStatus`
 * hook ({@link SyncStatus}), which shares the same listener. The raw
 * `isLoading`/`isSynced` flags remain on {@link DocumentState} for selectors.
 */
export interface DocumentHandle<T extends FirestoreObject> {
    /** Current document data */
    data: T | undefined
    /** Update the document with a partial diff */
    update: (
        diff: WithFieldValue<DeepPartial<T>>,
        options?: UpdateOptions
    ) => void
    /** Set the document data (creates or overwrites) */
    set: (data: T, options?: UpdateOptions) => void
    /** Delete the document */
    delete: (options?: UpdateOptions) => void
    /**
     * Whether the initial snapshot has arrived and data is ready to render — the
     * completion of `isLoading`. `false` while loading or when the hook is
     * disabled. (Use `use{Name}LoadingStatus` for an `isLoading`/`isLoaded`
     * channel that does not re-render on data changes.)
     */
    isLoaded: boolean
    /** Force sync pending changes immediately */
    sync: () => Promise<void>
    /** Error from listener, if any */
    error: Error | undefined
    /**
     * Firestore document reference. Undefined when the hook was called with
     * `enabled: false` (no subscription was created).
     */
    ref: DocumentReference<T> | undefined
}

/**
 * Collection handle returned by the `useCollection` hook.
 *
 * Sync-agnostic by default, exactly like {@link DocumentHandle}: it carries
 * `data`, `isLoaded`, `isActive`, `error`, the writers, `load`, and `ref` — but
 * NOT `isSynced`. Opt into `use{Name}SyncStatus` for save state. `isActive`
 * stays (lazy collections gate a "Load" button on it); `isLoaded` is
 * `isActive && !isLoading`.
 */
export interface CollectionHandle<T extends FirestoreObject> {
    /** Current collection data keyed by document ID */
    data: Record<string, T>
    /** Update one or more documents with partial diffs */
    update: (
        diff: WithFieldValue<DeepPartial<Record<string, T>>>,
        options?: UpdateOptions
    ) => void
    /**
     * Add a new document to the collection. Either pass an explicit `id`, or
     * omit it to have Firestore generate an auto-id (returned synchronously).
     *
     * Returns `undefined` if the mutation was dropped (read-only handle, or
     * called before the first snapshot has arrived). Callers should narrow
     * before using the id to navigate or persist references.
     */
    add: {
        (
            id: string,
            data: Omit<T, 'id'>,
            options?: UpdateOptions
        ): string | undefined
        (data: Omit<T, 'id'>, options?: UpdateOptions): string | undefined
    }
    /** Remove a document from the collection */
    remove: (id: string, options?: UpdateOptions) => void
    /**
     * Whether the collection is active and its initial snapshot has arrived
     * (ready to render) — `isActive && !isLoading`. `false` for a lazy
     * collection before `load()`, while loading, or when the hook is disabled.
     */
    isLoaded: boolean
    /** Whether subscription is active (for lazy collections) */
    isActive: boolean
    /** Activate a lazy subscription */
    load: () => void
    /** Force sync pending changes immediately */
    sync: () => Promise<void>
    /** Error from listener, if any */
    error: Error | undefined
    /**
     * Firestore collection reference. Undefined when the hook was called with
     * `enabled: false` (no subscription was created).
     */
    ref: CollectionReference<T> | undefined
}

/** Reactive status fields a selector drops unless it folds them into its slice. */
type DocumentStatusKeys = 'isLoaded' | 'error'
type CollectionStatusKeys = DocumentStatusKeys | 'isActive'

/**
 * A {@link DocumentHandle} reduced to a hook-level `selector`'s output. The
 * selector receives the full observable state ({@link DocumentState}) and
 * returns the slice this component reacts to; the handle re-renders *only* when
 * that slice changes.
 *
 * A selected handle deliberately exposes **only** `data` (the slice) plus the
 * writer surface (`update`/`set`/`delete`/`sync`) and `ref` — never the status
 * fields (`isLoaded`/`error`). Status is not a freebie here: if a component
 * needs it, it must select it (`s => ({ slice: s.data?.x, loading:
 * s.isLoading })`), so what you re-render on is exactly what you select. The
 * writers stay typed against the full document `TData`, because a selector
 * changes what you *read*, never what you *write*.
 *
 * Note: `update(diff)` takes a *partial* of the full document and merges it, so
 * writing a selected field is `update({ field: next })`. `set(data)` still
 * *replaces the entire document*, not the slice — never pass the selected value
 * to `set`, or you will overwrite every other field. Prefer `update` from a
 * narrowed handle; reach for `set` only when you hold the full document.
 */
export interface SelectedDocumentHandle<
    TData extends FirestoreObject,
    TSelected,
> extends Omit<DocumentHandle<TData>, 'data' | DocumentStatusKeys> {
    /** The slice produced by the hook's `selector`. */
    data: TSelected
}

/**
 * A {@link CollectionHandle} reduced to a hook-level `selector`'s output. As
 * with {@link SelectedDocumentHandle}, the selector receives the full
 * observable state ({@link CollectionState}) and the handle exposes only the
 * slice plus the writer surface (`update`/`add`/`remove`/`load`/`sync`) and
 * `ref` — status fields (`isLoaded`/`isActive`/`error`) are dropped unless
 * folded into the slice. Writers stay typed against the full collection of
 * `TData`.
 */
export interface SelectedCollectionHandle<
    TData extends FirestoreObject,
    TSelected,
> extends Omit<CollectionHandle<TData>, 'data' | CollectionStatusKeys> {
    /** The slice produced by the hook's `selector`. */
    data: TSelected
}

/**
 * An undo/redo action
 */
export interface UndoAction {
    /** Function to undo the change */
    undo: () => Promise<void> | void
    /** Function to redo the change */
    redo: () => Promise<void> | void
    /** Optional group ID for batching multiple actions */
    groupId?: string
    /** Optional path/location context for navigation-aware undo */
    path?: string
    /** Human-readable description of the action */
    description?: string
}

/**
 * Undo manager state
 */
export interface UndoManagerState {
    /** Stack of actions that can be undone */
    undoStack: readonly UndoAction[]
    /** Stack of actions that can be redone */
    redoStack: readonly UndoAction[]
    /** Whether undo is available */
    canUndo: boolean
    /** Whether redo is available */
    canRedo: boolean
}

/**
 * Undo manager handle
 */
export interface UndoManager extends UndoManagerState {
    /** Perform undo */
    undo: () => Promise<void>
    /** Perform redo */
    redo: () => Promise<void>
    /** Push a new action onto the undo stack */
    push: (action: UndoAction) => void
    /** Clear all undo/redo history */
    clear: () => void
}

/**
 * Configuration for a document definition.
 *
 * `TData` is the document's TypeScript shape. Provide it explicitly, or let
 * it be inferred from `schema` when using `defineDocument`.
 */
export interface DocumentDefinition<TData extends FirestoreObject> {
    /**
     * Optional Zod schema. When provided, firestate runs `schema.parse(...)`
     * on full-payload writes (`set`, `add`) as a **validation guard** — bad
     * data throws at the call site, not after a Firestore round trip. The
     * parsed result is discarded; firestate stores the caller's original
     * object verbatim. That means schema transforms (`.transform`, `.coerce`,
     * default values) are NOT applied to stored data — do transforms before
     * calling `set`/`add`. Partial `update(diff)` calls are NOT validated
     * because diffs commonly contain Firestore sentinels (`serverTimestamp()`,
     * `arrayUnion`, etc.) that don't satisfy a strict schema.
     */
    schema?: ZodType<TData>
    /**
     * Collection path. Either a static string (may include multiple `/`-
     * separated segments) or a function that derives the path from route/
     * params. Use the function form when the collection lives under a dynamic
     * parent, e.g. `projects/{projectId}/revisions`.
     */
    collection: string | ((params: Record<string, string>) => string)
    /** Document ID or function to derive it */
    id: string | ((params: Record<string, string>) => string)
    /** Debounce interval for autosave (ms), default 1000 */
    autosave?: number
    /** Minimum loading indicator time (ms), default 0 */
    minLoadTime?: number
    /** Whether this document is read-only */
    readOnly?: boolean
    /** Retry on listener error */
    retryOnError?: boolean
    /** Retry interval (ms), default 5000 */
    retryInterval?: number
}

/**
 * Configuration for a collection definition.
 *
 * `TData` is the document shape for entries in this collection.
 */
export interface CollectionDefinition<TData extends FirestoreObject> {
    /**
     * Optional Zod schema for documents in the collection. When provided,
     * firestate runs `schema.parse(...)` on full-payload writes (`add`) as
     * a validation guard and stores the caller's original object verbatim.
     * Schema transforms are not applied to stored data — see
     * {@link DocumentDefinition.schema} for the full contract.
     */
    schema?: ZodType<TData>
    /** Collection path (can include path segments) */
    path: string | ((params: Record<string, string>) => string)
    /** Debounce interval for autosave (ms), default 1000 */
    autosave?: number
    /** Minimum loading indicator time (ms), default 0 */
    minLoadTime?: number
    /** Whether this collection is read-only */
    readOnly?: boolean
    /** Whether to lazy load (only subscribe when load() is called) */
    lazy?: boolean
    /** Query constraints */
    queryConstraints?: QueryConstraint[]
    /** Retry the snapshot listener on transient errors */
    retryOnError?: boolean
    /** Retry interval (ms), default 5000 */
    retryInterval?: number
}

/**
 * Configuration for the Firestate store
 */
export interface FirestateConfig {
    /** Firestore instance */
    firestore: Firestore
    /** Default autosave interval (ms), default 1000 */
    autosave?: number
    /** Default minimum load time (ms), default 0 */
    minLoadTime?: number
    /** Maximum undo stack length, default 20 */
    maxUndoLength?: number
    /**
     * Callback invoked before undo/redo when the action carries a `path`.
     * Wire your router's `navigate` here so undo/redo returns the user to
     * where a change occurred before reverting it.
     */
    onNavigate?: (path: string) => void
    /**
     * Called when a handle write (`update`/`add`/`remove`) pushes an undo
     * action, to stamp the current router path onto that action. The stamped
     * `path` is what {@link FirestateConfig.onNavigate} later receives, so
     * handle-driven undo can return the user to where the change happened
     * before reverting it. Return `undefined` to leave the action pathless.
     * Firestate can't know the router path itself — wire this to your router.
     */
    getUndoPath?: () => string | undefined
    /** Called after an undo action has been successfully applied. */
    onUndo?: (action: UndoAction) => void
    /** Called after a redo action has been successfully applied. */
    onRedo?: (action: UndoAction) => void
    /** Custom error handler */
    onError?: (error: Error, context: ErrorContext) => void
}

/**
 * Context for error handling
 */
export interface ErrorContext {
    type: 'document' | 'collection' | 'undo'
    path: string
    operation: 'read' | 'write' | 'undo' | 'redo'
}

/**
 * Subscriber callback type
 */
export type Subscriber<T> = (state: T) => void

/**
 * Unsubscribe function
 */
export type Unsubscribe = () => void
