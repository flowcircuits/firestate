/**
 * Firestate - Schema-first Firestore state management for React
 *
 * @packageDocumentation
 */

// Core types
export type {
    // State types
    DocumentState,
    CollectionState,
    // Per-resource status types
    SyncStatus,
    LoadingStatus,
    // Handle types
    DocumentHandle,
    CollectionHandle,
    SelectedDocumentHandle,
    SelectedCollectionHandle,
    // Definition types
    DocumentDefinition,
    CollectionDefinition,
    // Undo types
    UndoAction,
    UndoManager,
    UndoManagerState,
    // Utility types
    UpdateOptions,
    DeepPartial,
    FirestoreObject,
    FirestateConfig,
    ErrorContext,
} from './types'

// Definition helpers
export { defineDocument, defineCollection } from './registry/schema'

export type {
    InferDocumentData,
    InferDocument,
    InferCollectionData,
    InferCollectionDocument,
} from './registry/schema'

// Registry-driven API
export { createFirestate, doc, col } from './registry/firestate'

export type {
    DocEntry,
    ColEntry,
    SelectedDocEntry,
    SelectedColEntry,
    SelectOptions,
    AnySelectedEntry,
    FirestateEntry,
    FirestateRegistry,
    FirestateApi,
} from './registry/firestate'

// Diff utilities
export {
    // Core diff operations
    computeDiff,
    applyDiff,
    applyDiffMutable,
    computeUndoDiff,

    // Flattening for Firestore
    flattenDiff,
    flattenDiffToFieldPaths,
    unflattenDiff,

    // Path-based utilities
    diffContainsPath,
    extractDiffValue,
    createDiffAtPath,

    // General utilities
    isDeepEqual,
    deepClone,
    isDiffEmpty,
    mergeDiffs,
} from './utils/diff'

// Selector equality helper (for use as a hook `isEqual`)
export { shallow } from './utils/shallow'

// Store
export { createStore } from './core/store'
export type {
    AtomicOptions,
    AtomicWriter,
    FirestateStore,
    Store,
} from './core/store'

// Undo manager
export { createUndoManager } from './utils/undo'
export type { UndoManagerConfig, UndoManagerWithSubscribe } from './utils/undo'

// Low-level subscriptions (for advanced use)
export { createDocumentSubscription } from './core/document'
export type { DocumentOptions } from './core/document'

export { createCollectionSubscription } from './core/collection'
export type { CollectionOptions } from './core/collection'

// React hooks
export {
    useStore,
    useDocument,
    useCollection,
    useDocumentSyncStatus,
    useDocumentLoadingStatus,
    useCollectionSyncStatus,
    useCollectionLoadingStatus,
    useUndoManager,
    useIsSynced,
    useUndoKeyboardShortcuts,
    FirestateContext,
} from './react/hooks'

export type {
    UseDocumentOptions,
    UseCollectionOptions,
    UseDocumentStatusOptions,
    UseCollectionStatusOptions,
    DocumentSelectorOptions,
    CollectionSelectorOptions,
} from './react/hooks'

// React providers
export {
    FirestateProvider,
    FirestateStoreProvider,
    useUnsavedChangesBlocker,
    useFirestateBeforeUnloadWarning,
} from './react/provider'

export type {
    FirestateProviderProps,
    FirestateStoreProviderProps,
} from './react/provider'
