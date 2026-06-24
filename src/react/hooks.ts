import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { collection, queryEqual } from "firebase/firestore";
import type {
  CollectionReference,
  Firestore,
  QueryConstraint,
} from "firebase/firestore";
import type {
  CollectionDefinition,
  CollectionHandle,
  DocumentDefinition,
  DocumentHandle,
  FirestoreObject,
  UndoManager,
  UndoManagerState,
  UpdateOptions,
} from "../types";
import type { FirestateStore } from "../core/store";
import { createDocumentSubscription } from "../core/document";
import { buildCollectionQuery, createCollectionSubscription } from "../core/collection";

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
  if (a === b) return true;
  const ref = collection(firestore, collectionPath) as CollectionReference;
  try {
    return queryEqual(
      buildCollectionQuery(ref, definitionConstraints, a),
      buildCollectionQuery(ref, definitionConstraints, b)
    );
  } catch {
    return false;
  }
};

/**
 * Returned when a hook is called with `enabled: false`. Module-level constants
 * so getSnapshot returns a stable reference and useSyncExternalStore doesn't
 * re-render. Cast at the call site to the generic handle type — every method
 * is a no-op so the cast is sound.
 */
const NOOP = () => {};
const ASYNC_NOOP = async () => {};
const EMPTY_RECORD: Record<string, never> = {};

const DISABLED_DOCUMENT_HANDLE: DocumentHandle<FirestoreObject> = {
  data: undefined,
  update: NOOP,
  set: NOOP,
  delete: NOOP,
  isLoading: false,
  isSynced: true,
  sync: ASYNC_NOOP,
  error: undefined,
  ref: undefined,
};

// The disabled add() satisfies both overloads but performs no work and
// returns undefined to match the bail-path contract from collection.ts.
// Consumers using `enabled: false` should not be calling mutation methods
// on the disabled handle.
const DISABLED_ADD = () => undefined;

const DISABLED_COLLECTION_HANDLE: CollectionHandle<FirestoreObject> = {
  data: EMPTY_RECORD,
  update: NOOP,
  add: DISABLED_ADD,
  remove: NOOP,
  isLoading: false,
  isSynced: true,
  isActive: false,
  load: NOOP,
  sync: ASYNC_NOOP,
  error: undefined,
  ref: undefined,
};

/**
 * Context for providing the Firestate store
 */
export const FirestateContext = createContext<FirestateStore | null>(null);

/**
 * Hook to access the Firestate store
 */
export const useStore = (): FirestateStore => {
  const store = useContext(FirestateContext);
  if (!store) {
    throw new Error("useStore must be used within a FirestateProvider");
  }
  return store;
};

/**
 * Hook to access the undo manager
 */
export const useUndoManager = (): UndoManager => {
  const store = useStore();
  const { undoManager } = store;

  const subscribe = useCallback(
    (onStoreChange: () => void) => undoManager.subscribe(onStoreChange),
    [undoManager]
  );

  // Delegate to the manager's cached snapshot so getSnapshot returns a stable
  // reference across React's multiple per-commit calls. Building the snapshot
  // inline here would create a new object every call and trip the
  // "getSnapshot should be cached" warning + an infinite re-render loop.
  const getSnapshot = useCallback(
    (): UndoManagerState => undoManager.getState(),
    [undoManager]
  );

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return useMemo(
    () => ({
      ...state,
      push: undoManager.push,
      undo: undoManager.undo,
      redo: undoManager.redo,
      clear: undoManager.clear,
    }),
    [state, undoManager]
  );
};

/**
 * Hook to check if all tracked resources are synced
 */
