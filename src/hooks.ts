import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import type { QueryConstraint } from "firebase/firestore";
import type {
  CollectionDefinition,
  CollectionHandle,
  DocumentDefinition,
  DocumentHandle,
  FirestoreObject,
  LazyValue,
  UndoManager,
  UndoManagerState,
  UpdateOptions,
} from "./types";
import type { FirestateStore } from "./store";
import { createDocumentSubscription } from "./document";
import { createCollectionSubscription } from "./collection";

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

  const getSnapshot = useCallback(
    (): UndoManagerState => ({
      undoStack: undoManager.undoStack,
      redoStack: undoManager.redoStack,
      canUndo: undoManager.canUndo,
      canRedo: undoManager.canRedo,
    }),
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
}

/**
 * Hook to subscribe to a Firestore document with real-time updates.
 *
 * The subscription is keyed on the resolved document path (`definition` +
 * computed id). When that key changes — typically because `params` produces a
 * different id — the hook tears down the old Firestore listener and attaches
 * a new one. Toggling `undoable` does not rebuild the subscription; toggling
 * `readOnly` does.
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
  const { definition, params = {}, readOnly, undoable = true } = options;
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

  // Hold the latest params in a ref so the useMemo factory below can read
  // them without `params` (typically an inline object with unstable ref)
  // appearing in the deps. The key is derived from params via the resolved
  // id below, which IS stable when the content is stable.
  const paramsRef = useRef(params);
  paramsRef.current = params;

  const docId =
    typeof definition.id === "function" ? definition.id(params) : definition.id;

  const subscription = useMemo(
    () =>
      createDocumentSubscription({
        store,
        definition,
        params: paramsRef.current,
        readOnly,
        onPushUndo,
      }),
    [store, definition, docId, readOnly, onPushUndo]
  );

  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsub = subscription.subscribe(() => onChange());
      subscription.start();
      return () => {
        unsub();
        subscription.stop();
      };
    },
    [subscription]
  );

  return useSyncExternalStore(
    subscribe,
    subscription.getHandle,
    subscription.getHandle
  );
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
}

/**
 * Hook to subscribe to a Firestore collection with real-time updates.
 *
 * The subscription is keyed on the resolved collection path, `readOnly`, and
 * the `queryConstraints` reference. When any of these change, the listener
 * is torn down and re-attached with the new query. Toggling `undoable` does
 * not rebuild the subscription.
 *
 * **Memoize `queryConstraints`.** An inline array (`queryConstraints={[where(...)]}`)
 * creates a new reference every render, which will thrash the listener.
 * Wrap in `useMemo` with the underlying filter values as deps.
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

  const paramsRef = useRef(params);
  paramsRef.current = params;

  const collectionPath =
    typeof definition.path === "function"
      ? definition.path(params)
      : definition.path;

  const subscription = useMemo(
    () =>
      createCollectionSubscription({
        store,
        definition,
        params: paramsRef.current,
        readOnly,
        queryConstraints,
        onPushUndo,
      }),
    [store, definition, collectionPath, readOnly, queryConstraints, onPushUndo]
  );

  const isLazy = definition.lazy ?? false;

  const subscribe = useCallback(
    (onChange: () => void) => {
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

  return useSyncExternalStore(
    subscribe,
    subscription.getHandle,
    subscription.getHandle
  );
};

/**
 * Hook to create a lazy-loadable collection value.
 * Useful for deferring expensive collection subscriptions.
 *
 * @example
 * ```tsx
 * const spaces = useLazyCollection({
 *   definition: spacesCollection,
 *   params: { projectId },
 * })
 *
 * // Somewhere in the UI
 * <LazyComponent
 *   value={spaces.value}
 *   onLoad={spaces.load}
 *   loaded={spaces.loaded}
 * />
 * ```
 */
export const useLazyCollection = <TData extends FirestoreObject>(
  options: UseCollectionOptions<TData>
): LazyValue<Record<string, TData>> => {
  const handle = useCollection(options);

  return useMemo(
    () => ({
      value: handle.data,
      load: handle.load,
      loaded: handle.isActive && !handle.isLoading,
    }),
    [handle.data, handle.load, handle.isActive, handle.isLoading]
  );
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
