import React, { useEffect, useMemo } from 'react'
import type { Firestore } from 'firebase/firestore'
import { createStore, type FirestateStore } from './store'
import { FirestateContext } from './hooks'
import type { ErrorContext } from './types'

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
    /** Custom error handler */
    onError?: (error: Error, context: ErrorContext) => void
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
    children,
}) => {
    const store = useMemo(
        () =>
            createStore({
                firestore,
                autosave,
                minLoadTime,
                maxUndoLength,
                onError,
            }),
        [firestore, autosave, minLoadTime, maxUndoLength, onError]
    )

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
    const [shouldBlock, setShouldBlock] = React.useState(false)

    useEffect(() => {
        if (!store) return
        return store.subscribeToSyncState((isSynced) => {
            setShouldBlock(!isSynced)
        })
    }, [store])

    return shouldBlock
}
