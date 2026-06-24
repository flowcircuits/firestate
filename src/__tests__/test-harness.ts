/**
 * Test-only harness for driving Firestate subscriptions deterministically,
 * without a Firestore emulator. Mocks `firebase/firestore` at the network edge
 * (`onSnapshot` + the write functions) and lets a test fire synthetic snapshots
 * carrying per-document `metadata.hasPendingWrites` at any instant — which a
 * real emulator does not expose deterministically.
 *
 * Usage (the `vi.mock` factory is hoisted, so it must dynamic-import this file
 * to share the module-level bus with the test's own import):
 *
 * ```ts
 * import { vi } from 'vitest'
 * vi.mock('firebase/firestore', async () => {
 *   const actual = await vi.importActual('firebase/firestore')
 *   const { buildFirestoreMock } = await import('./test-harness')
 *   return buildFirestoreMock(actual)
 * })
 * import { createHarness } from './test-harness'
 *
 * let h: ReturnType<typeof createHarness>
 * beforeEach(() => { h = createHarness() })
 * ```
 *
 * Real timers + `autosave: 0` is the recommended mode: drive every write with
 * an explicit `sub.sync()` and settle awaited commits with `flushMicrotasks()`.
 */
import { vi } from 'vitest'

export interface SnapMeta {
    fromCache?: boolean
    hasPendingWrites?: boolean
}

/** A promise whose resolution a test controls. */
export class Deferred<T = void> {
    readonly promise: Promise<T>
    resolve!: (value: T) => void
    reject!: (err: unknown) => void
    settled = false

    constructor() {
        this.promise = new Promise<T>((res, rej) => {
            this.resolve = (v) => {
                if (this.settled) return
                this.settled = true
                res(v)
            }
            this.reject = (e) => {
                if (this.settled) return
                this.settled = true
                rej(e)
            }
        })
    }
}

/**
 * Build a Firestore-shaped error carrying a `.code` (the GRPC status string the
 * §6 retry classifier keys on, e.g. 'unavailable', 'permission-denied').
 */
export const firestoreError = (code: string): Error & { code: string } => {
    const e = new Error(`[firestore-mock] ${code}`) as Error & { code: string }
    e.code = code
    e.name = 'FirebaseError'
    return e
}

export type CommitKind = 'batch' | 'set' | 'update' | 'delete'

export interface BatchOp {
    type: 'set' | 'update' | 'delete'
    ref: unknown
    data?: unknown
    /**
     * For `update` ops issued in the variadic `batch.update(ref, fieldPath,
     * value, …)` form, the raw args after `ref`. `data` stays undefined then.
     * Mirrors {@link CommitRecord.fieldArgs}.
     */
    fieldArgs?: unknown[]
}

export interface CommitRecord {
    kind: CommitKind
    ref?: unknown
    data?: unknown
    /**
     * For `update` commits issued in the variadic `updateDoc(ref, fieldPath,
     * value, …)` form, the raw args after `ref` — i.e. `[FieldPath, value,
     * FieldPath, value, …]`. `data` stays undefined in that case. Tests can
     * assert against these with `FieldPath.isEqual` to prove literal-segment
     * paths (e.g. an email map key) are preserved.
     */
    fieldArgs?: unknown[]
    ops?: BatchOp[]
    deferred: Deferred<void>
}

export interface ListenerRecord {
    ref: unknown
    onNext: (snap: unknown) => void
    onError: (err: Error) => void
    unsubscribe: ReturnType<typeof vi.fn>
}

interface Bus {
    listeners: ListenerRecord[]
    commits: CommitRecord[]
    autoIds: string[]
    autoCounter: number
}

// Module singleton shared between the (hoisted) `vi.mock` factory and the
// test's `createHarness()` import. Reset per-test by `createHarness()`.
const bus: Bus = { listeners: [], commits: [], autoIds: [], autoCounter: 0 }

/**
 * Build the mocked `firebase/firestore` module. `actual` is the real module
 * (from `vi.importActual`) — sentinels/value types (deleteField,
 * serverTimestamp, Timestamp, …) pass through unchanged so `.isEqual` and the
 * diff machinery behave exactly as in production.
 */
