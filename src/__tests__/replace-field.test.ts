/**
 * `replaceField(value)` in `update()` diffs, through document and collection
 * subscriptions: local state, the computed write, undo/redo, two updates
 * coalesced before a sync, and the rebase over a concurrent remote edit.
 *
 * The marker only shapes local state. The write is `computeDiff(syncState,
 * localState)`, so a key the replacement drops is written as `deleteField()`
 * and sibling fields are not written at all.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('firebase/firestore', async () => {
    const actual =
        await vi.importActual<typeof import('firebase/firestore')>(
            'firebase/firestore'
        )
    const { buildFirestoreMock } = await import('./test-harness')
    return buildFirestoreMock(actual as unknown as Record<string, unknown>)
})

import {
    deleteField,
    FieldPath,
    serverTimestamp,
    type Timestamp,
    type WithFieldValue,
} from 'firebase/firestore'
import { createHarness, type Harness } from './test-harness'
import { createCollectionSubscription } from '../core/collection'
import { createDocumentSubscription } from '../core/document'
import { defineCollection, defineDocument } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'
import { isReplaceField, replaceField } from '../utils/replace-field'
import type { DeepPartial, UpdateDiff } from '../types'

type Load =
    | { method: 'DENSITY'; density: number }
    | { method: 'POWER'; power: number }

interface Doc {
    name?: string
    load?: Load
    rows?: { x: number }[]
    obj?: Record<string, unknown> | null
}

interface Item extends Doc {
    id?: string
}

const docDef = defineDocument<Doc>({ collection: 'docs', id: 'd1' })
const itemsDef = defineCollection<Item>({ path: 'items' })

const OLD: Doc = { name: 'Office', load: { method: 'DENSITY', density: 2 } }
const POWER = replaceField<Load>({ method: 'POWER', power: 300 })

/** Whether a ReplaceField instance is anywhere in `value`. */
const hasMarker = (value: unknown): boolean =>
    isReplaceField(value) ||
    (Array.isArray(value) && value.some(hasMarker)) ||
    (typeof value === 'object' &&
        value !== null &&
        Object.getPrototypeOf(value) === Object.prototype &&
        Object.values(value).some(hasMarker))

/** The write for a replaced `load`: the new keys, then the dropped one. */
const replacedLoadArgs = (power: number) => [
    new FieldPath('load', 'method'),
    'POWER',
    new FieldPath('load', 'power'),
    power,
    new FieldPath('load', 'density'),
    deleteField(),
]

