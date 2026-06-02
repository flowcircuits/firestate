/**
 * Strict in-memory Firestore mock.
 *
 * Replaces `firebase/firestore` via `vi.mock` in test files. The mock enforces
 * Firestore-like semantics so tests catch real-world misuse:
 *   - `undefined` field values are rejected (Firestore rejects these)
 *   - `updateDoc` against a non-existent doc throws
 *   - `setDoc` requires an object body
 *   - Document paths must have an even number of segments; collections odd
 *
 * Listener delivery is synchronous: any mutation that affects a listener's
 * path fires that listener before the mutation Promise resolves. This makes
 * tests deterministic — no `await waitFor` for snapshot propagation.
 *
 * The control API (`mockFirestore`) lets tests seed initial data, simulate
 * remote changes, inject listener errors, and reset state between tests.
 *
 * Usage in a test file:
 * ```ts
 * import { vi } from 'vitest'
 * import { mockFirestore } from './test-utils/firestore-mock'
 *
 * vi.mock('firebase/firestore', async () => {
 *   const m = await import('./test-utils/firestore-mock')
 *   return m.firestoreMockModule
 * })
 *
 * // mockFirestore.firestore is the fake Firestore instance to pass into createStore
 * ```
 */
import { vi } from 'vitest'

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MockDocRef {
    __type: 'doc'
    path: string
    id: string
    parent: MockCollectionRef
}

interface MockCollectionRef {
    __type: 'collection'
    path: string
    constraints: MockConstraint[]
}

type MockConstraint =
    | { __type: 'where'; field: string; op: string; value: unknown }
    | { __type: 'orderBy'; field: string; dir?: 'asc' | 'desc' }
    | { __type: 'limit'; n: number }

interface DocListener {
    type: 'doc'
    ref: MockDocRef
    onNext: (snap: MockDocSnapshot) => void
    onError?: (err: Error) => void
}

interface CollectionListener {
    type: 'collection'
    ref: MockCollectionRef
    onNext: (snap: MockCollectionSnapshot) => void
    onError?: (err: Error) => void
}

type Listener = DocListener | CollectionListener

interface MockDocSnapshot {
    id: string
    exists: () => boolean
    data: () => Record<string, unknown> | undefined
    metadata: { fromCache: boolean }
}

interface MockCollectionSnapshot {
    docs: MockDocSnapshot[]
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
    data: new Map<string, Record<string, unknown>>(),
    listeners: new Set<Listener>(),
    autoIdSeq: 0,
    // When true, listener fires triggered by mutations are queued instead of
    // delivered. Tests use this to interleave a second mutation between a
    // sync's write and the resulting snapshot — exercising code paths (like
    // handleSnapshot's rebase branch) that require the listener to fire AFTER
    // a follow-up local edit.
    deferFires: false,
    pendingFires: new Set<Listener>(),
}

const FIRESTORE_INSTANCE = { __type: 'mock-firestore' } as const

// `deleteField()` returns a sentinel that the lib detects via `.isEqual`.
// We use a Symbol so the sentinel can't be accidentally constructed.
const DELETE_FIELD_SYMBOL = Symbol('mock-deleteField')
const DELETE_FIELD_SENTINEL = {
    __sentinel: DELETE_FIELD_SYMBOL,
    isEqual: (other: unknown) =>
        typeof other === 'object' &&
        other !== null &&
        (other as { __sentinel?: symbol }).__sentinel === DELETE_FIELD_SYMBOL,
}

const isDeleteSentinel = (v: unknown): boolean =>
    typeof v === 'object' &&
    v !== null &&
    (v as { __sentinel?: symbol }).__sentinel === DELETE_FIELD_SYMBOL

// ---------------------------------------------------------------------------
// Validation (strict semantics)
// ---------------------------------------------------------------------------

const assertValidDocPath = (path: string) => {
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0 || segments.length % 2 !== 0) {
        throw new Error(
            `mock-firestore: document path must have an even, non-zero number of segments, got "${path}"`
        )
    }
}

