import {
    deleteField,
    serverTimestamp,
    Timestamp,
    WithFieldValue,
} from 'firebase/firestore'
import type { DeepPartial, FirestoreObject } from './types'

/**
 * Check if a value is a plain object (not array, null, or special Firestore type)
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Timestamp) &&
    Object.getPrototypeOf(value) === Object.prototype

/**
 * Check if a value is a Firestore opaque type: a FieldValue sentinel
 * (`serverTimestamp`, `deleteField`, `increment`, `arrayUnion`,
 * `arrayRemove`, …) or a value type the SDK ships with its own identity
 * semantics (`Timestamp`, `DocumentReference`, `GeoPoint`, `Bytes`,
 * `VectorValue`). They all expose `.isEqual()` and have a non-plain
 * prototype.
 *
 * The diff / clone pipeline must treat these as **opaque**: never iterate
 * their keys, never substitute their values, never compare them by `===`.
 * Doing any of those silently breaks the write path — see the C1
 * regression where `serverTimestamp()` was replaced with `Timestamp.now()`
 * before reaching Firestore.
 */
const isFirestoreOpaque = (
    value: unknown
): value is { isEqual: (other: unknown) => boolean } => {
    if (value === null || typeof value !== 'object') return false
    if (Object.getPrototypeOf(value) === Object.prototype) return false
    return (
        'isEqual' in value &&
        typeof (value as { isEqual: unknown }).isEqual === 'function'
    )
}

// Reference sentinels used to identify specific FieldValue kinds. The
// Firebase SDK does not export the sentinel subclasses; the only stable
// way to ask "is this a serverTimestamp / deleteField?" is to construct a
// reference instance once and delegate to its `.isEqual()`. Hoisting them
// to module scope avoids reconstructing on every call.
const SERVER_TIMESTAMP_REF = serverTimestamp()
const DELETE_FIELD_REF = deleteField()

const isDeleteField = (value: unknown): boolean =>
    isFirestoreOpaque(value) && value.isEqual(DELETE_FIELD_REF)

const isServerTimestamp = (value: unknown): boolean =>
    isFirestoreOpaque(value) && value.isEqual(SERVER_TIMESTAMP_REF)

/**
 * Check if two values are deeply equal
 */
export const isDeepEqual = (a: unknown, b: unknown): boolean => {
    if (a === b) return true
    if (a === null || b === null) return false
    if (typeof a !== typeof b) return false

    if (Array.isArray(a) && Array.isArray(b)) {
        if (a.length !== b.length) return false
        return a.every((item, i) => isDeepEqual(item, b[i]))
    }

    // Opaque Firestore types delegate to their own `.isEqual`. Catches
    // Timestamp, DocumentReference, GeoPoint, Bytes, VectorValue and
    // every FieldValue sentinel kind.
    if (isFirestoreOpaque(a) && isFirestoreOpaque(b)) {
        return a.isEqual(b)
    }

    if (isPlainObject(a) && isPlainObject(b)) {
        const keysA = Object.keys(a)
        const keysB = Object.keys(b)
        if (keysA.length !== keysB.length) return false
        return keysA.every((key) => isDeepEqual(a[key], b[key]))
    }

    return false
}

/**
 * Compute the minimal diff between two objects for Firestore updates.
 * Returns only the fields that changed, using deleteField() for removed fields.
 *
 * @param from - The original object (sync state)
 * @param to - The target object (local state)
 * @returns A partial object containing only changed fields
 */