describe('replaceField', () => {
    let store: FirestateStore
    let h: Harness

    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.spyOn(console, 'warn').mockImplementation(() => {})
        // autosave: 0 → every write is driven by sync(), so the order of
        // updates, snapshots, and commits is deterministic.
        store = createStore({ firestore: {} as never, autosave: 0 })
        h = createHarness()
    })

    const onPushUndo = (
        undo: () => void,
        redo: () => void,
        options?: { undoGroupId?: string }
    ) => store.undoManager.push({ undo, redo, groupId: options?.undoGroupId })

    /**
     * One API over both handle kinds. A document reads and writes its own
     * fields; a collection reads and writes document `X`.
     */
    const subscriptions = {
        document: () => {
            const sub = createDocumentSubscription({
                store,
                definition: docDef,
                docId: 'd1',
                collectionPath: 'docs',
                onPushUndo,
            })
            sub.load()
            return {
                fireSnapshot: (data: Doc) => h.fireDocConfirmed(data),
                update: (diff: UpdateDiff<Doc>) => sub.getHandle().update(diff),
                data: () => sub.getState().data,
                /** The field paths and values the sync wrote. */
                syncArgs: async () => {
                    const p = sub.sync()
                    await h.flushMicrotasks()
                    const commit = h.pendingCommits()[0]!
                    expect(commit.kind).toBe('update')
                    h.resolveNextCommit()
                    await p
                    return commit.fieldArgs
                },
            }
        },
        collection: () => {
            const sub = createCollectionSubscription({
                store,
                definition: itemsDef,
                collectionPath: 'items',
                onPushUndo,
            })
            sub.load()
            return {
                fireSnapshot: (data: Doc) => h.fireCollectionSnapshot({ X: data }),
                update: (diff: UpdateDiff<Doc>) =>
                    sub.getHandle().update({ X: diff }),
                data: () => {
                    const { id: _id, ...item } = sub.getState().data.X ?? {}
                    return item
                },
                syncArgs: async () => {
                    const p = sub.sync()
                    await h.flushMicrotasks()
                    const commit = h.pendingCommits()[0]!
                    expect(commit.kind).toBe('batch')
                    expect(commit.ops).toHaveLength(1)
                    const [op] = commit.ops!
                    expect(op!.type).toBe('update')
                    expect((op!.ref as { id: string }).id).toBe('X')
                    h.resolveNextCommit()
                    await p
                    return op!.fieldArgs
                },
            }
        },
    }

    describe.each(Object.keys(subscriptions) as (keyof typeof subscriptions)[])(
        'on a %s',
        (kind) => {
            const subscribe = (initial: Doc = OLD) => {
                const sub = subscriptions[kind]()
                sub.fireSnapshot(initial)
                return sub
            }

            it('replaces the field locally and writes deleteField() for the dropped key only', async () => {
                const sub = subscribe()

                sub.update({ load: POWER })

                expect(sub.data()).toEqual({
                    name: 'Office',
                    load: { method: 'POWER', power: 300 },
                })
                expect(await sub.syncArgs()).toEqual(replacedLoadArgs(300))
            })

            it('unwraps markers inside an array before state and the write', async () => {
                const sub = subscribe()

                sub.update({
                    rows: [{ x: replaceField(2) }, replaceField({ x: 3 })],
                })

                expect(sub.data()?.rows).toEqual([{ x: 2 }, { x: 3 }])
                expect(hasMarker(sub.data())).toBe(false)
                const args = await sub.syncArgs()
                expect(args).toEqual([
                    new FieldPath('rows'),
                    [{ x: 2 }, { x: 3 }],
                ])
                expect(hasMarker(args)).toBe(false)
            })

            it('writes an empty map that replaces null', async () => {
                const sub = subscribe({ ...OLD, obj: null })

                sub.update({ obj: replaceField({}) })

                expect(sub.data()?.obj).toEqual({})
                expect(await sub.syncArgs()).toEqual([new FieldPath('obj'), {}])
            })

            it('writes an empty map inside a replacement, and redoes it', async () => {
                const sub = subscribe({ ...OLD, obj: { old: 1 } })

                sub.update({ obj: replaceField({ empty: {} }) })
                expect(sub.data()?.obj).toEqual({ empty: {} })

                await store.undoManager.undo()
                expect(sub.data()?.obj).toEqual({ old: 1 })
                await store.undoManager.redo()
                expect(sub.data()?.obj).toEqual({ empty: {} })

                expect(await sub.syncArgs()).toEqual([
                    new FieldPath('obj', 'empty'),
                    {},
                    new FieldPath('obj', 'old'),
                    deleteField(),
                ])
            })

            it('restores the replaced object exactly on undo, and the replacement on redo', async () => {
                const sub = subscribe()
                sub.update({ load: POWER })

                await store.undoManager.undo()
                expect(sub.data()).toEqual(OLD)

                await store.undoManager.redo()
                expect(sub.data()).toEqual({
                    name: 'Office',
                    load: { method: 'POWER', power: 300 },
                })
            })

            it('applies a merge after a replace onto the replacement', async () => {
                const sub = subscribe()

                sub.update({ load: POWER })
                sub.update({ load: { power: 400 } })

                expect(sub.data()?.load).toEqual({ method: 'POWER', power: 400 })
                expect(await sub.syncArgs()).toEqual(replacedLoadArgs(400))
            })

            it('drops an earlier merged key when a replace follows it', async () => {
                const sub = subscribe()

                sub.update({ load: { density: 5 } })
                sub.update({ load: POWER })

                expect(sub.data()?.load).toEqual({ method: 'POWER', power: 300 })
                expect(await sub.syncArgs()).toEqual(replacedLoadArgs(300))
            })

            it('keeps a remote sibling edit that arrives while the replace is pending', async () => {
                const sub = subscribe()
                sub.update({ load: POWER })

                sub.fireSnapshot({ ...OLD, name: 'Remote' })

                expect(sub.data()).toEqual({
                    name: 'Remote',
                    load: { method: 'POWER', power: 300 },
                })
                // The write leaves `name` to the server.
                expect(await sub.syncArgs()).toEqual(replacedLoadArgs(300))
            })

            it('keeps the replacement over a remote edit inside the replaced object', async () => {
                const sub = subscribe()
                sub.update({ load: POWER })

                sub.fireSnapshot({
                    ...OLD,
                    load: { method: 'DENSITY', density: 9 },
                })

                expect(sub.data()?.load).toEqual({ method: 'POWER', power: 300 })
                expect(await sub.syncArgs()).toEqual(replacedLoadArgs(300))
            })
        }
    )

    it('rejects a replacement of the wrong type', () => {
        const sub = subscriptions.document()
        sub.fireSnapshot(OLD)

        // @ts-expect-error `power` must be a number
        sub.update({ load: replaceField({ method: 'POWER', power: 'high' }) })
    })
})