const assertValidCollectionPath = (path: string) => {
    const segments = path.split('/').filter(Boolean)
    if (segments.length === 0 || segments.length % 2 !== 1) {
        throw new Error(
            `mock-firestore: collection path must have an odd, non-zero number of segments, got "${path}"`
        )
    }
}

const assertWritePayload = (
    payload: unknown,
    op: string,
    path: string,
    allowSentinels: boolean
): void => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(
            `mock-firestore: ${op} payload must be a plain object at "${path}", got ${typeof payload}`
        )
    }
    for (const [key, value] of Object.entries(payload)) {
        if (value === undefined) {
            throw new Error(
                `mock-firestore: cannot write undefined value for field "${key}" at "${path}"`
            )
        }
        if (isDeleteSentinel(value)) {
            if (!allowSentinels) {
                throw new Error(
                    `mock-firestore: deleteField() is only allowed in updateDoc / batch.update, not in ${op}, at "${path}"`
                )
            }
            continue
        }
        if (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
        ) {
            assertWritePayload(value, op, path, allowSentinels)
        }
    }
}

// ---------------------------------------------------------------------------
// Snapshot construction
// ---------------------------------------------------------------------------

const docSnapshot = (id: string, data: Record<string, unknown> | undefined): MockDocSnapshot => ({
    id,
    exists: () => data !== undefined,
    data: () => (data === undefined ? undefined : structuredClone(data)),
    metadata: { fromCache: false },
})

const childIdsOf = (collectionPath: string): string[] => {
    const prefix = collectionPath + '/'
    const expectedDepth = collectionPath.split('/').filter(Boolean).length + 1
    const ids: string[] = []
    for (const path of state.data.keys()) {
        if (!path.startsWith(prefix)) continue
        const segments = path.split('/').filter(Boolean)
        if (segments.length !== expectedDepth) continue
        ids.push(segments[segments.length - 1]!)
    }
    return ids
}

const passesConstraints = (
    data: Record<string, unknown>,
    constraints: MockConstraint[]
): boolean => {
    for (const c of constraints) {
        if (c.__type === 'where') {
            const { field, op, value } = c
            const actual = (data as Record<string, unknown>)[field]
            switch (op) {
                case '==':
                    if (actual !== value) return false
                    break
                case '!=':
                    if (actual === value) return false
                    break
                case '<':
                    if (!((actual as number) < (value as number))) return false
                    break
                case '<=':
                    if (!((actual as number) <= (value as number))) return false
                    break
                case '>':
                    if (!((actual as number) > (value as number))) return false
                    break
                case '>=':
                    if (!((actual as number) >= (value as number))) return false
                    break
                case 'in':
                    if (!Array.isArray(value) || !value.includes(actual)) return false
                    break
                case 'array-contains':
                    if (!Array.isArray(actual) || !actual.includes(value)) return false
                    break
                default:
                    throw new Error(`mock-firestore: unsupported where op "${op}"`)
            }
        }
    }
    return true
}

const applyOrderByLimit = (
    docs: Array<{ id: string; data: Record<string, unknown> }>,
    constraints: MockConstraint[]
): Array<{ id: string; data: Record<string, unknown> }> => {
    let result = [...docs]
    for (const c of constraints) {
        if (c.__type === 'orderBy') {
            const { field, dir } = c
            result.sort((a, b) => {
                const av = a.data[field]
                const bv = b.data[field]
                if (av === bv) return 0
                const cmp = (av as number) < (bv as number) ? -1 : 1
                return dir === 'desc' ? -cmp : cmp
            })
        }
    }
    for (const c of constraints) {
        if (c.__type === 'limit') {
            result = result.slice(0, c.n)
        }
    }
    return result
}

const collectionSnapshot = (ref: MockCollectionRef): MockCollectionSnapshot => {
    const entries: Array<{ id: string; data: Record<string, unknown> }> = []
    for (const id of childIdsOf(ref.path)) {
        const data = state.data.get(`${ref.path}/${id}`)
        if (data === undefined) continue
        if (!passesConstraints(data, ref.constraints)) continue
        entries.push({ id, data })
    }
    const ordered = applyOrderByLimit(entries, ref.constraints)
    return { docs: ordered.map(({ id, data }) => docSnapshot(id, data)) }
}

