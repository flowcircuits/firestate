import type { WithFieldValue } from 'firebase/firestore'

/**
 * A diff value that replaces a field's whole value instead of merging into it.
 * Create one with {@link replaceField}.
 */
export class ReplaceField<T> {
    readonly value: WithFieldValue<T>

    /** @internal Use {@link replaceField}. */
    constructor(value: WithFieldValue<T>) {
        this.value = value
    }
}

/**
 * Marks a value in an `update()` diff as the field's new whole value.
 *
 * `update()` merges a nested object into the stored one, so keys the diff
 * leaves out survive. `replaceField(value)` makes the field equal `value`:
 * keys the stored object has and `value` lacks are removed. Like
 * `deleteField()`, it can sit at any depth of the diff and affects only that
 * field.
 *
 * The marker never reaches Firestore. It shapes local state, and the write is
 * the difference between the server state and local state, so each removed key
 * is written as `deleteField()` and sibling keys are not touched.
 *
 * @example
 * ```ts
 * // stored: { load: { method: 'DENSITY', density: 2 } }
 * update({ load: replaceField({ method: 'POWER', power: 300 }) })
 * // result: { load: { method: 'POWER', power: 300 } }
 * ```
 */
export const replaceField = <T>(value: WithFieldValue<T>): ReplaceField<T> =>
    new ReplaceField(value)

/** Whether `value` is a {@link replaceField} marker. */
export const isReplaceField = (value: unknown): value is ReplaceField<unknown> =>
    value instanceof ReplaceField
