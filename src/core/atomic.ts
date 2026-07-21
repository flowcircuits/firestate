import type { WriteBatch } from 'firebase/firestore'

export interface AtomicWriteOwner {
    attempt: Promise<void> | null
}

export interface AtomicPrepareOptions {
    /** Internal undo path may recreate a document deleted by the operation. */
    allowCreate?: boolean
}

export interface PreparedAtomicUpdate {
    readonly writeCount: number
    readonly forwardDiff: unknown
    readonly reverseDiff: unknown
    apply: (owner: AtomicWriteOwner) => void
    addToBatch: (batch: WriteBatch) => void
    committed: () => void
    failed: (error: Error) => void
}

export interface AtomicUpdateAdapter {
    readonly path: string
    prepareUpdate: (
        diff: unknown,
        options?: AtomicPrepareOptions
    ) => PreparedAtomicUpdate
}

const adaptersByUpdate = new WeakMap<Function, AtomicUpdateAdapter>()
const readOnlyUpdates = new WeakSet<Function>()

export const registerAtomicUpdateAdapter = (
    update: Function,
    adapter: AtomicUpdateAdapter
): void => {
    adaptersByUpdate.set(update, adapter)
}

export const markAtomicUpdateReadOnly = (update: Function): void => {
    readOnlyUpdates.add(update)
}

export const getAtomicUpdateAdapter = (handle: {
    update: Function
}): AtomicUpdateAdapter => {
    if (readOnlyUpdates.has(handle.update)) {
        throw new Error(
            'Firestate atomic update rejected: handle is read-only.'
        )
    }
    const adapter = adaptersByUpdate.get(handle.update)
    if (!adapter) {
        throw new Error(
            'Firestate atomic update rejected: handle is disabled, unavailable, or was not created by Firestate.'
        )
    }
    return adapter
}