interface TypedDoc {
    load?: Load
    obj?: { nested: { x: number; y?: number } }
    rows?: { x: number; tags?: string[] }[]
    at?: Timestamp
    pair?: [string, number]
    readonlyPair?: readonly [string, number]
    measured?: { value: number; label: string }
    counts?: Record<string, number>
}

/**
 * Compile-only (never called): `update()` diffs accept every replacement
 * payload the runtime supports, keep legacy diffs assignable, and reject a
 * value of the wrong type for its field.
 */
const typeChecks = (
    update: (diff: UpdateDiff<TypedDoc>) => void,
    updateCollection: (diff: UpdateDiff<Record<string, TypedDoc>>) => void,
    next: Load,
    legacy: WithFieldValue<DeepPartial<TypedDoc>>
) => {
    // Literals keep their types, so a union field accepts them.
    update({ load: replaceField({ method: 'POWER', power: 300 }) })
    const standalone = replaceField({ method: 'DENSITY', density: 1 })
    update({ load: standalone })
    // A value typed as a union.
    update({ load: replaceField(next) })
    // Nested markers, and sentinels inside a replacement.
    update({ obj: replaceField({ nested: replaceField({ x: 1 }) }) })
    update({ obj: replaceField({ nested: { x: deleteField() } }) })
    update({ obj: replaceField({ nested: { x: 1, y: serverTimestamp() } }) })
    update({ obj: { nested: replaceField({ x: 2 }) } })
    // Arrays, with markers inside their members.
    update({ rows: replaceField([{ x: 1, tags: ['a'] }]) })
    update({ rows: [{ x: replaceField(2) }] })
    // Diffs typed the pre-0.3.0 way.
    update(legacy)
    const widen = <T extends object>(
        diff: WithFieldValue<DeepPartial<T>>
    ): UpdateDiff<T> => diff
    void widen

    // @ts-expect-error `power` must be a number
    update({ load: replaceField({ method: 'POWER', power: 'high' }) })
    // @ts-expect-error a POWER load needs `power`
    update({ load: replaceField({ method: 'POWER' }) })
    // @ts-expect-error `x` must be a number, even in a nested marker
    update({ obj: replaceField({ nested: replaceField({ x: 'one' }) }) })
    // @ts-expect-error `method` must be a known variant
    update({ load: replaceField({ method: 'OTHER', power: 1 }) })

    // A sentinel can be the whole replacement.
    update({ at: replaceField(serverTimestamp()), load: replaceField(deleteField()) })
    updateCollection({
        a: { at: replaceField(serverTimestamp()), load: replaceField(deleteField()) },
    })
    // @ts-expect-error a Timestamp field does not take a number
    update({ at: replaceField(42) })

    // Tuples keep their length and positions, mutable or readonly.
    update({ pair: replaceField(['a', 1]), readonlyPair: replaceField(['a', 1]) })
    // @ts-expect-error too short
    update({ pair: replaceField([]) })
    // @ts-expect-error wrong order
    update({ pair: replaceField([42, 'wrong']) })
    // @ts-expect-error too short
    update({ readonlyPair: replaceField([]) })
    // @ts-expect-error wrong order
    update({ readonlyPair: replaceField([42, 'wrong']) })
    // @ts-expect-error too long
    updateCollection({ a: { pair: replaceField(['ok', 1, 2]) } })

    // A marker is checked by its payload, not by its own properties, even
    // when the field's object has a `value` key or an index signature.
    update({ measured: replaceField({ value: 1, label: 'kW' }) })
    update({ measured: { value: 2 }, counts: { a: 1 } })
    update({ counts: replaceField({ a: 1 }) })
    // @ts-expect-error a number is not a { value, label } object
    update({ measured: replaceField(123) })
    // @ts-expect-error a number is not a { value, label } object
    updateCollection({ a: { measured: replaceField(123) } })
    // @ts-expect-error a string is not a Record<string, number>
    update({ counts: replaceField('x') })
}
void typeChecks
