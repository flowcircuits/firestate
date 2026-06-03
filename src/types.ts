import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  QueryConstraint,
  WithFieldValue,
} from "firebase/firestore";
import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Re-exported {@link https://standardschema.dev | Standard Schema v1} type.
 * Any validator implementing the spec (zod 3.24+/4, valibot, arktype, effect
 * schema, etc.) can be passed via the optional `schema` field on a
 * definition. Firestate never invokes `validate` itself — schemas are an
 * opt-in escape hatch for consumers to use at their own boundaries.
 */
export type { StandardSchemaV1 };

/**
 * Deep partial type that works with Records and nested objects
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

/**
 * A generic object that can be stored in Firestore.
 *
 * Uses an `any` index signature (matching Firestore's own `DocumentData`) so
 * that plain TypeScript interfaces — which lack an implicit index signature —
 * can satisfy the constraint. Internal call sites cast through more specific
 * types where needed.
 */
export type FirestoreObject = Record<string, any>;

/**
 * Options for update operations
 */
export interface UpdateOptions {
  /** If false, prevents this update from being added to undo stack */
  undoable?: boolean;
  /** Group multiple updates into a single undo action */
  undoGroupId?: string;
}

/**
 * State of a document subscription
 */
export interface DocumentState<T> {
  /** Current merged state (local changes applied to sync state) */
  data: T | undefined;
  /** Whether initial data has loaded */
  isLoading: boolean;
  /** Whether there are pending local changes */
  isSynced: boolean;
  /** Error from listener, if any */
  error: Error | undefined;
}

/**
 * State of a collection subscription
 */
export interface CollectionState<T> {
  /** Current merged state keyed by document ID */
  data: Record<string, T>;
  /** Whether initial data has loaded */
  isLoading: boolean;
  /** Whether there are pending local changes */
  isSynced: boolean;
  /** Whether the collection has been activated (for lazy loading) */
  isActive: boolean;
  /** Error from listener, if any */
  error: Error | undefined;
}

/**
 * Document handle returned by useDocument hook
 */
export interface DocumentHandle<T extends FirestoreObject> {
  /** Current document data */
  data: T | undefined;
  /** Update the document with a partial diff */
  update: (
    diff: WithFieldValue<DeepPartial<T>>,
    options?: UpdateOptions
  ) => void;
  /** Set the document data (creates or overwrites) */
  set: (data: T, options?: UpdateOptions) => void;
  /** Delete the document */
  delete: (options?: UpdateOptions) => void;
  /** Whether initial data is loading */
  isLoading: boolean;
  /** Whether all changes have synced to Firestore */
  isSynced: boolean;
  /** Force sync pending changes immediately */
  sync: () => Promise<void>;
  /** Error from listener, if any */
  error: Error | undefined;
  /**
   * Firestore document reference. Undefined when the hook was called with
   * `enabled: false` (no subscription was created).
   */
  ref: DocumentReference<T> | undefined;
}

/**
 * Collection handle returned by useCollection hook
 */
export interface CollectionHandle<T extends FirestoreObject> {
  /** Current collection data keyed by document ID */
  data: Record<string, T>;
  /** Update one or more documents with partial diffs */
  update: (
    diff: WithFieldValue<DeepPartial<Record<string, T>>>,
    options?: UpdateOptions
  ) => void;
  /**
   * Add a new document to the collection. Either pass an explicit `id`, or
   * omit it to have Firestore generate an auto-id (returned synchronously).
   *
   * Returns `undefined` if the mutation was dropped (read-only handle, or
   * called before the first snapshot has arrived). Callers should narrow
   * before using the id to navigate or persist references.
   */
  add: {
    (id: string, data: Omit<T, "id">, options?: UpdateOptions): string | undefined;
    (data: Omit<T, "id">, options?: UpdateOptions): string | undefined;
  };
  /** Remove a document from the collection */
  remove: (id: string, options?: UpdateOptions) => void;
  /** Whether initial data is loading */
  isLoading: boolean;
  /** Whether all changes have synced to Firestore */
  isSynced: boolean;
  /** Whether subscription is active (for lazy collections) */
  isActive: boolean;
  /** Activate a lazy subscription */
  load: () => void;
  /** Force sync pending changes immediately */
  sync: () => Promise<void>;
  /** Error from listener, if any */
  error: Error | undefined;
  /**
   * Firestore collection reference. Undefined when the hook was called with
   * `enabled: false` (no subscription was created).
   */
  ref: CollectionReference<T> | undefined;
}

/**
 * An undo/redo action
 */
export interface UndoAction {
  /** Function to undo the change */
  undo: () => Promise<void> | void;
  /** Function to redo the change */
  redo: () => Promise<void> | void;
  /** Optional group ID for batching multiple actions */
  groupId?: string;
  /** Optional path/location context for navigation-aware undo */
  path?: string;
  /** Human-readable description of the action */
  description?: string;
}

/**
 * Undo manager state
 */
export interface UndoManagerState {
  /** Stack of actions that can be undone */
  undoStack: readonly UndoAction[];
  /** Stack of actions that can be redone */
  redoStack: readonly UndoAction[];
  /** Whether undo is available */
  canUndo: boolean;
  /** Whether redo is available */
  canRedo: boolean;
}

/**
 * Undo manager handle
 */
export interface UndoManager extends UndoManagerState {
  /** Perform undo */
  undo: () => Promise<void>;
  /** Perform redo */
  redo: () => Promise<void>;
  /** Push a new action onto the undo stack */
  push: (action: UndoAction) => void;
  /** Clear all undo/redo history */
  clear: () => void;
}

/**
 * Configuration for a document definition.
 *
 * `TData` is the document's TypeScript shape. Provide it explicitly, or let
 * it be inferred from `schema` when using `defineDocument`.
 */
export interface DocumentDefinition<TData extends FirestoreObject> {
  /**
   * Optional Standard Schema validator (zod 3.24+, zod 4, valibot, arktype,
   * effect, etc.). Firestate does not invoke validation itself — this is
   * stored on the definition for consumers to use at their own boundaries.
   */
  schema?: StandardSchemaV1<unknown, TData>;
  /**
   * Collection path. Either a static string (may include multiple `/`-
   * separated segments) or a function that derives the path from route/
   * params. Use the function form when the collection lives under a dynamic
   * parent, e.g. `projects/{projectId}/revisions`.
   */
  collection: string | ((params: Record<string, string>) => string);
  /** Document ID or function to derive it */
  id: string | ((params: Record<string, string>) => string);
  /** Debounce interval for autosave (ms), default 1000 */
  autosave?: number;
  /** Minimum loading indicator time (ms), default 0 */
  minLoadTime?: number;
  /** Whether this document is read-only */
  readOnly?: boolean;
  /** Retry on listener error */
  retryOnError?: boolean;
  /** Retry interval (ms), default 5000 */
  retryInterval?: number;
}

/**
 * Configuration for a collection definition.
 *
 * `TData` is the document shape for entries in this collection.
 */
export interface CollectionDefinition<TData extends FirestoreObject> {
  /**
   * Optional Standard Schema validator for documents in the collection.
   * Firestate does not invoke validation itself.
   */
  schema?: StandardSchemaV1<unknown, TData>;
  /** Collection path (can include path segments) */
  path: string | ((params: Record<string, string>) => string);
  /** Debounce interval for autosave (ms), default 1000 */
  autosave?: number;
  /** Minimum loading indicator time (ms), default 0 */
  minLoadTime?: number;
  /** Whether this collection is read-only */
  readOnly?: boolean;
  /** Whether to lazy load (only subscribe when load() is called) */
  lazy?: boolean;
  /** Query constraints */
  queryConstraints?: QueryConstraint[];
  /** Retry the snapshot listener on transient errors */
  retryOnError?: boolean;
  /** Retry interval (ms), default 5000 */
  retryInterval?: number;
}

/**
 * Configuration for the Firestate store
 */
export interface FirestateConfig {
  /** Firestore instance */
  firestore: Firestore;
  /** Default autosave interval (ms), default 1000 */
  autosave?: number;
  /** Default minimum load time (ms), default 0 */
  minLoadTime?: number;
  /** Maximum undo stack length, default 20 */
  maxUndoLength?: number;
  /** Enable navigation-aware undo/redo */
  enableNavigation?: boolean;
  /** Custom error handler */
  onError?: (error: Error, context: ErrorContext) => void;
}

/**
 * Context for error handling
 */
export interface ErrorContext {
  type: "document" | "collection";
  path: string;
  operation: "read" | "write";
}

/**
 * Subscriber callback type
 */
export type Subscriber<T> = (state: T) => void;

/**
 * Unsubscribe function
 */
export type Unsubscribe = () => void;
