import React, {
    useCallback,
    useEffect,
    useMemo,
    useSyncExternalStore,
} from 'react'
import type { Firestore } from 'firebase/firestore'
import { createStore, type FirestateStore } from '../core/store'
import { FirestateContext } from './hooks'
import type { ErrorContext, UndoAction } from '../types'

/**
 * Props for FirestateProvider
 */
export interface FirestateProviderProps {
    /** Firestore instance */
    firestore: Firestore
    /** Default autosave interval (ms), default 1000 */
    autosave?: number
    /** Default minimum load time (ms), default 0 */
    minLoadTime?: number
    /** Maximum undo stack length, default 20 */
    maxUndoLength?: number
    /**
     * Called before undo/redo when the action carries a `path`. Wire your
     * router's `navigate` here to return users to where a change occurred
     * before reverting it.
     *
     * @example
     * ```tsx
     * import { useNavigate } from 'react-router-dom'
     *
     * function App() {
     *   const navigate = useNavigate()
     *   return (
     *     <FirestateProvider onNavigate={(path) => navigate(path)}>
     *       {children}
     *     </FirestateProvider>
     *   )
     * }
     * ```
     */
    onNavigate?: (path: string) => void
    /**
     * Called when a handle write (`update`/`add`/`remove`) pushes an undo
     * action, to stamp the current router path onto it. That path is what
     * `onNavigate` later receives, so handle-driven undo can return users to
     * where a change occurred. Read the path from your router here.
     *
     * @example
     * ```tsx
     * import { useLocation } from 'react-router-dom'
     *
     * function App() {
     *   const location = useLocation()
     *   return (
     *     <FirestateProvider getUndoPath={() => location.pathname}>
     *       {children}
     *     </FirestateProvider>
     *   )
     * }
     * ```
     */
    getUndoPath?: () => string | undefined
    /** Custom error handler */
    onError?: (error: Error, context: ErrorContext) => void
    /** Called after an undo action has been successfully applied */
    onUndo?: (action: UndoAction) => void
    /** Called after a redo action has been successfully applied */
    onRedo?: (action: UndoAction) => void
    /** React children */
    children: React.ReactNode
}

/**
 * Provider component that sets up Firestate for your application.
 *
 * @example
 * ```tsx
 * import { FirestateProvider } from 'firestate'
 * import { db } from './firebase'
 *
 * function App() {
 *   return (
 *     <FirestateProvider
 *       firestore={db}
 *       autosave={1000}
 *       maxUndoLength={20}
 *       onError={(error, ctx) => console.error(ctx.path, error)}
 *     >
 *       <YourApp />
 *     </FirestateProvider>
 *   )
 * }
 * ```
 */
export const FirestateProvider: React.FC<FirestateProviderProps> = ({
    firestore,
    autosave = 1000,
    minLoadTime = 0,
    maxUndoLength = 20,
    onError,
    onNavigate,
    getUndoPath,
    onUndo,
    onRedo,
    children,
}) => {
    // Callback props are intentionally excluded from the deps so inline
    // callbacks (new reference per render) do not re-create the store and drop
    // every existing subscription. The store replaces the latest handlers below.
    const store = useMemo(
        () =>
            createStore({
                firestore,
                autosave,
                minLoadTime,
                maxUndoLength,
                onError,
                onNavigate,
                getUndoPath,
                onUndo,
                onRedo,
            }),
        [firestore, autosave, minLoadTime, maxUndoLength]
    )

    useEffect(() => {
        store.setOnError(onError)
    }, [store, onError])

    useEffect(() => {
        store.setOnNavigate(onNavigate)
    }, [store, onNavigate])

    useEffect(() => {
        store.setGetUndoPath(getUndoPath)
    }, [store, getUndoPath])

    useEffect(() => {
        store.setOnUndo(onUndo)
    }, [store, onUndo])

    useEffect(() => {
        store.setOnRedo(onRedo)
    }, [store, onRedo])

    return (
        <FirestateContext.Provider value={store}>
            {children}
        </FirestateContext.Provider>
    )
}

/**
 * Props for using an existing store
 */
export interface FirestateStoreProviderProps {
    /** Pre-created store instance */
    store: FirestateStore
    /** React children */
    children: React.ReactNode
}

/**
 * Provider that uses an existing store instance.
 * Useful when you need to create the store outside of React.
 *
 * @example
 * ```tsx
 * const store = createStore({ firestore: db })
 *
 * function App() {
 *   return (
 *     <FirestateStoreProvider store={store}>
 *       <YourApp />
 *     </FirestateStoreProvider>
 *   )
 * }
 * ```
 */
export const FirestateStoreProvider: React.FC<FirestateStoreProviderProps> = ({
    store,
    children,
}) => (
    <FirestateContext.Provider value={store}>
        {children}
    </FirestateContext.Provider>
)

/**
 * Hook to use navigation blocker when there are unsaved changes.
 * Works with react-router or similar routers.
 *
 * @example
 * ```tsx
 * function ProjectPage() {
 *   const shouldBlock = useUnsavedChangesBlocker()
 *
 *   // Use with react-router's useBlocker
 *   const blocker = useBlocker(
 *     ({ currentLocation, nextLocation }) =>
 *       currentLocation.pathname !== nextLocation.pathname && shouldBlock
 *   )
 *
 *   return (
 *     <>
 *       <ProjectEditor />
 *       {blocker.state === 'blocked' && (
 *         <Dialog>Your changes may not be saved!</Dialog>
 *       )}
 *     </>
 *   )
 * }
 * ```
 */
export const useUnsavedChangesBlocker = (): boolean => {
    const store = React.useContext(FirestateContext)

    const subscribe = useCallback(
        (onChange: () => void) =>
            store ? store.subscribeToSyncState(() => onChange()) : () => {},
        [store]
    )

    const getSnapshot = useCallback(
        () => (store ? !store.isSynced : false),
        [store]
    )

    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Install the browser's native unload warning while Firestate has a debounced
 * or in-flight write. This cannot await a flush during unload; call
 * `await store.flush()` before controlled navigation instead.
 */
export const useFirestateBeforeUnloadWarning = (): void => {
    const store = React.useContext(FirestateContext)
    const subscribe = useCallback(
        (onChange: () => void) =>
            store ? store.subscribeToSyncState(() => onChange()) : () => {},
        [store]
    )
    const getSnapshot = useCallback(
        () => store?.hasPendingWrites ?? false,
        [store]
    )
    const hasPendingWrites = useSyncExternalStore(
        subscribe,
        getSnapshot,
        getSnapshot
    )

    useEffect(() => {
        if (!hasPendingWrites || typeof window === 'undefined') return

        const warn = (event: BeforeUnloadEvent) => {
            event.preventDefault()
            event.returnValue = ''
        }
        window.addEventListener('beforeunload', warn)
        return () => window.removeEventListener('beforeunload', warn)
    }, [hasPendingWrites])
}
