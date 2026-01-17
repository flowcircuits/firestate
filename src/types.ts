import { z } from 'zod'
import type {
    DocumentReference,
    Firestore,
    QueryConstraint,
    WithFieldValue,
} from 'firebase/firestore'

/**
 * Deep partial type that works with Records and nested objects
 */
export type DeepPartial<T> = T extends object
    ? { [P in keyof T]?: DeepPartial<T[P]> }
    : T

/**
 * A generic object that can be stored in Firestore
 */
export type FirestoreObject = Record<string, unknown>

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
 * State of a document subscription
 */
export interface DocumentState<T> {
    /** Current merged state (local changes applied to sync state) */
    data: T | undefined
    /** Whether initial data has loaded */
    isLoading: boolean
    /** Whether there are pending local changes */
    isSynced: boolean
    /** Error from listener, if any */
    error: Error | undefined
}

/**
 * State of a collection subscription
 */
export interface CollectionState<T> {
    /** Current merged state keyed by document ID */
    data: Record<string, T>
    /** Whether initial data has loaded */
    isLoading: boolean
    /** Whether there are pending local changes */
    isSynced: boolean
    /** Whether the collection has been activated (for lazy loading) */
    isActive: boolean
    /** Error from listener, if any */
    error: Error | undefined
}

/**
 * A lazy-loaded value that can be activated on demand
 */
export interface LazyValue<T> {
    /** Current value */
    value: T
    /** Activate the subscription */
    load: () => void
    /** Whether data has been loaded */
    loaded: boolean
}

/**
 * Document handle returned by useDocument hook
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
    /** Whether initial data is loading */
    isLoading: boolean
    /** Whether all changes have synced to Firestore */
    isSynced: boolean
    /** Force sync pending changes immediately */
    sync: () => Promise<void>
    /** Error from listener, if any */
    error: Error | undefined
    /** Firestore document reference */
    ref: DocumentReference<T>
}

/**
 * Collection handle returned by useCollection hook
 */
export interface CollectionHandle<T extends FirestoreObject> {
    /** Current collection data keyed by document ID */
    data: Record<string, T>
    /** Update one or more documents with partial diffs */
    update: (
        diff: WithFieldValue<DeepPartial<Record<string, T>>>,
        options?: UpdateOptions
    ) => void
    /** Add a new document to the collection */
    add: (id: string, data: Omit<T, 'id'>, options?: UpdateOptions) => void
    /** Remove a document from the collection */
    remove: (id: string, options?: UpdateOptions) => void
    /** Whether initial data is loading */
    isLoading: boolean
    /** Whether all changes have synced to Firestore */
    isSynced: boolean
    /** Whether subscription is active (for lazy collections) */
    isActive: boolean
    /** Activate a lazy subscription */
    load: () => void
    /** Force sync pending changes immediately */
    sync: () => Promise<void>
    /** Error from listener, if any */
    error: Error | undefined
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
 * Configuration for a document definition
 */
export interface DocumentDefinition<T extends z.ZodType> {
    /** Zod schema for validation */
    schema: T
    /** Collection path (can include path segments) */
    collection: string
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
 * Configuration for a collection definition
 */
export interface CollectionDefinition<T extends z.ZodType> {
    /** Zod schema for documents in collection */
    schema: T
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
    /** Enable navigation-aware undo/redo */
    enableNavigation?: boolean
    /** Custom error handler */
    onError?: (error: Error, context: ErrorContext) => void
}

/**
 * Context for error handling
 */
export interface ErrorContext {
    type: 'document' | 'collection'
    path: string
    operation: 'read' | 'write'
}

/**
 * Infer the data type from a Zod schema
 */
export type InferData<T extends z.ZodType> = z.infer<T>

/**
 * Infer document type (adds id field)
 */
export type InferDocument<T extends z.ZodType> = z.infer<T> & { id: string }

/**
 * Subscriber callback type
 */
export type Subscriber<T> = (state: T) => void

/**
 * Unsubscribe function
 */
export type Unsubscribe = () => void
