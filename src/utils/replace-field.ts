import type {
    Bytes,
    DocumentReference,
    FieldValue,
    GeoPoint,
    Timestamp,
    VectorValue,
} from 'firebase/firestore'

/** Values written whole: never mapped field by field. */
type Leaf =
    | string
    | number
    | boolean
    | bigint
    | symbol
    | null
    | undefined
    | FieldValue
    | Timestamp
    | GeoPoint
    | Bytes
    | DocumentReference
    | VectorValue

/**
 * A value {@link replaceField} accepts for a field of type `T`: `T`, where any
 * nested field may also be a Firestore `FieldValue` such as `deleteField()`,
 * or another `replaceField` marker. Sentinels and Firestore value types are
 * leaves, never mapped. Tuples keep their length and positions, and arrays
 * and tuples are `readonly`, so a literal inferred as `const` fits.
 */
export type ReplacementValue<T> = unknown extends T
    ? T
    : T extends Leaf
      ? T
      : T extends readonly unknown[]
        ? { readonly [K in keyof T]: ReplacementMember<T[K]> }
        : { [K in keyof T]: ReplacementMember<T[K]> }

/**
 * What a marker for a field of type `T` may hold: a {@link ReplacementValue},
 * or a `FieldValue` sentinel that replaces the field (`deleteField()` deletes
 * it, `serverTimestamp()` sets the server time).
 */
export type ReplacementPayload<T> = ReplacementValue<T> | FieldValue

type ReplacementMember<T> =
    | ReplacementPayload<T>
    | ReplaceField<ReplacementPayload<T>>

/**
 * A diff value that replaces a field's whole value instead of merging into it.
 * Create one with {@link replaceField}.
 */
/**
 * A diff value that replaces a field's whole value instead of merging into it.
 * Create one with {@link replaceField}.
 */
export class ReplaceField<T> {
    readonly value: T

    /** @internal Use {@link replaceField}. */
    constructor(value: T) {
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
 * `value` keeps its literal types, and TypeScript checks it against the
 * field's type (see {@link ReplacementValue}).
 *
 * @example
 * ```ts
 * // stored: { load: { method: 'DENSITY', density: 2 } }
 * update({ load: replaceField({ method: 'POWER', power: 300 }) })
 * // result: { load: { method: 'POWER', power: 300 } }
 * ```
 */
export const replaceField = <const V>(value: V): ReplaceField<V> =>
    new ReplaceField(value)

/** Whether `value` is a {@link replaceField} marker. */
export const isReplaceField = (value: unknown): value is ReplaceField<unknown> =>
    value instanceof ReplaceField