export const computeDiff = <T extends FirestoreObject>(
    from: T,
    to: T | undefined
): WithFieldValue<DeepPartial<T>> => {
    if (to === undefined) {
        return deleteField() as WithFieldValue<DeepPartial<T>>
    }

    const diff: Record<string, unknown> = {}

    // Check for changed or added fields
    for (const key of Object.keys(to)) {
        const fromValue = from[key]
        const toValue = to[key]

        // Arrays are compared by value and replaced entirely
        if (Array.isArray(toValue)) {
            if (!isDeepEqual(fromValue, toValue)) {
                diff[key] = toValue
            }
            continue
        }

        // Nested objects get recursive diff
        if (isPlainObject(toValue)) {
            if (!isDeepEqual(fromValue, toValue)) {
                const nestedDiff = computeDiff(
                    (fromValue as Record<string, unknown>) ?? {},
                    toValue
                )
                if (Object.keys(nestedDiff).length > 0) {
                    diff[key] = nestedDiff
                }
            }
            continue
        }

        // Firestore opaque values — sentinels (serverTimestamp,
        // arrayUnion, …) and value types (Timestamp, DocumentReference,
        // …). Compare via `.isEqual` so identical-by-value Timestamps
        // don't show up as spurious diffs every sync; pass the value
        // through unchanged so sentinels survive into the write payload
        // for the server to expand.
        if (isFirestoreOpaque(toValue)) {
            if (
                !isFirestoreOpaque(fromValue) ||
                !toValue.isEqual(fromValue)
            ) {
                diff[key] = toValue
            }
            continue
        }

        // Primitives are compared directly
        if (toValue !== undefined && fromValue !== toValue) {
            diff[key] = toValue
        }
    }

    // Check for removed fields. Only `undefined` triggers a delete — `null`
    // is a valid Firestore value and is preserved via the primitive-comparison
    // branch above.
    for (const key of Object.keys(from)) {
        if (to[key] === undefined) {
            diff[key] = deleteField()
        }
    }

    return diff as WithFieldValue<DeepPartial<T>>
}

/**
 * Apply a Firestore diff to a target object in place (mutating).
 * Handles deleteField(), serverTimestamp(), and nested objects.
 *
 * Most code should use `applyDiff` (immutable) instead.
 * This mutable version is useful for performance-critical paths
 * where you're already working with a cloned object.
 *
 * @param target - The object to mutate
 * @param diff - The diff to apply
 */
export const applyDiffMutable = (
    target: FirestoreObject,
    diff: Record<string, unknown>
): void => {
    for (const key of Object.keys(diff)) {
        const value = (diff as Record<string, unknown>)[key]

        // Firestore opaque values: FieldValue sentinels and value types.
        if (isFirestoreOpaque(value)) {
            // `deleteField()` is structural — actually drop the key from
            // the local view. Matches what Firestore does on commit, and
            // what `computeDiff`'s removed-field branch round-trips back
            // out to a sentinel on the next diff.
            if (isDeleteField(value)) {
                delete (target as Record<string, unknown>)[key]
                continue
            }
            // Every other opaque value (serverTimestamp, increment,
            // arrayUnion/Remove, Timestamp, DocumentReference, GeoPoint,
            // Bytes, VectorValue, …) is preserved by reference. Sentinels
            // must reach Firestore in their original form so the server
            // can expand them; value types must keep their prototype.
            //
            // `serverTimestamp()` used to be substituted with
            // `Timestamp.now()` here, which silently shipped client clock
            // time to Firestore. The optimistic-display companion lives
            // in document.ts / collection.ts as `displayOverrides`.
            ;(target as Record<string, unknown>)[key] = value
            continue
        }

        // Handle nested objects
        if (isPlainObject(value)) {
            const existingValue = (target as Record<string, unknown>)[key]
            if (!isPlainObject(existingValue)) {
                ;(target as Record<string, unknown>)[key] = {}
            }
            applyDiffMutable(
                (target as Record<string, unknown>)[key] as FirestoreObject,
                value as Record<string, unknown>
            )
            continue
        }

        // Handle primitives and arrays
        ;(target as Record<string, unknown>)[key] = value
    }
}

/**
 * Create a deep clone of an object that's safe for Firestore operations.
 *
 * Firestore opaque values (FieldValue sentinels, Timestamp,
 * DocumentReference, GeoPoint, Bytes, VectorValue) are returned **by
 * reference**. They are immutable from the user's perspective; cloning
 * them by walking keys would either lose their prototype — turning a
 * `DocumentReference` into a plain object Firestore can't recognize —
 * or destroy a sentinel that needed to reach the server intact.
 */
