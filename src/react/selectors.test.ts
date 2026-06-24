/**
 * Per-hook selectors ("sliced subscriptions").
 *
 * Contract: `useDocument`/`useCollection` accept an optional `selector` that
 * narrows the returned `data` to a slice, plus an optional `isEqual`. The hook
 * still returns a *full* handle — writers (`update`/`set`/`delete`/`add`/
 * `remove`), `ref`, and status fields are unchanged; only `data` is the slice.
 * A component re-renders only when its slice changes (per `isEqual`) or a status
 * field changes, NOT on every field of the document/collection.
 *
 * These tests drive real React renders (react-test-renderer) over the
 * deterministic Firestore harness, counting renders to prove a change to an
 * unselected field is collapsed. The harness mocks `onSnapshot` + the write
 * functions; fake timers settle `minLoadTime`.
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

import { createElement } from 'react'
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
    DocumentHandle,
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
    selector?: (d: Doc | undefined) => unknown
    isEqual?: (a: unknown, b: unknown) => boolean
}) => DocumentHandle<Doc> | SelectedDocumentHandle<Doc, unknown>

const callUseCollection = useCollection as unknown as (o: {
    definition: typeof itemsDef
    params?: Record<string, string>
    selector?: (d: Record<string, Item>) => unknown
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
        selector?: (d: Doc | undefined) => unknown
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
        mount({ selector: (d) => d?.name })
        fire({ name: 'a', age: 1 })

        expect(latest.data).toBe('a')
        expect(typeof latest.update).toBe('function')
        expect(typeof latest.set).toBe('function')
        expect(typeof latest.delete).toBe('function')
        expect(latest.ref?.id).toBe('d1')
        expect(latest.isLoading).toBe(false)
    })

    it('does not re-render on an unselected field; re-renders on the slice', () => {
        mount({ selector: (d) => d?.name })
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
        mount({ selector: (d) => ({ name: d?.name }) })
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

    it('re-renders on a status change even when the slice is constant', () => {
        // Constant slice: only status (isLoading) moves it.
        mount({ selector: () => 0 })
        const base = renders
        expect(latest.isLoading).toBe(true)

        fire({ name: 'a' })
        expect(latest.isLoading).toBe(false)
        expect(renders).toBe(base + 1)
        expect(latest.data).toBe(0)
    })

    it('writers target the full document while data stays narrowed', () => {
        mount({ selector: (d) => d?.name })
        fire({ name: 'a', age: 1 })
        expect(latest.isSynced).toBe(true)

        act(() => {
            // Update a field that is NOT in the slice.
            ;(latest as DocumentHandle<Doc>).update({ age: 9 })
        })

        // The write applied to the full doc (pending → not synced), but the
        // selected slice is unchanged.
        expect(latest.isSynced).toBe(false)
        expect(latest.data).toBe('a')
    })

    it('set replaces the full document, not the narrowed slice', () => {
        // `data` is narrowed to `name`, but `set` still REPLACES the whole
        // document. The committed payload must be the full object the caller
        // passed — never just the selected slice — so a `set` from a narrowed
        // handle cannot silently drop the unselected fields.
        mount({ selector: (d) => d?.name })
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
        selector?: (d: Record<string, Item>) => unknown
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
        mount({ selector: (data) => data['a'] })
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
        mount({ selector: (data) => Object.keys(data), isEqual: shallow })
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
    let latest: SelectedCollectionHandle<Item, number>

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
            selector: () => 0,
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
        // Lazy + constant selector: the selected projection AND status are
        // value-equal across the path change (lazy starts isLoading:false,
        // isActive:false), so a memoized-methods implementation would hand back
        // the previous subscription's load(). The merge reads methods live, so
        // load() must attach on the NEW path.
        render('b1')
        render('b2')

        act(() => {
            ;(latest as SelectedCollectionHandle<Item, number>).load()
            vi.runAllTimers()
        })

        const listeners = h.listeners()
        expect(listeners.length).toBe(1)
        expect((listeners[0]!.ref as { __coll: string }).__coll).toBe(
            'items/b2/list'
        )
        expect(latest.isActive).toBe(true)
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
            { selector: (t) => t?.name ?? '' }
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

// Compile-time contract checks (never executed; validated by `tsc --noEmit`).
// They assert the overloads narrow `data` while keeping writers on the full
// type, and that the registry hooks expose the same overloads.
export function _typeChecks(): void {
    const fullDef = defineDocument<Doc>({ collection: 'd', id: 'x' })

    const full = useDocument({ definition: fullDef })
    const fullData: Doc | undefined = full.data
    void fullData

    const sliced = useDocument({
        definition: fullDef,
        selector: (d) => d?.name ?? '',
    })
    const slice: string = sliced.data
    void slice
    // Writer still takes a full-document diff:
    sliced.update({ age: 1 })

    const api = createFirestate({
        thing: doc({
            path: 'things/{thingId}',
            schema: z.object({ name: z.string(), age: z.number() }),
        }),
    })
    const h1 = api.useThing({ thingId: 't' })
    const n: string = h1.data!.name
    void n
    const h2 = api.useThing({ thingId: 't' }, { selector: (t) => t?.age ?? 0 })
    const age: number = h2.data
    void age
    h2.update({ name: 'y' })
}