export const useIsSynced = (): boolean => {
  const store = useStore();

  const subscribe = useCallback(
    (onChange: () => void) => store.subscribeToSyncState(() => onChange()),
    [store]
  );

  const getSnapshot = useCallback(() => store.isSynced, [store]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * Options for useDocument hook
 */
export interface UseDocumentOptions<TData extends FirestoreObject> {
  /** Document definition from defineDocument() */
  definition: DocumentDefinition<TData>;
  /** Route/path parameters for dynamic paths */
  params?: Record<string, string>;
  /** Override read-only setting */
  readOnly?: boolean;
  /** Enable undo/redo for this document (default: true) */
  undoable?: boolean;
  /**
   * If false, no subscription is created and a no-op handle is returned
   * (`{ data: undefined, isLoading: false, isSynced: true, ref: undefined }`).
   * Use this to gate subscriptions on route params that aren't ready yet.
   * Default: true.
   */
  enabled?: boolean;
}

/**
 * Hook to subscribe to a Firestore document with real-time updates.
 *
 * The subscription is keyed on the resolved document path (`definition` +
 * computed id) and `readOnly`. When that key changes — typically because
 * `params` produces a different id — the hook tears down the old Firestore
 * listener and attaches a new one. Toggling `undoable` does not rebuild the
 * subscription.
 *
 * Use `enabled: false` to suppress the subscription entirely (e.g., when
 * route params aren't ready yet).
 *
 * **SSR.** On the server there is no Firestore listener, so this hook returns
 * the initial handle (`{ data: undefined, isLoading: true }`). Mutations like
 * `update`/`set` will mutate orphaned local state with no effect — avoid
 * calling them server-side.
 *
 * @example
 * ```tsx
 * const projectDoc = defineDocument<Project>({
 *   collection: 'projects',
 *   id: (params) => params.projectId,
 * })
 *
 * function ProjectEditor({ projectId }: { projectId: string }) {
 *   const { data, update, isLoading, isSynced } = useDocument({
 *     definition: projectDoc,
 *     params: { projectId },
 *   })
 *
 *   if (isLoading) return <Spinner />
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
export const useDocument = <TData extends FirestoreObject>(
  options: UseDocumentOptions<TData>
): DocumentHandle<TData> => {
  const {
    definition,
    params = {},
    readOnly,
    undoable = true,
    enabled = true,
  } = options;
  const store = useStore();
  const undoManager = store.undoManager;

  // Hold the latest `undoable` in a ref so the onPushUndo callback can stay
  // referentially stable. Without this, every undoable toggle would tear
  // down the Firestore listener and re-attach it for no good reason.
  const undoableRef = useRef(undoable);
  undoableRef.current = undoable;

  const onPushUndo = useCallback(
    (undoAction: () => void, redoAction: () => void, opts?: UpdateOptions) => {
      if (!undoableRef.current) return;
      undoManager.push({
        undo: undoAction,
        redo: redoAction,
        groupId: opts?.undoGroupId,
      });
    },
    [undoManager]
  );

  // Resolve the doc id and collection path at render time. When disabled we
  // skip resolution — consumers commonly pass `enabled: false` precisely
  // because params aren't ready and definition.id(params) would fail.
  const docId = enabled
    ? typeof definition.id === "function"
      ? definition.id(params)
      : definition.id
    : undefined;

  const collectionPath = enabled
    ? typeof definition.collection === "function"
      ? definition.collection(params)
      : definition.collection
    : undefined;

  const subscription = useMemo(
    () =>
      enabled && docId !== undefined && collectionPath !== undefined
        ? createDocumentSubscription({
            store,
            definition,
            docId,
            collectionPath,
            readOnly,
            onPushUndo,
          })
        : null,
    [enabled, store, definition, docId, collectionPath, readOnly, onPushUndo]
  );

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!subscription) return NOOP;
      const unsub = subscription.subscribe(() => onChange());
      subscription.load();
      return () => {
        unsub();
        subscription.stop();
      };
    },
    [subscription]
  );

  const getSnapshot = useCallback(
    () =>
      subscription
        ? subscription.getHandle()
        : (DISABLED_DOCUMENT_HANDLE as DocumentHandle<TData>),
    [subscription]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

/**
 * Options for useCollection hook
 */
export interface UseCollectionOptions<TData extends FirestoreObject> {
  /** Collection definition from defineCollection() */
  definition: CollectionDefinition<TData>;
  /** Route/path parameters for dynamic paths */
  params?: Record<string, string>;
  /** Override read-only setting */
  readOnly?: boolean;
  /** Additional query constraints */
  queryConstraints?: QueryConstraint[];
  /** Enable undo/redo for this collection (default: true) */
  undoable?: boolean;
  /**
   * If false, no subscription is created and a no-op handle is returned
   * (`{ data: {}, isLoading: false, isActive: false }`). Use this to gate on
   * route params that aren't ready yet. Default: true.
   */
  enabled?: boolean;
}

/**
 * Hook to subscribe to a Firestore collection with real-time updates.
 *
 * The subscription is keyed on the resolved collection path, `readOnly`, and
 * the *semantic identity* of `queryConstraints`. When any of these change, the
 * listener is torn down and re-attached with the new query. Toggling
 * `undoable` does not rebuild the subscription.
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
 * the initial handle (`{ data: {}, isLoading: true }` for non-lazy, or
 * `isActive: false` for lazy). Avoid calling mutations server-side.
 *
 * @example
 * ```tsx
 * const spacesCollection = defineCollection<Space>({
 *   path: (params) => `projects/${params.projectId}/spaces`,
 *   lazy: true,
 * })
 *
 * function SpacesList({ projectId }: { projectId: string }) {
 *   const { data, update, load, isActive, isLoading } = useCollection({
 *     definition: spacesCollection,
 *     params: { projectId },
 *   })
 *
 *   // Lazy load on mount
 *   useEffect(() => { load() }, [load])
 *
 *   if (!isActive) return <Button onClick={load}>Load Spaces</Button>
 *   if (isLoading) return <Spinner />
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
export const useCollection = <TData extends FirestoreObject>(
  options: UseCollectionOptions<TData>
): CollectionHandle<TData> => {
  const {
    definition,
    params = {},
    readOnly,
    queryConstraints,
    undoable = true,
    enabled = true,
  } = options;
  const store = useStore();
  const undoManager = store.undoManager;

  const undoableRef = useRef(undoable);
  undoableRef.current = undoable;

  const onPushUndo = useCallback(
    (undoAction: () => void, redoAction: () => void, opts?: UpdateOptions) => {
      if (!undoableRef.current) return;
      undoManager.push({
        undo: undoAction,
        redo: redoAction,
        groupId: opts?.undoGroupId,
      });
    },
    [undoManager]
  );

  // Resolve the collection path at render time. When disabled we skip
  // resolution — consumers commonly pass `enabled: false` precisely because
  // params aren't ready.
  const collectionPath = enabled
    ? typeof definition.path === "function"
      ? definition.path(params)
      : definition.path
    : undefined;

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
  const stableConstraintsRef = useRef(queryConstraints);
  const stableActiveRef = useRef(false);
  const active = enabled && collectionPath !== undefined;
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
    stableConstraintsRef.current = queryConstraints;
  }
  stableActiveRef.current = active;
  const stableConstraints = stableConstraintsRef.current;

  const subscription = useMemo(
    () =>
      enabled && collectionPath !== undefined
        ? createCollectionSubscription({
            store,
            definition,
            collectionPath,
            readOnly,
            queryConstraints: stableConstraints,
            onPushUndo,
          })
        : null,
    [
      enabled,
      store,
      definition,
      collectionPath,
      readOnly,
      stableConstraints,
      onPushUndo,
    ]
  );

  const isLazy = definition.lazy ?? false;

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!subscription) return NOOP;
      const unsub = subscription.subscribe(() => onChange());
      if (!isLazy) {
        subscription.load();
      }
      return () => {
        unsub();
        subscription.stop();
      };
    },
    [subscription, isLazy]
  );

  const getSnapshot = useCallback(
    () =>
      subscription
        ? subscription.getHandle()
        : (DISABLED_COLLECTION_HANDLE as CollectionHandle<TData>),
    [subscription]
  );

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

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
  const undoManager = useStore().undoManager;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const platform =
        (
          navigator as Navigator & {
            userAgentData?: { platform: string };
          }
        ).userAgentData?.platform ?? navigator.platform;
      const isMac = platform.toUpperCase().includes("MAC");
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      if (!modifier) return;

      if (e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        undoManager.undo();
      } else if ((e.key === "z" && e.shiftKey) || e.key === "y") {
        e.preventDefault();
        undoManager.redo();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [undoManager]);
};
