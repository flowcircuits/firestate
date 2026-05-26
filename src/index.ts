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
    // Handle types
    DocumentHandle,
    CollectionHandle,
    // Definition types
    DocumentDefinition,
    CollectionDefinition,
    // Standard Schema interop
    StandardSchemaV1,
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
export { defineDocument, defineCollection } from './schema'

export type {
    InferDocumentData,
    InferDocument,
    InferCollectionData,
    InferCollectionDocument,
} from './schema'

// Diff utilities
export {
    // Core diff operations
    computeDiff,
    applyDiff,
    applyDiffMutable,
    computeUndoDiff,

    // Flattening for Firestore
    flattenDiff,
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
} from './diff'

// Store
export { createStore } from './store'
export type { FirestateStore, Store } from './store'

// Undo manager
export { createUndoManager } from './undo'
export type { UndoManagerConfig, UndoManagerWithSubscribe } from './undo'

// Low-level subscriptions (for advanced use)
export { createDocumentSubscription } from './document'
export type { DocumentOptions } from './document'

export { createCollectionSubscription } from './collection'
export type { CollectionOptions } from './collection'

// React hooks
export {
    useStore,
    useDocument,
    useCollection,
    useUndoManager,
    useIsSynced,
    useUndoKeyboardShortcuts,
    FirestateContext,
} from './hooks'

export type { UseDocumentOptions, UseCollectionOptions } from './hooks'

// React providers
export {
    FirestateProvider,
    FirestateStoreProvider,
    useUnsavedChangesBlocker,
} from './provider'

export type {
    FirestateProviderProps,
    FirestateStoreProviderProps,
} from './provider'