export const buildFirestoreMock = (
    actual: Record<string, unknown>
): Record<string, unknown> => ({
    ...actual,
    collection: vi.fn((_firestore: unknown, path: string) => ({
        __coll: path,
    })),
    doc: vi.fn((parent: unknown, docId?: string) => {
        if (docId === undefined) {
            // Auto-id allocation: `doc(collectionRef)`.
            const id = bus.autoIds.shift() ?? `auto-${++bus.autoCounter}`
            return { id, __parent: parent, __auto: true }
        }
        return { id: docId, __parent: parent }
    }),
    query: vi.fn((ref: unknown) => ref),
    onSnapshot: vi.fn((...args: unknown[]) => {
        // Normalize both call shapes:
        //   onSnapshot(ref, onNext, onError)
        //   onSnapshot(ref, { includeMetadataChanges }, onNext, onError)
        const ref = args[0]
        let onNext: (snap: unknown) => void
        let onError: (err: Error) => void
        if (typeof args[1] === 'function') {
            onNext = args[1] as (snap: unknown) => void
            onError = (args[2] as (err: Error) => void) ?? (() => {})
        } else {
            onNext = args[2] as (snap: unknown) => void
            onError = (args[3] as (err: Error) => void) ?? (() => {})
        }
        const unsubscribe = vi.fn()
        bus.listeners.push({ ref, onNext, onError, unsubscribe })
        return unsubscribe
    }),
    writeBatch: vi.fn(() => {
        const ops: BatchOp[] = []
        return {
            set: vi.fn((ref: unknown, data: unknown) => {
                ops.push({ type: 'set', ref, data })
            }),
            update: vi.fn((ref: unknown, ...rest: unknown[]) => {
                // Object form `update(ref, data)` vs variadic field-path form
                // `update(ref, fieldPath, value, …)` — see updateDoc above.
                const isObjectForm =
                    rest.length === 1 &&
                    !(rest[0] instanceof (actual.FieldPath as never))
                ops.push(
                    isObjectForm
                        ? { type: 'update', ref, data: rest[0] }
                        : { type: 'update', ref, fieldArgs: rest }
                )
            }),
            delete: vi.fn((ref: unknown) => {
                ops.push({ type: 'delete', ref })
            }),
            commit: vi.fn(() => {
                const deferred = new Deferred<void>()
                bus.commits.push({ kind: 'batch', ops, deferred })
                return deferred.promise
            }),
        }
    }),
    setDoc: vi.fn((ref: unknown, data: unknown) => {
        const deferred = new Deferred<void>()
        bus.commits.push({ kind: 'set', ref, data, deferred })
        return deferred.promise
    }),
    updateDoc: vi.fn((ref: unknown, ...rest: unknown[]) => {
        const deferred = new Deferred<void>()
        // Two call shapes: the object form `updateDoc(ref, data)` and the
        // variadic field-path form `updateDoc(ref, fieldPath, value, …)`. The
        // production write path uses the latter so dotted map keys survive.
        const isObjectForm =
            rest.length === 1 && !(rest[0] instanceof (actual.FieldPath as never))
        bus.commits.push(
            isObjectForm
                ? { kind: 'update', ref, data: rest[0], deferred }
                : { kind: 'update', ref, fieldArgs: rest, deferred }
        )
        return deferred.promise
    }),
    deleteDoc: vi.fn((ref: unknown) => {
        const deferred = new Deferred<void>()
        bus.commits.push({ kind: 'delete', ref, deferred })
        return deferred.promise
    }),
})

export interface Harness {
    /** All listeners attached so far, oldest first. */
    listeners: () => ListenerRecord[]

    /** Fire a document snapshot on the most-recently-attached listener. */
    fireDocSnapshot: (data: object | null, meta?: SnapMeta) => void
    /** Document echo: `hasPendingWrites: true` (my own un-acked write). */
    fireDocEcho: (data: object | null) => void
    /** Document confirmation: `hasPendingWrites: false` (server truth). */
    fireDocConfirmed: (data: object | null) => void

    /** Fire a collection snapshot, applying `meta` to every doc + the aggregate. */
    fireCollectionSnapshot: (
        docs: Record<string, object>,
        meta?: SnapMeta
    ) => void
    /** Fire a collection snapshot with independent per-document metadata. */
    fireCollectionSnapshotPerDoc: (
        entries: Record<string, { data: object; meta?: SnapMeta }>,
        aggregateMeta?: SnapMeta
    ) => void

