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
    LazyValue,
    // Handle types
    DocumentHandle,
    CollectionHandle,
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
    InferData,
    InferDocument,
} from './types'

// Schema utilities
export {
    defineDocument,
    defineCollection,
    validate,
    validateSafe,
    partialSchema,
    getFieldMeta,
    collectMeta,
    withId,
} from './schema'

export type {
    InferDocumentData,
    InferDocument as InferDocumentType,
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
    useLazyCollection,
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