export const deepClone = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') {
        return value
    }

    if (isFirestoreOpaque(value)) {
        return value
    }

    if (Array.isArray(value)) {
        return value.map(deepClone) as T
    }

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
        result[key] = deepClone((value as Record<string, unknown>)[key])
    }
    return result as T
}

/**
 * Check if a diff is empty (no changes)
 */
export const isDiffEmpty = (diff: Record<string, unknown>): boolean =>
    Object.keys(diff).length === 0

/**
 * Flatten a nested diff object to dot notation for use with Firestore's updateDoc.
 *
 * This converts:
 * ```
 * { building: { floors: 5, height: 100 }, name: 'Test' }
 * ```
 * To:
 * ```
 * { 'building.floors': 5, 'building.height': 100, 'name': 'Test' }
 * ```
 *
 * Arrays, FieldValue sentinels (deleteField, serverTimestamp, …) and
 * Firestore value types (Timestamp, DocumentReference, GeoPoint, Bytes,
 * VectorValue) are NOT flattened — they're preserved at their path so
 * Firestore receives them in their original form.
 *
 * @param diff - The nested diff object
 * @param prefix - Internal: current path prefix for recursion
 * @returns Flattened object with dotted keys
 */
export const flattenDiff = (
    diff: Record<string, unknown>,
    prefix = ''
): Record<string, unknown> => {
    const result: Record<string, unknown> = {}

    for (const key of Object.keys(diff)) {
        const value = diff[key]
        const path = prefix ? `${prefix}.${key}` : key

        // Arrays, FieldValue sentinels, and Firestore value types are
        // opaque from flatten's perspective — kept at the path verbatim.
        if (Array.isArray(value) || isFirestoreOpaque(value)) {
            result[path] = value
            continue
        }

        // Plain objects are recursively flattened
        if (isPlainObject(value)) {
            const nested = flattenDiff(value, path)
            Object.assign(result, nested)
            continue
        }

        // Primitives (strings, numbers, booleans, null)
        result[path] = value
    }

    return result
}

/**
 * Merge two diffs together, with the second taking precedence
 */
export const mergeDiffs = <T extends FirestoreObject>(
    first: WithFieldValue<DeepPartial<T>>,
    second: WithFieldValue<DeepPartial<T>>
): WithFieldValue<DeepPartial<T>> => {
    const result = deepClone(first) as Record<string, unknown>

    for (const key of Object.keys(second)) {
        const firstValue = result[key]
        const secondValue = (second as Record<string, unknown>)[key]

        if (isPlainObject(firstValue) && isPlainObject(secondValue)) {
            result[key] = mergeDiffs(
                firstValue as WithFieldValue<DeepPartial<FirestoreObject>>,
                secondValue as WithFieldValue<DeepPartial<FirestoreObject>>
            )
        } else {
            result[key] = secondValue
        }
    }

    return result as WithFieldValue<DeepPartial<T>>
}

/**
 * Apply a diff to an object, returning a new object.
 * The original object is not modified.
 *
 * @example
 * ```ts
 * const original = { name: 'Project', count: 5 }
 * const diff = { name: 'Updated', count: deleteField() }
 * const result = applyDiff(original, diff)
 * // result = { name: 'Updated' }
 * // original is unchanged
 * ```
 */
export const applyDiff = <T extends FirestoreObject>(
    state: T,
    diff: WithFieldValue<DeepPartial<T>>
): T => {
    const result = deepClone(state)
    applyDiffMutable(result, diff as Record<string, unknown>)
    return result
}

/**
 * Compute the undo diff that would reverse the effect of applying a diff to a state.
 *
 * Given a starting state and a diff that was (or will be) applied to it,
 * returns a new diff that when applied to the result would restore the original state.
 *
 * @example
 * ```ts
 * const startState = { name: 'Foo', count: 5 }
 * const diff = { name: 'Bar', count: deleteField() }
 *
 * // Apply the diff
 * const endState = applyDiff(startState, diff)
 * // endState = { name: 'Bar' }
 *
 * // Compute the undo
 * const undoDiff = computeUndoDiff(startState, diff)
 * // undoDiff = { name: 'Foo', count: 5 }
 *
 * // Applying undoDiff to endState restores startState
 * const restored = applyDiff(endState, undoDiff)
 * // restored = { name: 'Foo', count: 5 }
 * ```
 */
