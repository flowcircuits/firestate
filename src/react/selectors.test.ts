/**
 * Per-hook selectors ("sliced subscriptions"), pure-selector contract.
 *
 * Contract: `useDocument`/`useCollection` accept an optional `selector` that
 * receives the resource's full observable state — `{ data, isLoading, isSynced,
 * error }` for a document, plus `isActive` for a collection — and returns the
 * slice the component reacts to (with an optional `isEqual`). A selected hook
 * re-renders *only* when that slice changes; status the selector did not read
 * can neither re-render the component nor appear on its handle. The returned
 * handle therefore exposes ONLY `data` (the slice) plus the writer surface
 * (`update`/`set`/`delete`/`add`/`remove`/`load`/`sync`) and `ref`. Calling a
 * hook WITHOUT a selector is unchanged: it returns the full handle and
 * re-renders on any field or status change.
 *
 * These tests drive real React renders (react-test-renderer) over the
 * deterministic Firestore harness, counting renders to prove a change to an
 * unselected field — or a status flip the selector ignores — is collapsed. The
 * harness mocks `onSnapshot` + the write functions; fake timers settle
 * `minLoadTime`.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

vi.mock('firebase/firestore', async () => {
    const actual =
        await vi.importActual<typeof import('firebase/firestore')>(
            'firebase/firestore'
        )
    const { buildFirestoreMock } = await import('../__tests__/test-harness')
    return buildFirestoreMock(actual as unknown as Record<string, unknown>)
})

import { createElement, useState } from 'react'
import { create, act, type ReactTestRenderer } from 'react-test-renderer'
import { z } from 'zod'
import { createHarness, type Harness } from '../__tests__/test-harness'
import { useDocument, useCollection, FirestateContext } from './hooks'
import { shallow } from '../utils/shallow'
import { defineDocument, defineCollection } from '../registry/schema'
import { createFirestate, doc, col } from '../registry/firestate'
import { createStore, type FirestateStore } from '../core/store'
import type {
    CollectionHandle,
    CollectionState,
    DocumentHandle,
    DocumentState,
    FirestoreObject,
    SelectedCollectionHandle,
    SelectedDocumentHandle,
} from '../types'

interface Doc extends FirestoreObject {
    name?: string
    age?: number
}

interface Item extends FirestoreObject {
    v?: number
}

// `id` derived from params so changing params rebuilds the subscription.
const docDef = defineDocument<Doc>({
    collection: 'docs',
    id: (p) => p.id ?? 'd1',
    autosave: 0,
    minLoadTime: 0,
})

const itemsDef = defineCollection<Item>({
    path: 'items',
    autosave: 0,
    minLoadTime: 0,
})

const lazyItemsDef = defineCollection<Item>({
    path: (p) => `items/${p.bucket ?? 'b1'}/list`,
    lazy: true,
    autosave: 0,
    minLoadTime: 0,
})

// The public hooks are overloaded (selector present vs. absent). The
// render-counting probes below pass a *possibly-undefined* selector prop, which
// matches neither overload cleanly, so they call through these permissive
// wrappers. Real overload/type coverage lives in `_typeChecks` below.
const callUseDocument = useDocument as unknown as (o: {
    definition: typeof docDef
    params?: Record<string, string>
    selector?: (s: DocumentState<Doc>) => unknown
    isEqual?: (a: unknown, b: unknown) => boolean
}) => DocumentHandle<Doc> | SelectedDocumentHandle<Doc, unknown>

const callUseCollection = useCollection as unknown as (o: {
    definition: typeof itemsDef
    params?: Record<string, string>
    selector?: (s: CollectionState<Item>) => unknown
    isEqual?: (a: unknown, b: unknown) => boolean
}) => CollectionHandle<Item> | SelectedCollectionHandle<Item, unknown>

describe('shallow', () => {
    it('is true for identical and structurally-shallow-equal values', () => {
        expect(shallow(1, 1)).toBe(true)
        const obj = { a: 1 }
        expect(shallow(obj, obj)).toBe(true)
        expect(shallow({ a: 1, b: 2 }, { a: 1, b: 2 })).toBe(true)
        expect(shallow(['x', 'y'], ['x', 'y'])).toBe(true)
    })

    it('is false on any one-level difference or shape mismatch', () => {
        expect(shallow({ a: 1 }, { a: 2 })).toBe(false)
        expect(shallow({ a: 1 }, { a: 1, b: 2 })).toBe(false)
        expect(shallow(['x'], ['x', 'y'])).toBe(false)
        // Nested objects compared by identity, not deeply.
        expect(shallow({ a: { n: 1 } }, { a: { n: 1 } })).toBe(false)
        expect(shallow({ a: 1 }, [1] as unknown as { a: number })).toBe(false)
    })
})

describe('useDocument selector', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined
    let renders = 0
    let latest: DocumentHandle<Doc> | SelectedDocumentHandle<Doc, unknown>

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never })
        renders = 0
    })

    afterEach(() => {
        act(() => {
            renderer?.unmount()
        })
        renderer = undefined
        vi.useRealTimers()
    })

    const Probe = (props: {
        id?: string
        selector?: (s: DocumentState<Doc>) => unknown
        isEqual?: (a: unknown, b: unknown) => boolean
    }): null => {
        renders++
        latest = callUseDocument({
            definition: docDef,
            params: { id: props.id ?? 'd1' },
            selector: props.selector,
            isEqual: props.isEqual,
        })
        return null
    }

    const mount = (props: Parameters<typeof Probe>[0]): void => {
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe, props)
                )
            )
        })
    }

    const fire = (data: Doc | null): void => {
        act(() => {
            h.fireDocSnapshot(data)
            vi.runAllTimers()
        })
    }

    it('narrows data to the slice while keeping the full writer surface', () => {
        mount({ selector: (s) => s.data?.name })
        fire({ name: 'a', age: 1 })

        expect(latest.data).toBe('a')
        expect(typeof latest.update).toBe('function')
        expect(typeof latest.set).toBe('function')
        expect(typeof latest.delete).toBe('function')
        expect(latest.ref?.id).toBe('d1')
    })

    it('does not re-render on an unselected field; re-renders on the slice', () => {
        mount({ selector: (s) => s.data?.name })
        fire({ name: 'a', age: 1 })
        const base = renders

        // age is not in the slice → collapsed, no re-render.
        fire({ name: 'a', age: 2 })
        expect(renders).toBe(base)
        expect(latest.data).toBe('a')

        // name is the slice → re-render.
        fire({ name: 'b', age: 2 })
        expect(renders).toBe(base + 1)
        expect(latest.data).toBe('b')
    })

    it('default isEqual collapses a fresh object of equal shape', () => {
        mount({ selector: (s) => ({ name: s.data?.name }) })
        fire({ name: 'a', age: 1 })
        const base = renders

        // Selector returns a brand-new object each render; default value compare
        // must treat { name: 'a' } === { name: 'a' } and not re-render.
        fire({ name: 'a', age: 2 })
        expect(renders).toBe(base)

        fire({ name: 'c', age: 2 })
        expect(renders).toBe(base + 1)
        expect(latest.data).toEqual({ name: 'c' })
    })

    it('does not re-render on a status change when the slice is constant', () => {
        // The pure-selector contract: a status flip the selector ignores cannot
        // re-render. With a constant slice and a selector that reads no status,
        // the load transition (isLoading true → false) must NOT re-render — the
        // inverse of the pre-pure behavior where status always gated.
        mount({ selector: () => 0 })
        const base = renders

        fire({ name: 'a' })

        expect(renders).toBe(base)
        expect(latest.data).toBe(0)
    })

    it('reacts to status only when the selector reads it; writers hit the full doc', () => {
        // Select both a data slice and a status flag. A write to an UNSELECTED
        // data field still advances the shared state to "pending", which the
        // selected `synced` flag reflects (proving the writer hit the full doc),
        // while the selected `name` stays put.
        mount({
            selector: (s) => ({ name: s.data?.name, synced: s.isSynced }),
        })
        fire({ name: 'a', age: 1 })
        expect(latest.data).toEqual({ name: 'a', synced: true })

        act(() => {
            // Update a field that is NOT in the slice.
            ;(latest as DocumentHandle<Doc>).update({ age: 9 })
        })

        // The write applied to the full doc (pending → not synced); `name` is
        // unchanged but the selected `synced` flag flipped, so we re-rendered.
        expect(latest.data).toEqual({ name: 'a', synced: false })
    })

    it('set replaces the full document, not the narrowed slice', () => {
        // `data` is narrowed to `name`, but `set` still REPLACES the whole
        // document. The committed payload must be the full object the caller
        // passed — never just the selected slice — so a `set` from a narrowed
        // handle cannot silently drop the unselected fields.
        mount({ selector: (s) => s.data?.name })
        fire({ name: 'a', age: 1 })

        act(() => {
            const handle = latest as DocumentHandle<Doc>
            handle.set({ name: 'b', age: 2 })
            // Fire-and-forget: sync() invokes setDoc synchronously (recording
            // the commit) then awaits the ack, which stays pending here.
            void handle.sync()
        })

        const sets = h.pendingCommits().filter((c) => c.kind === 'set')
        expect(sets).toHaveLength(1)
        expect(sets[0]!.data).toEqual({ name: 'b', age: 2 })
    })

    it('rebinds ref to the new document when the slice is value-equal', () => {
        // Constant slice so the selected projection is value-equal across the id
        // change — the rebuilt subscription must still surface the NEW ref, not
        // the previous subscription's (methods/ref are read live).
        mount({ id: 'd1', selector: () => 0 })
        fire({ name: 'a' })
        expect(latest.ref?.id).toBe('d1')

        act(() => {
            renderer!.update(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe, { id: 'd2', selector: () => 0 })
                )
            )
        })

        expect(latest.ref?.id).toBe('d2')
    })

    it('returns the full document object when no selector is given', () => {
        mount({})
        fire({ name: 'a', age: 1 })
        expect(latest.data).toEqual({ name: 'a', age: 1 })
    })

    it('keeps status reactive on a handle with no selector', () => {
        // The no-selector path is unchanged: a status flip with constant data
        // still re-renders, and the full handle exposes the status fields.
        mount({})
        const base = renders
        expect((latest as DocumentHandle<Doc>).isLoading).toBe(true)

        fire({ name: 'a' })
        expect((latest as DocumentHandle<Doc>).isLoading).toBe(false)
        expect(renders).toBe(base + 1)
    })

    it('keeps a stable handle across renders with an inline selector', () => {
        // Contract: handles have stable identity between changes, and an inline
        // `selector` (a fresh function every render) must not penalize that —
        // callers need not memoize it. Re-render WITHOUT touching the slice and
        // assert the handle object is referentially unchanged; otherwise every
        // inline-selector caller hands a new handle to memoized children each
        // parent render.
        let bump = (): void => {}
        const InlineProbe = (): null => {
            const [, setTick] = useState(0)
            bump = () => setTick((t) => t + 1)
            renders++
            // A new selector identity on every render.
            latest = callUseDocument({
                definition: docDef,
                params: { id: 'd1' },
                selector: (s) => s.data?.name,
            })
            return null
        }
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(InlineProbe)
                )
            )
        })
        fire({ name: 'a', age: 1 })
        const handleBefore = latest
        const rendersBefore = renders

        act(() => {
            bump()
        })

        // The component really re-rendered (new inline selector identity)...
        expect(renders).toBeGreaterThan(rendersBefore)
        // ...but the slice and subscription are unchanged, so the handle is too.
        expect(latest).toBe(handleBefore)
    })
})

describe('useCollection selector', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined
    let renders = 0
    let latest: CollectionHandle<Item> | SelectedCollectionHandle<Item, unknown>

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never })
        renders = 0
    })

    afterEach(() => {
        act(() => {
            renderer?.unmount()
        })
        renderer = undefined
        vi.useRealTimers()
    })

    const Probe = (props: {
        selector?: (s: CollectionState<Item>) => unknown
        isEqual?: (a: unknown, b: unknown) => boolean
    }): null => {
        renders++
        latest = callUseCollection({
            definition: itemsDef,
            selector: props.selector,
            isEqual: props.isEqual,
        })
        return null
    }

    const mount = (props: Parameters<typeof Probe>[0]): void => {
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe, props)
                )
            )
        })
    }

    const fire = (docs: Record<string, Item>): void => {
        act(() => {
            h.fireCollectionSnapshot(docs)
            vi.runAllTimers()
        })
    }

    it('sub-selects one doc and collapses changes to other docs (value-equal)', () => {
        mount({ selector: (s) => s.data['a'] })
        fire({ a: { v: 1 }, b: { v: 1 } })
        const base = renders
        // The collection injects the doc id into each record.
        expect(latest.data).toEqual({ v: 1, id: 'a' })

        // Only b changes; a's slice is a fresh-but-value-equal object across the
        // rebase → no re-render (value-based default isEqual, per the contract
        // that unchanged docs may not keep object identity).
        fire({ a: { v: 1 }, b: { v: 2 } })
        expect(renders).toBe(base)

        // a changes → re-render.
        fire({ a: { v: 5 }, b: { v: 2 } })
        expect(renders).toBe(base + 1)
        expect(latest.data).toEqual({ v: 5, id: 'a' })
    })

    it('supports shallow isEqual on a fresh array projection', () => {
        mount({ selector: (s) => Object.keys(s.data), isEqual: shallow })
        fire({ a: { v: 1 }, b: { v: 1 } })
        const base = renders
        expect(latest.data).toEqual(['a', 'b'])

        // Same keys (values changed) → shallow-equal array → no re-render.
        fire({ a: { v: 9 }, b: { v: 9 } })
        expect(renders).toBe(base)

        // A new key → array differs → re-render.
        fire({ a: { v: 9 }, b: { v: 9 }, c: { v: 1 } })
        expect(renders).toBe(base + 1)
        expect(latest.data).toEqual(['a', 'b', 'c'])
    })

    it('returns the full keyed record when no selector is given', () => {
        mount({})
        fire({ a: { v: 1 } })
        expect(latest.data).toEqual({ a: { v: 1, id: 'a' } })
    })
})

describe('useCollection selector + subscription rebuild', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined
    let latest: SelectedCollectionHandle<Item, boolean>

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never })
    })

    afterEach(() => {
        act(() => {
            renderer?.unmount()
        })
        renderer = undefined
        vi.useRealTimers()
    })

    const Probe = (props: { bucket: string }): null => {
        latest = useCollection({
            definition: lazyItemsDef,
            params: { bucket: props.bucket },
            selector: (s) => s.isActive,
        })
        return null
    }

    const render = (bucket: string): void => {
        const el = createElement(
            FirestateContext.Provider,
            { value: store },
            createElement(Probe, { bucket })
        )
        act(() => {
            if (renderer) renderer.update(el)
            else renderer = create(el)
        })
    }

    it('load() attaches the listener on the new path after a rebuild', () => {
        // Lazy + an `isActive` selector: pre-load the slice is `false` on both
        // buckets, so the selected projection is value-equal across the path
        // change — a memoized-methods implementation would hand back the previous
        // subscription's load(). The merge reads methods live, so load() must
        // attach on the NEW path, and the selected `isActive` then flips true.
        render('b1')
        render('b2')

        act(() => {
            latest.load()
            vi.runAllTimers()
        })

        const listeners = h.listeners()
        expect(listeners.length).toBe(1)
        expect((listeners[0]!.ref as { __coll: string }).__coll).toBe(
            'items/b2/list'
        )
        expect(latest.data).toBe(true)
    })
})

describe('createFirestate generated hook selector', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined
    let selected: SelectedDocumentHandle<{ name: string; age: number }, string>

    const ThingSchema = z.object({ name: z.string(), age: z.number() })
    const api = createFirestate({
        thing: doc({ path: 'things/{thingId}', schema: ThingSchema }),
        things: col({ path: 'things', schema: ThingSchema }),
    })

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never })
    })

    afterEach(() => {
        act(() => {
            renderer?.unmount()
        })
        renderer = undefined
        vi.useRealTimers()
    })

    const Probe = (): null => {
        selected = api.useThing(
            { thingId: 't1' },
            { selector: (s) => s.data?.name ?? '' }
        )
        return null
    }

    it('narrows data through the registry hook and keeps writers', () => {
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe)
                )
            )
        })
        act(() => {
            h.fireDocSnapshot({ name: 'hi', age: 3 })
            vi.runAllTimers()
        })

        expect(selected.data).toBe('hi')
        expect(typeof selected.update).toBe('function')
        expect(selected.ref?.id).toBe('t1')
    })
})

describe('createFirestate .select generated hooks', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined
    let renders = 0
    let docSlice: SelectedDocumentHandle<
        { name: string; createdAt: number },
        unknown
    >
    let colSlice: SelectedCollectionHandle<
        { title: string; completed: boolean },
        unknown
    >

    const ListSchema = z.object({ name: z.string(), createdAt: z.number() })
    const TaskSchema = z.object({ title: z.string(), completed: z.boolean() })
    // Schema/path declared ONCE; every slice-hook derives from these.
    const listDoc = doc({ path: 'lists/{listId}', schema: ListSchema })
    const tasksCol = col({ path: 'lists/{listId}/tasks', schema: TaskSchema })

    const api = createFirestate({
        // Base hooks (full handle) coexist as flat siblings with slice hooks.
        list: listDoc,
        tasks: tasksCol,
        listName: listDoc.select((s) => s.data?.name),
        // A comparator baked in that compares only `name` (ignores createdAt).
        listView: listDoc.select(
            (s) => ({ name: s.data?.name, createdAt: s.data?.createdAt }),
            { isEqual: (a, b) => a.name === b.name }
        ),
        taskIds: tasksCol.select((s) => Object.keys(s.data)),
        taskById: tasksCol.select((s, p: { id: string }) => s.data[p.id]),
    })

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never })
        renders = 0
    })

    afterEach(() => {
        act(() => {
            renderer?.unmount()
        })
        renderer = undefined
        vi.useRealTimers()
    })

    const mount = (render: () => void): void => {
        const Probe = (): null => {
            renders++
            render()
            return null
        }
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe)
                )
            )
        })
    }

    const fireDoc = (
        data: { name: string; createdAt: number } | null
    ): void => {
        act(() => {
            h.fireDocSnapshot(data)
            vi.runAllTimers()
        })
    }

    const fireCol = (
        docs: Record<string, { title: string; completed: boolean }>
    ): void => {
        act(() => {
            h.fireCollectionSnapshot(docs)
            vi.runAllTimers()
        })
    }

    it('narrows a document slice and keeps the full writer surface and ref', () => {
        mount(() => {
            docSlice = api.useListName({ listId: 'l1' })
        })
        fireDoc({ name: 'Groceries', createdAt: 1 })

        expect(docSlice.data).toBe('Groceries')
        expect(typeof docSlice.update).toBe('function')
        expect(typeof docSlice.set).toBe('function')
        expect(docSlice.ref?.id).toBe('l1')
    })

    it('threads selector params from the merged bag (collection byId)', () => {
        mount(() => {
            colSlice = api.useTaskById({ listId: 'l1', id: 'b' })
        })
        fireCol({
            a: { title: 'A', completed: false },
            b: { title: 'B', completed: true },
        })

        // The path resolved from `listId`; the selector read `id` from the SAME
        // bag and picked exactly doc 'b' (the collection injects each doc's id).
        expect(colSlice.data).toEqual({ title: 'B', completed: true, id: 'b' })
    })

    it('returns the un-parameterized collection slice (ids)', () => {
        mount(() => {
            colSlice = api.useTaskIds({ listId: 'l1' })
        })
        fireCol({
            a: { title: 'A', completed: false },
            b: { title: 'B', completed: false },
        })

        expect(colSlice.data).toEqual(['a', 'b'])
    })

    it('gates re-renders with the comparator baked into the slice, not the default', () => {
        // useListView bakes in an isEqual comparing only `name`. A snapshot that
        // changes ONLY createdAt must NOT re-render — the default deep compare
        // would — proving the baked-in comparator is what gates this hook.
        mount(() => {
            docSlice = api.useListView({ listId: 'l1' })
        })
        fireDoc({ name: 'a', createdAt: 1 })
        const base = renders
        expect(docSlice.data).toEqual({ name: 'a', createdAt: 1 })

        // Only createdAt changes → collapsed by the baked comparator.
        fireDoc({ name: 'a', createdAt: 2 })
        expect(renders).toBe(base)
        expect(docSlice.data).toEqual({ name: 'a', createdAt: 1 })

        // name changes → re-render.
        fireDoc({ name: 'b', createdAt: 2 })
        expect(renders).toBe(base + 1)
        expect(docSlice.data).toEqual({ name: 'b', createdAt: 2 })
    })

    it('forwards runtime options (enabled) to the underlying hook', () => {
        // enabled:false → no subscription; the slice is the selector applied to
        // the disabled state (data undefined), and there is no ref.
        mount(() => {
            docSlice = api.useListName({ listId: 'l1' }, { enabled: false })
        })

        expect(docSlice.data).toBeUndefined()
        expect(docSlice.ref).toBeUndefined()
    })
})

describe('createFirestate .select shares one subscription per resource', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined

    const ListSchema = z.object({ name: z.string(), n: z.number() })
    const listDoc = doc({ path: 'lists/{listId}', schema: ListSchema })
    // A base hook plus two slice-hooks, all derived from the SAME base entry.
    // (Documents share by string key in this harness; the collection equivalent,
    // which keys on semantic query identity, is covered in hooks.test.ts.)
    const api = createFirestate({
        list: listDoc,
        listName: listDoc.select((s) => s.data?.name),
        listN: listDoc.select((s) => s.data?.n),
    })

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never })
    })

    afterEach(() => {
        act(() => {
            renderer?.unmount()
        })
        renderer = undefined
        vi.useRealTimers()
    })

    const mount = (Probe: () => null): void => {
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe)
                )
            )
        })
    }

    const fireDoc = (data: { name: string; n: number } | null): void => {
        act(() => {
            h.fireDocSnapshot(data)
            vi.runAllTimers()
        })
    }

    it('attaches ONE listener for a base hook and its slice siblings', () => {
        // Regression guard: each generated hook used to build its own definition
        // object, and the shared registry keys by definition identity — so base +
        // two slices forked one onSnapshot listener PER hook on a single
        // resource. createFirestate now memoizes the definition per base entry,
        // so they collapse to one.
        const Probe = (): null => {
            api.useList({ listId: 'l1' })
            api.useListName({ listId: 'l1' })
            api.useListN({ listId: 'l1' })
            return null
        }
        mount(Probe)
        fireDoc({ name: 'A', n: 1 })

        expect(h.listeners().length).toBe(1)
    })

    it('makes an optimistic write through one hook instantly visible to a sibling', () => {
        // The semantic half of sharing: a write through the base handle hits the
        // SAME optimistic state the slice reads, so the sibling sees it WITHOUT a
        // server snapshot. Separate subscriptions would not.
        let full: DocumentHandle<{ name: string; n: number }> | undefined
        let nameSlice:
            | SelectedDocumentHandle<{ name: string; n: number }, unknown>
            | undefined
        const Probe = (): null => {
            full = api.useList({ listId: 'l1' })
            nameSlice = api.useListName({ listId: 'l1' })
            return null
        }
        mount(Probe)
        fireDoc({ name: 'A', n: 1 })
        expect(nameSlice!.data).toBe('A')

        act(() => {
            full!.update({ name: 'B' })
        })

        // No snapshot fired — visibility proves shared optimistic state.
        expect(nameSlice!.data).toBe('B')
    })
})

// Compile-time contract checks (never executed; validated by `tsc --noEmit`).
// They assert the overloads narrow `data` to the selector's output while keeping
// writers on the full type, and that the registry hooks expose the same
// overloads. A selected handle has NO status fields — see the `@ts-expect-error`
// guards below.
export function _typeChecks(): void {
    const fullDef = defineDocument<Doc>({ collection: 'd', id: 'x' })

    const full = useDocument({ definition: fullDef })
    const fullData: Doc | undefined = full.data
    const fullLoading: boolean = full.isLoading
    void fullData
    void fullLoading

    const sliced = useDocument({
        definition: fullDef,
        selector: (s) => s.data?.name ?? '',
    })
    const slice: string = sliced.data
    void slice
    // Writer still takes a full-document diff:
    sliced.update({ age: 1 })
    // A selected handle drops the status fields — reading them is a type error.
    // @ts-expect-error isSynced is not on a selected handle
    void sliced.isSynced

    const api = createFirestate({
        thing: doc({
            path: 'things/{thingId}',
            schema: z.object({ name: z.string(), age: z.number() }),
        }),
    })
    const h1 = api.useThing({ thingId: 't' })
    const n: string = h1.data!.name
    void n
    const h2 = api.useThing(
        { thingId: 't' },
        { selector: (s) => s.data?.age ?? 0 }
    )
    const age: number = h2.data
    void age
    h2.update({ name: 'y' })
}