    /** Deliver a listener error to the most-recent listener. */
    fireListenerError: (err: Error) => void

    /** Commits issued but not yet resolved/rejected. */
    pendingCommits: () => CommitRecord[]
    /** Total commits ever issued (settled or not). */
    commitCount: () => number
    /** Resolve the oldest pending commit (server ack). */
    resolveNextCommit: () => void
    /** Reject the oldest pending commit with a Firestore `.code`. */
    rejectNextCommit: (code: string) => void

    /** Queue auto-ids that `doc(collectionRef)` will pop in order. */
    seedAutoIds: (...ids: string[]) => void

    /** Let awaited promises (e.g. an in-flight commit's `.then`) settle. */
    flushMicrotasks: () => Promise<void>
}

const makeDocSnap = (data: object | null, meta?: SnapMeta) => ({
    exists: () => data !== null,
    data: () => data,
    metadata: {
        fromCache: meta?.fromCache ?? false,
        hasPendingWrites: meta?.hasPendingWrites ?? false,
    },
})

const makeCollSnap = (
    entries: Record<string, { data: object; meta?: SnapMeta }>,
    aggregateMeta?: SnapMeta
) => {
    const docs = Object.entries(entries).map(([id, { data, meta }]) => ({
        id,
        data: () => data,
        metadata: {
            fromCache: meta?.fromCache ?? false,
            hasPendingWrites: meta?.hasPendingWrites ?? false,
        },
    }))
    const aggHasPending =
        aggregateMeta?.hasPendingWrites ??
        docs.some((d) => d.metadata.hasPendingWrites)
    return {
        docs,
        size: docs.length,
        empty: docs.length === 0,
        metadata: {
            fromCache: aggregateMeta?.fromCache ?? false,
            hasPendingWrites: aggHasPending,
        },
    }
}

/** Reset the bus and return a fresh controller. Call once per test. */
export const createHarness = (): Harness => {
    bus.listeners = []
    bus.commits = []
    bus.autoIds = []
    bus.autoCounter = 0

    const lastListener = (): ListenerRecord => {
        const l = bus.listeners[bus.listeners.length - 1]
        if (!l) {
            throw new Error(
                'No listener attached — call sub.load() before firing a snapshot.'
            )
        }
        return l
    }

    return {
        listeners: () => bus.listeners,

        fireDocSnapshot: (data, meta) =>
            lastListener().onNext(makeDocSnap(data, meta)),
        fireDocEcho: (data) =>
            lastListener().onNext(
                makeDocSnap(data, { hasPendingWrites: true })
            ),
        fireDocConfirmed: (data) =>
            lastListener().onNext(
                makeDocSnap(data, { hasPendingWrites: false })
            ),

        fireCollectionSnapshot: (docs, meta) => {
            const entries: Record<
                string,
                { data: object; meta?: SnapMeta }
            > = {}
            for (const [id, data] of Object.entries(docs)) {
                entries[id] = { data, meta }
            }
            lastListener().onNext(makeCollSnap(entries, meta))
        },
        fireCollectionSnapshotPerDoc: (entries, aggregateMeta) =>
            lastListener().onNext(makeCollSnap(entries, aggregateMeta)),

        fireListenerError: (err) => lastListener().onError(err),

        pendingCommits: () => bus.commits.filter((c) => !c.deferred.settled),
        commitCount: () => bus.commits.length,
        resolveNextCommit: () => {
            const next = bus.commits.find((c) => !c.deferred.settled)
            if (!next) throw new Error('No pending commit to resolve.')
            next.deferred.resolve()
        },
        rejectNextCommit: (code) => {
            const next = bus.commits.find((c) => !c.deferred.settled)
            if (!next) throw new Error('No pending commit to reject.')
            next.deferred.reject(firestoreError(code))
        },

        seedAutoIds: (...ids) => {
            bus.autoIds.push(...ids)
        },

        flushMicrotasks: async () => {
            await Promise.resolve()
            await Promise.resolve()
        },
    }
}