export const computeUndoDiff = <T extends FirestoreObject>(
    startState: T,
    diff: WithFieldValue<DeepPartial<T>>
): WithFieldValue<DeepPartial<T>> => {
    const endState = applyDiff(startState, diff)
    return computeDiff(endState, startState)
}

/**
 * Check if a diff affects a specific path (supports dot notation).
 *
 * @example
 * ```ts
 * const diff = { building: { floors: 5 }, name: 'Test' }
 *
 * diffContainsPath(diff, 'name') // true
 * diffContainsPath(diff, 'building') // true
 * diffContainsPath(diff, 'building.floors') // true
 * diffContainsPath(diff, 'building.height') // false
 * diffContainsPath(diff, 'other') // false
 * ```
 */
export const diffContainsPath = (
    diff: Record<string, unknown>,
    path: string
): boolean => {
    const parts = path.split('.')
    let current: unknown = diff

    for (const part of parts) {
        if (current === null || typeof current !== 'object') {
            return false
        }
        if (!(part in (current as Record<string, unknown>))) {
            return false
        }
        current = (current as Record<string, unknown>)[part]
    }

    return true
}

/**
 * Extract the value at a specific path from a diff (supports dot notation).
 * Returns undefined if the path doesn't exist in the diff.
 *
 * @example
 * ```ts
 * const diff = { building: { floors: 5, height: 100 }, name: 'Test' }
 *
 * extractDiffValue(diff, 'name') // 'Test'
 * extractDiffValue(diff, 'building') // { floors: 5, height: 100 }
 * extractDiffValue(diff, 'building.floors') // 5
 * extractDiffValue(diff, 'building.missing') // undefined
 * ```
 */
export const extractDiffValue = (
    diff: Record<string, unknown>,
    path: string
): unknown => {
    const parts = path.split('.')
    let current: unknown = diff

    for (const part of parts) {
        if (current === null || typeof current !== 'object') {
            return undefined
        }
        if (!(part in (current as Record<string, unknown>))) {
            return undefined
        }
        current = (current as Record<string, unknown>)[part]
    }

    return current
}

/**
 * Create a diff that sets a value at a specific path (supports dot notation).
 *
 * @example
 * ```ts
 * createDiffAtPath('name', 'New Name')
 * // { name: 'New Name' }
 *
 * createDiffAtPath('building.floors', 5)
 * // { building: { floors: 5 } }
 *
 * createDiffAtPath('building.config.enabled', true)
 * // { building: { config: { enabled: true } } }
 * ```
 */
export const createDiffAtPath = (
    path: string,
    value: unknown
): Record<string, unknown> => {
    const parts = path.split('.')
    const result: Record<string, unknown> = {}

    let current = result
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]
        if (part === undefined) continue
        current[part] = {}
        current = current[part] as Record<string, unknown>
    }

    const lastPart = parts[parts.length - 1]
    if (lastPart !== undefined) {
        current[lastPart] = value
    }

    return result
}

/**
 * Invert a flattened diff back to nested object structure.
 * Opposite of flattenDiff.
 *
 * @example
 * ```ts
 * const flat = { 'building.floors': 5, 'building.height': 100, 'name': 'Test' }
 * const nested = unflattenDiff(flat)
 * // { building: { floors: 5, height: 100 }, name: 'Test' }
 * ```
 */
export const unflattenDiff = (
    flatDiff: Record<string, unknown>
): Record<string, unknown> => {
    const result: Record<string, unknown> = {}

    for (const [path, value] of Object.entries(flatDiff)) {
        const parts = path.split('.')

        let current = result
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i]
            if (part === undefined) continue
            if (!(part in current) || typeof current[part] !== 'object') {
                current[part] = {}
            }
            current = current[part] as Record<string, unknown>
        }

        const lastPart = parts[parts.length - 1]
        if (lastPart !== undefined) {
            current[lastPart] = value
        }
    }

    return result
}