// ---------------------------------------------------------------------------
// Listener delivery
// ---------------------------------------------------------------------------

const fireDocListener = (l: DocListener) => {
    const data = state.data.get(l.ref.path)
    l.onNext(docSnapshot(l.ref.id, data))
}

const fireCollectionListener = (l: CollectionListener) => {
    l.onNext(collectionSnapshot(l.ref))
}

const fireListener = (l: Listener) => {
    if (state.deferFires) {
        // Queue with the listener as the key — multiple writes to the same
        // path while deferred coalesce into one delivery, mirroring real
        // Firestore's snapshot batching.
        state.pendingFires.add(l)
        return
    }
    if (l.type === 'doc') fireDocListener(l)
    else fireCollectionListener(l)
}

const parentCollectionPath = (docPath: string): string => {
    const segments = docPath.split('/').filter(Boolean)
    return segments.slice(0, -1).join('/')
}

const notifyAffected = (docPaths: Iterable<string>) => {
    const affectedDocPaths = new Set<string>()
    const affectedCollectionPaths = new Set<string>()
    for (const p of docPaths) {
        affectedDocPaths.add(p)
        affectedCollectionPaths.add(parentCollectionPath(p))
    }
    // Route through fireListener so deferred-fire mode (used by tests that
    // need to interleave a follow-up mutation before the snapshot lands) is
    // honored. Iterate a snapshot of the Set so listener-triggered re-subs
    // during sync delivery don't get double-fired in this loop.
    for (const l of [...state.listeners]) {
        if (l.type === 'doc' && affectedDocPaths.has(l.ref.path)) {
            fireListener(l)
        } else if (l.type === 'collection' && affectedCollectionPaths.has(l.ref.path)) {
            fireListener(l)
        }
    }
}

// ---------------------------------------------------------------------------
// Dot-path helpers (for updateDoc / batch.update flattened diffs)
// ---------------------------------------------------------------------------

const setDotPath = (obj: Record<string, unknown>, path: string, value: unknown) => {
    const keys = path.split('.')
    let cur: Record<string, unknown> = obj
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]!
        const next = cur[k]
        if (next === undefined || typeof next !== 'object' || next === null || Array.isArray(next)) {
            cur[k] = {}
        }
        cur = cur[k] as Record<string, unknown>
    }
    cur[keys[keys.length - 1]!] = value
}

const deleteDotPath = (obj: Record<string, unknown>, path: string) => {
    const keys = path.split('.')
    let cur: Record<string, unknown> = obj
    for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i]!
        const next = cur[k]
        if (next === undefined || typeof next !== 'object' || next === null) return
        cur = next as Record<string, unknown>
    }
    delete cur[keys[keys.length - 1]!]
}

const applyUpdateDiff = (
    target: Record<string, unknown>,
    flatDiff: Record<string, unknown>
): Record<string, unknown> => {
    const next = structuredClone(target)
    for (const [key, value] of Object.entries(flatDiff)) {
        if (isDeleteSentinel(value)) {
            deleteDotPath(next, key)
        } else {
            setDotPath(next, key, value)
        }
    }
    return next
}

// ---------------------------------------------------------------------------
// Mock function implementations (the module surface)
// ---------------------------------------------------------------------------

export const doc = vi.fn(
    (parent: unknown, id?: string): MockDocRef => {
        if (
            typeof parent !== 'object' ||
            parent === null ||
            (parent as { __type?: string }).__type !== 'collection'
        ) {
            throw new Error(
                `mock-firestore: doc(parent, id?) requires a CollectionReference as parent`
            )
        }
        const collectionRef = parent as MockCollectionRef
        const actualId =
            id !== undefined && id !== '' ? id : `auto_${++state.autoIdSeq}`
        const path = `${collectionRef.path}/${actualId}`
        assertValidDocPath(path)
        return {
            __type: 'doc',
            path,
            id: actualId,
            parent: collectionRef,
        }
    }
)

