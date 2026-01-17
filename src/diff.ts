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

    if (a instanceof Timestamp && b instanceof Timestamp) {
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

        // Primitives are compared directly
        if (toValue !== undefined && fromValue !== toValue) {
            diff[key] = toValue
        }
    }

    // Check for removed fields
    for (const key of Object.keys(from)) {
        if (to[key] === undefined || to[key] === null) {
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
    const deleteFieldSentinel = deleteField()
    const serverTimestampSentinel = serverTimestamp()

    for (const key of Object.keys(diff)) {
        const value = (diff as Record<string, unknown>)[key]

        // Handle deleteField sentinel
        if (
            value !== null &&
            typeof value === 'object' &&
            'isEqual' in value &&
            typeof value.isEqual === 'function'
        ) {
            if ((value as { isEqual: (v: unknown) => boolean }).isEqual(deleteFieldSentinel)) {
                delete (target as Record<string, unknown>)[key]
                continue
            }
            if ((value as { isEqual: (v: unknown) => boolean }).isEqual(serverTimestampSentinel)) {
                ;(target as Record<string, unknown>)[key] = Timestamp.now()
                continue
            }
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
 * Create a deep clone of an object that's safe for Firestore operations
 */
export const deepClone = <T>(value: T): T => {
    if (value === null || typeof value !== 'object') {
        return value
    }

    if (value instanceof Timestamp) {
        return new Timestamp(value.seconds, value.nanoseconds) as T
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
 * Check if a value is a Firestore FieldValue sentinel (deleteField, serverTimestamp, etc.)
 */
const isFieldValueSentinel = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false
    return 'isEqual' in value && typeof (value as { isEqual: unknown }).isEqual === 'function'
}

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
 * Arrays and FieldValue sentinels (deleteField, serverTimestamp) are NOT flattened
 * and are preserved at their path.
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

        // FieldValue sentinels (deleteField, serverTimestamp, etc.) are kept as-is
        if (isFieldValueSentinel(value)) {
            result[path] = value
            continue
        }

        // Arrays are replaced entirely, not flattened
        if (Array.isArray(value)) {
            result[path] = value
            continue
        }

        // Timestamps are kept as-is
        if (value instanceof Timestamp) {
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