// ---------------------------------------------------------------------------
// Display overrides
//
// `serverTimestamp()` sentinels need to survive `localState` so the write
// path can ship them to Firestore for server-side expansion (C1). That
// leaves the optimistic UI with a `FieldValue` object sitting at the
// field — components can't render it. The display-override layer
// captures `Timestamp.now()` at the moment a sentinel first enters
// `localState`, stores it keyed by dotted path, and substitutes it into
// the merged view at read time. The captured Timestamp is frozen for the
// lifetime of the sentinel (it doesn't drift forward on re-renders), and
// the entry is dropped automatically once the sentinel leaves
// `localState` — either because the server ack cleared `localState`, or
// because the user overwrote that path with an explicit value.
//
// Scope: only `serverTimestamp()` gets a display override. `increment`,
// `arrayUnion`, and `arrayRemove` would need access to the SDK's
// non-public internal fields (`_operand`, `_elements`) to compute a
// display value; consumers using those should gate their render code on
// the field not being a sentinel.
// ---------------------------------------------------------------------------

/**
 * Walk a state object collecting every dotted path that currently holds
 * a `serverTimestamp()` sentinel. Arrays are not traversed — Firestore
 * doesn't allow sentinels inside arrays. Non-plain objects (Timestamps,
 * DocumentReferences, …) are leaves.
 *
 * @internal
 */
export const collectServerTimestampPaths = (
    state: Record<string, unknown> | null | undefined,
    prefix = '',
    out: Set<string> = new Set()
): Set<string> => {
    if (!state) return out
    for (const key of Object.keys(state)) {
        const value = state[key]
        const path = prefix ? `${prefix}.${key}` : key
        if (isServerTimestamp(value)) {
            out.add(path)
            continue
        }
        if (isPlainObject(value)) {
            collectServerTimestampPaths(value, path, out)
        }
    }
    return out
}

/**
 * Reconcile a `displayOverrides` map against the current `localState`:
 *
 * - For each path that holds a `serverTimestamp()` sentinel but has no
 *   override yet, capture `Timestamp.now()` and store it (frozen-at-
 *   first-sighting).
 * - For each existing override whose path no longer holds a sentinel
 *   (sentinel was overwritten, or `localState` cleared on snapshot ack),
 *   drop it.
 *
 * The map is mutated in place. Pass a custom `now` for deterministic
 * tests; defaults to `Timestamp.now()`.
 *
 * @internal
 */
export const reconcileDisplayOverrides = (
    localState: Record<string, unknown> | null | undefined,
    overrides: Map<string, unknown>,
    now: () => unknown = () => Timestamp.now()
): void => {
    const currentPaths = collectServerTimestampPaths(localState)
    for (const path of currentPaths) {
        if (!overrides.has(path)) {
            overrides.set(path, now())
        }
    }
    for (const path of [...overrides.keys()]) {
        if (!currentPaths.has(path)) {
            overrides.delete(path)
        }
    }
}

const setAtPath = (
    obj: Record<string, unknown>,
    path: string,
    value: unknown
): void => {
    const parts = path.split('.')
    let cur = obj
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!
        if (!isPlainObject(cur[part])) cur[part] = {}
        cur = cur[part] as Record<string, unknown>
    }
    cur[parts[parts.length - 1]!] = value
}

/**
 * Apply a path → value override map to a merged view, returning a new
 * object. Used by document.ts / collection.ts to substitute display
 * values for sentinels still present in `localState`.
 *
 * @internal
 */
export const applyOverridesAtPaths = <T extends FirestoreObject>(
    merged: T,
    overrides: ReadonlyMap<string, unknown>
): T => {
    if (overrides.size === 0) return merged
    const result = deepClone(merged) as Record<string, unknown>
    for (const [path, value] of overrides) {
        setAtPath(result, path, value)
    }
    return result as T
}
