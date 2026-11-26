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

import { deleteField, FieldPath } from 'firebase/firestore'
import { createHarness, type Harness } from './test-harness'
import { createCollectionSubscription } from '../core/collection'
import { createDocumentSubscription } from '../core/document'
import { defineCollection, defineDocument } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'
import { replaceField } from '../utils/replace-field'
import type { UpdateDiff } from '../types'

type Load =
    | { method: 'DENSITY'; density: number }
    | { method: 'POWER'; power: number }

interface Doc {
    name?: string
    load?: Load
}

interface Item extends Doc {
    id?: string
}

const docDef = defineDocument<Doc>({ collection: 'docs', id: 'd1' })
const itemsDef = defineCollection<Item>({ path: 'items' })

const OLD: Doc = { name: 'Office', load: { method: 'DENSITY', density: 2 } }
const POWER = replaceField<Load>({ method: 'POWER', power: 300 })

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
            const subscribe = () => {
                const sub = subscriptions[kind]()
                sub.fireSnapshot(OLD)
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