export const collection = vi.fn(
    (firestore: unknown, path: string): MockCollectionRef => {
        if (firestore !== FIRESTORE_INSTANCE) {
            throw new Error(
                `mock-firestore: collection() requires the mockFirestore.firestore instance as first arg`
            )
        }
        assertValidCollectionPath(path)
        return { __type: 'collection', path, constraints: [] }
    }
)

export const query = vi.fn(
    (
        ref: MockCollectionRef,
        ...constraints: MockConstraint[]
    ): MockCollectionRef => {
        if (ref.__type !== 'collection') {
            throw new Error(`mock-firestore: query() requires a CollectionReference`)
        }
        return {
            __type: 'collection',
            path: ref.path,
            constraints: [...ref.constraints, ...constraints],
        }
    }
)

export const onSnapshot = vi.fn(
    (
        refOrQuery: MockDocRef | MockCollectionRef,
        onNext: (snap: unknown) => void,
        onError?: (err: Error) => void
    ) => {
        const listener: Listener =
            refOrQuery.__type === 'doc'
                ? { type: 'doc', ref: refOrQuery, onNext: onNext as DocListener['onNext'], onError }
                : {
                      type: 'collection',
                      ref: refOrQuery,
                      onNext: onNext as CollectionListener['onNext'],
                      onError,
                  }
        state.listeners.add(listener)
        // Fire synchronously with the current state. Mirrors Firestore's
        // initial-snapshot behavior (minus the network round-trip delay).
        // RTL may emit an act() warning for the resulting state update —
        // it's a false positive (useSyncExternalStore docs allow sync
        // onChange calls), suppressed in test-setup.ts.
        fireListener(listener)
        return () => {
            state.listeners.delete(listener)
        }
    }
)

export const setDoc = vi.fn(
    async (ref: MockDocRef, data: Record<string, unknown>): Promise<void> => {
        assertWritePayload(data, 'setDoc', ref.path, false)
        state.data.set(ref.path, structuredClone(data))
        notifyAffected([ref.path])
    }
)

export const updateDoc = vi.fn(
    async (ref: MockDocRef, flatDiff: Record<string, unknown>): Promise<void> => {
        const existing = state.data.get(ref.path)
        if (existing === undefined) {
            const err = new Error(
                `mock-firestore: updateDoc on non-existent document "${ref.path}"`
            )
            ;(err as Error & { code?: string }).code = 'not-found'
            throw err
        }
        assertWritePayload(flatDiff, 'updateDoc', ref.path, true)
        state.data.set(ref.path, applyUpdateDiff(existing, flatDiff))
        notifyAffected([ref.path])
    }
)

export const deleteDoc = vi.fn(async (ref: MockDocRef): Promise<void> => {
    state.data.delete(ref.path)
    notifyAffected([ref.path])
})

type BatchOp =
    | { kind: 'set'; ref: MockDocRef; data: Record<string, unknown> }
    | { kind: 'update'; ref: MockDocRef; data: Record<string, unknown> }
    | { kind: 'delete'; ref: MockDocRef }

