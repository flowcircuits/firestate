import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react'
import type { z } from 'zod'
import type { QueryConstraint } from 'firebase/firestore'
import type {
    CollectionDefinition,
    CollectionHandle,
    CollectionState,
    DocumentDefinition,
    DocumentHandle,
    DocumentState,
    FirestoreObject,
    LazyValue,
    UndoManager,
    UndoManagerState,
    UpdateOptions,
} from './types'
import type { FirestateStore } from './store'
import { createDocumentSubscription } from './document'
import { createCollectionSubscription } from './collection'

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

    const getSnapshot = useCallback(
        (): UndoManagerState => ({
            undoStack: undoManager.undoStack,
            redoStack: undoManager.redoStack,
            canUndo: undoManager.canUndo,
            canRedo: undoManager.canRedo,
        }),
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
    const [isSynced, setIsSynced] = useState(store.isSynced)

    useEffect(() => {
        return store.subscribeToSyncState(setIsSynced)
    }, [store])

    return isSynced
}

/**
 * Options for useDocument hook
 */
export interface UseDocumentOptions<TData extends FirestoreObject> {
    /** Document definition from defineDocument() */
    definition: DocumentDefinition<z.ZodType<TData>>
    /** Route/path parameters for dynamic paths */
    params?: Record<string, string>
    /** Override read-only setting */
    readOnly?: boolean
    /** Enable undo/redo for this document (default: true) */
    undoable?: boolean
}

/**
 * Hook to subscribe to a Firestore document with real-time updates.
 *
 * @example
 * ```tsx
 * const projectDoc = defineDocument({
 *   schema: ProjectSchema,
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
    const { definition, params = {}, readOnly, undoable = true } = options
    const store = useStore()
    const undoManager = store.undoManager

    // Stable params reference
    const paramsRef = useRef(params)
    paramsRef.current = params

    // Create undo callback
    const onPushUndo = useCallback(
        (undoAction: () => void, redoAction: () => void, opts?: UpdateOptions) => {
            if (!undoable) return
            undoManager.push({
                undo: undoAction,
                redo: redoAction,
                groupId: opts?.undoGroupId,
            })
        },
        [undoManager, undoable]
    )

    // Create subscription
    const subscriptionRef = useRef<ReturnType<typeof createDocumentSubscription<TData>> | null>(null)

    if (!subscriptionRef.current) {
        subscriptionRef.current = createDocumentSubscription({
            store,
            definition,
            params: paramsRef.current,
            readOnly,
            onPushUndo,
        })
    }

    const subscription = subscriptionRef.current

    // State management
    const [state, setState] = useState<DocumentState<TData>>(() =>
        subscription.getState()
    )

    // Subscribe to changes
    useEffect(() => {
        const unsubscribe = subscription.subscribe(setState)
        subscription.start()
        return () => {
            unsubscribe()
            subscription.stop()
        }
    }, [subscription])

    // Return handle
    return useMemo(
        () => subscription.getHandle(),
        [subscription, state] // eslint-disable-line react-hooks/exhaustive-deps
    )
}

/**
 * Options for useCollection hook
 */
export interface UseCollectionOptions<TData extends FirestoreObject> {
    /** Collection definition from defineCollection() */
    definition: CollectionDefinition<z.ZodType<TData>>
    /** Route/path parameters for dynamic paths */
    params?: Record<string, string>
    /** Override read-only setting */
    readOnly?: boolean
    /** Additional query constraints */
    queryConstraints?: QueryConstraint[]
    /** Enable undo/redo for this collection (default: true) */
    undoable?: boolean
}

/**
 * Hook to subscribe to a Firestore collection with real-time updates.
 *
 * @example
 * ```tsx
 * const spacesCollection = defineCollection({
 *   schema: SpaceSchema,
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
    const { definition, params = {}, readOnly, queryConstraints, undoable = true } = options
    const store = useStore()
    const undoManager = store.undoManager

    // Stable params reference
    const paramsRef = useRef(params)
    paramsRef.current = params

    // Create undo callback
    const onPushUndo = useCallback(
        (undoAction: () => void, redoAction: () => void, opts?: UpdateOptions) => {
            if (!undoable) return
            undoManager.push({
                undo: undoAction,
                redo: redoAction,
                groupId: opts?.undoGroupId,
            })
        },
        [undoManager, undoable]
    )

    // Create subscription
    const subscriptionRef = useRef<ReturnType<typeof createCollectionSubscription<TData>> | null>(null)

    if (!subscriptionRef.current) {
        subscriptionRef.current = createCollectionSubscription({
            store,
            definition,
            params: paramsRef.current,
            readOnly,
            queryConstraints,
            onPushUndo,
        })
    }

    const subscription = subscriptionRef.current

    // State management
    const [state, setState] = useState<CollectionState<TData>>(() =>
        subscription.getState()
    )

    // Subscribe to changes
    useEffect(() => {
        const unsubscribe = subscription.subscribe(setState)
        return () => {
            unsubscribe()
            subscription.stop()
        }
    }, [subscription])

    // Return handle
    return useMemo(
        () => subscription.getHandle(),
        [subscription, state] // eslint-disable-line react-hooks/exhaustive-deps
    )
}

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
    const handle = useCollection(options)

    return useMemo(
        () => ({
            value: handle.data,
            load: handle.load,
            loaded: handle.isActive && !handle.isLoading,
        }),
        [handle.data, handle.load, handle.isActive, handle.isLoading]
    )
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
    const undoManager = useUndoManager()

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            const isMac = navigator.platform.toUpperCase().includes('MAC')
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