export const writeBatch = vi.fn((firestore: unknown) => {
    if (firestore !== FIRESTORE_INSTANCE) {
        throw new Error(
            `mock-firestore: writeBatch() requires the mockFirestore.firestore instance`
        )
    }
    const ops: BatchOp[] = []
    let committed = false
    return {
        set(ref: MockDocRef, data: Record<string, unknown>) {
            ops.push({ kind: 'set', ref, data })
            return this
        },
        update(ref: MockDocRef, data: Record<string, unknown>) {
            ops.push({ kind: 'update', ref, data })
            return this
        },
        delete(ref: MockDocRef) {
            ops.push({ kind: 'delete', ref })
            return this
        },
        async commit() {
            if (committed) {
                throw new Error(`mock-firestore: batch already committed`)
            }
            committed = true
            // Validate everything before mutating — Firestore commits are atomic.
            for (const op of ops) {
                if (op.kind === 'set') {
                    assertWritePayload(op.data, 'batch.set', op.ref.path, false)
                } else if (op.kind === 'update') {
                    if (!state.data.has(op.ref.path)) {
                        const err = new Error(
                            `mock-firestore: batch.update on non-existent document "${op.ref.path}"`
                        )
                        ;(err as Error & { code?: string }).code = 'not-found'
                        throw err
                    }
                    assertWritePayload(op.data, 'batch.update', op.ref.path, true)
                }
            }
            const touched: string[] = []
            for (const op of ops) {
                if (op.kind === 'set') {
                    state.data.set(op.ref.path, structuredClone(op.data))
                } else if (op.kind === 'update') {
                    const existing = state.data.get(op.ref.path)!
                    state.data.set(op.ref.path, applyUpdateDiff(existing, op.data))
                } else {
                    state.data.delete(op.ref.path)
                }
                touched.push(op.ref.path)
            }
            notifyAffected(touched)
        },
    }
})

export const deleteField = vi.fn(() => DELETE_FIELD_SENTINEL)

// Timestamp — class so `instanceof Timestamp` checks in the lib still work.
export class Timestamp {
    seconds: number
    nanoseconds: number
    constructor(seconds: number, nanoseconds: number) {
        this.seconds = seconds
        this.nanoseconds = nanoseconds
    }
    static now(): Timestamp {
        const ms = Date.now()
        return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6)
    }
    static fromDate(date: Date): Timestamp {
        const ms = date.getTime()
        return new Timestamp(Math.floor(ms / 1000), (ms % 1000) * 1e6)
    }
    toDate(): Date {
        return new Date(this.seconds * 1000 + this.nanoseconds / 1e6)
    }
    toMillis(): number {
        return this.seconds * 1000 + this.nanoseconds / 1e6
    }
    isEqual(other: Timestamp): boolean {
        return (
            other instanceof Timestamp &&
            this.seconds === other.seconds &&
            this.nanoseconds === other.nanoseconds
        )
    }
}

// serverTimestamp sentinel — distinct from deleteField. The lib detects it
// via isEqual; resolveDiff() in diff.ts swaps it for `Timestamp.now()`.
const SERVER_TIMESTAMP_SYMBOL = Symbol('mock-serverTimestamp')
const SERVER_TIMESTAMP_SENTINEL = {
    __sentinel: SERVER_TIMESTAMP_SYMBOL,
    isEqual: (other: unknown) =>
        typeof other === 'object' &&
        other !== null &&
        (other as { __sentinel?: symbol }).__sentinel === SERVER_TIMESTAMP_SYMBOL,
}

export const serverTimestamp = vi.fn(() => SERVER_TIMESTAMP_SENTINEL)

// Query constraint constructors (stubbed — the mock honors the ones it implements)
export const where = vi.fn(
    (field: string, op: string, value: unknown): MockConstraint => ({
        __type: 'where',
        field,
        op,
        value,
    })
)

export const orderBy = vi.fn(
    (field: string, dir?: 'asc' | 'desc'): MockConstraint => ({
        __type: 'orderBy',
        field,
        dir,
    })
)

export const limit = vi.fn((n: number): MockConstraint => ({ __type: 'limit', n }))

// Type-only re-exports left undefined at runtime (the lib only uses these as types).
export const DocumentReference = undefined
export const CollectionReference = undefined
export const Query = undefined
export const QueryConstraint = undefined
export const WithFieldValue = undefined
export const DocumentData = undefined

// ---------------------------------------------------------------------------
// The module surface that `vi.mock('firebase/firestore', ...)` should return.
// ---------------------------------------------------------------------------

export const firestoreMockModule = {
    doc,
    collection,
    query,
    onSnapshot,
    setDoc,
    updateDoc,
    deleteDoc,
    writeBatch,
    deleteField,
    serverTimestamp,
    Timestamp,
    where,
    orderBy,
    limit,
    DocumentReference,
    CollectionReference,
    Query,
    QueryConstraint,
    WithFieldValue,
    DocumentData,
}

// ---------------------------------------------------------------------------
// Control API exposed to tests
// ---------------------------------------------------------------------------

export const mockFirestore = {
    /** The fake Firestore instance to pass into createStore({ firestore }). */
    firestore: FIRESTORE_INSTANCE as unknown as import('firebase/firestore').Firestore,

    /** Seed initial data WITHOUT firing listeners (sets up a "pre-existing" doc). */
    seed(path: string, data: Record<string, unknown>) {
        assertValidDocPath(path)
        state.data.set(path, structuredClone(data))
    },

    /** Seed many docs at once. Keys are full paths. */
    seedMany(entries: Record<string, Record<string, unknown>>) {
        for (const [path, data] of Object.entries(entries)) {
            this.seed(path, data)
        }
    },

    /** Mutate as if a remote client wrote to this doc; fires listeners. */
    setRemote(path: string, data: Record<string, unknown>) {
        assertValidDocPath(path)
        state.data.set(path, structuredClone(data))
        notifyAffected([path])
    },

    /** Delete a doc as if removed remotely; fires listeners. */
    deleteRemote(path: string) {
        assertValidDocPath(path)
        state.data.delete(path)
        notifyAffected([path])
    },

    /**
     * Fire onError on every listener whose path starts with `pathPrefix`.
     * Use to simulate listener-side failures (permission denied, network).
     * Listeners that receive an error are NOT removed — Firestore terminates
     * the listener after onError fires, so call the returned unsubscribe in
     * the caller's `handleError` if you want the full real flow.
     */
    injectListenerError(pathPrefix: string, error: Error) {
        for (const l of state.listeners) {
            if (l.ref.path.startsWith(pathPrefix)) {
                l.onError?.(error)
            }
        }
    },

    /** Read current server-side data for a doc path. */
    getDoc(path: string): Record<string, unknown> | undefined {
        const data = state.data.get(path)
        return data === undefined ? undefined : structuredClone(data)
    },

    /** Read current server-side data for every doc directly under a collection. */
    getCollection(collectionPath: string): Map<string, Record<string, unknown>> {
        const result = new Map<string, Record<string, unknown>>()
        for (const id of childIdsOf(collectionPath)) {
            const data = state.data.get(`${collectionPath}/${id}`)
            if (data !== undefined) result.set(id, structuredClone(data))
        }
        return result
    },

    /** Count active listeners (test that the lib cleans up after itself). */
    listenerCount(): number {
        return state.listeners.size
    },

    /**
     * Turn deferred-fire mode on/off. While on, mutations that would normally
     * fire snapshot listeners synchronously instead queue the listeners — use
     * `flushListeners()` to deliver. Lets tests interleave a second mutation
     * between a write and its resulting snapshot.
     */
    setDeferListenerFires(deferred: boolean) {
        state.deferFires = deferred
    },

    /**
     * Deliver any listener fires queued while in deferred mode. Each pending
     * listener is fired exactly once with the current state (matching real
     * Firestore's batched-snapshot behavior). Does not change the deferred
     * flag — call `setDeferListenerFires(false)` separately to resume sync
     * delivery.
     */
    flushListeners() {
        const toFire = [...state.pendingFires]
        state.pendingFires.clear()
        // Temporarily exit deferred mode while firing so any synchronous
        // re-subscribes from the listener body don't get queued.
        const wasDeferred = state.deferFires
        state.deferFires = false
        try {
            for (const l of toFire) {
                if (l.type === 'doc') fireDocListener(l)
                else fireCollectionListener(l)
            }
        } finally {
            state.deferFires = wasDeferred
        }
    },

    /** Reset everything: data, listeners, sequence, spy history. */
    reset() {
        state.data.clear()
        state.listeners.clear()
        state.pendingFires.clear()
        state.deferFires = false
        state.autoIdSeq = 0
        vi.clearAllMocks()
    },
}
