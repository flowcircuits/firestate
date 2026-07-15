/**
 * Shared, ref-counted subscriptions keyed by (path, query).
 *
 * Contract: multiple `useDocument` / `useCollection` calls for the same resource
 * transparently share ONE `onSnapshot` listener and ONE reconciled/optimistic
 * state. A write through any handle is instantly visible to every reader on that
 * resource (the headline guarantee that makes per-hook selectors "just work").
 * Lifecycle is ref-counted and lazy: the listener attaches on the first
 * activation and tears down only when the last subscriber unmounts; a fresh
 * mount afterwards starts a new subscription.
 *
 * Document identity is a string key (path + id), so these tests drive the
 * deterministic harness (which mocks the query builders). `readOnly` is NOT part
 * of that key — it is a per-handle capability over the shared state, exercised
 * below. Collection sharing keys on semantic *query* identity via `queryEqual`,
 * which needs real Query objects — those tests live in `hooks.test.ts`, where
 * only `onSnapshot` is mocked.
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
import { onSnapshot } from 'firebase/firestore'
import { createHarness, type Harness } from '../__tests__/test-harness'
import { useDocument, FirestateContext } from './hooks'
import { getDocumentShared } from '../core/shared-subscription'
import { defineDocument } from '../registry/schema'
import { createStore, type FirestateStore } from '../core/store'
import type { DocumentHandle, DocumentState, FirestoreObject } from '../types'

interface Doc extends FirestoreObject {
    name?: string
    age?: number
}

const docDef = defineDocument<Doc>({
    collection: 'docs',
    id: (p) => p.id ?? 'd1',
    autosave: 0,
    minLoadTime: 0,
})

describe('shared document subscriptions', () => {
    let store: FirestateStore
    let h: Harness
    let handles: Record<string, DocumentHandle<Doc>>
    let renders: Record<string, number>

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never })
        handles = {}
        renders = {}
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    const Probe = (props: {
        tag: string
        id?: string
        readOnly?: boolean
        undoable?: boolean
        selector?: (s: DocumentState<Doc>) => unknown
    }): null => {
        renders[props.tag] = (renders[props.tag] ?? 0) + 1
        handles[props.tag] = useDocument({
            definition: docDef,
            params: { id: props.id ?? 'd1' },
            readOnly: props.readOnly,
            undoable: props.undoable,
            // The render-counting probes pass a possibly-undefined selector,
            // which matches neither overload cleanly — cast through.
            selector: props.selector,
        } as never) as DocumentHandle<Doc>
        return null
    }

    /** Mount one probe in its own renderer (so it can unmount independently). */
    const mountProbe = (
        props: Parameters<typeof Probe>[0]
    ): ReactTestRenderer => {
        let renderer!: ReactTestRenderer
        act(() => {
            renderer = create(
                createElement(
                    FirestateContext.Provider,
                    { value: store },
                    createElement(Probe, props)
                )
            )
        })
        return renderer
    }

    const fire = (data: Doc | null): void => {
        act(() => {
            h.fireDocSnapshot(data)
            vi.runAllTimers()
        })
    }

    it('shares one listener and one state across hooks on the same path', () => {
        mountProbe({ tag: 'a' })
        mountProbe({ tag: 'b' })
        mountProbe({ tag: 'c' })

        // One listener for three hooks on the same document — flat listener count.
        expect(h.listeners()).toHaveLength(1)

        fire({ name: 'x', age: 1 })

        // The single snapshot reached every hook.
        expect(handles.a!.data).toEqual({ name: 'x', age: 1 })
        expect(handles.b!.data).toEqual({ name: 'x', age: 1 })
        expect(handles.c!.data).toEqual({ name: 'x', age: 1 })
    })

    it('makes a write through one handle instantly visible to every reader', () => {
        mountProbe({ tag: 'a' })
        mountProbe({ tag: 'b' })
        fire({ name: 'x', age: 1 })

        act(() => {
            handles.a!.update({ name: 'y' })
        })

        // The optimistic edit is shared state — the other handle sees it
        // immediately, and the one shared subscription reports unsynced (sync
        // state lives on the store / sync-status hook, not the default handle).
        expect(handles.b!.data).toEqual({ name: 'y', age: 1 })
        expect(store.isSynced).toBe(false)
    })

    it('does not record undo actions by default', () => {
        mountProbe({ tag: 'a' })
        fire({ name: 'x', age: 1 })

        act(() => {
            handles.a!.update({ name: 'y' })
        })

        expect(store.undoManager.canUndo).toBe(false)
    })

    it('records undo actions when the resource opts in', () => {
        mountProbe({ tag: 'a', undoable: true })
        fire({ name: 'x', age: 1 })

        act(() => {
            handles.a!.update({ name: 'y' })
        })

        expect(store.undoManager.canUndo).toBe(true)
    })

    it('drives a selector reader from the shared state', () => {
        // A selector reader and a full reader on the same path share one
        // subscription; a write to an unselected field collapses the selector
        // reader's render but still reaches the full reader.
        mountProbe({ tag: 'full' })
        mountProbe({ tag: 'name', selector: (s) => s.data?.name })
        fire({ name: 'x', age: 1 })

        const nameRendersBefore = renders.name

        // A snapshot changing only the unselected `age` field (no status change).
        fire({ name: 'x', age: 2 })

        // age is not in the name-selector's slice → no re-render there...
        expect(renders.name).toBe(nameRendersBefore)
        // ...but the shared state advanced and the full reader sees it.
        expect(handles.full!.data).toEqual({ name: 'x', age: 2 })
        expect(handles.name!.data).toBe('x')
    })

    it('ref-counts the listener: torn down only when the last hook unmounts', () => {
        const r1 = mountProbe({ tag: 'a' })
        const r2 = mountProbe({ tag: 'b' })
        fire({ name: 'x' })

        expect(h.listeners()).toHaveLength(1)
        const { unsubscribe } = h.listeners()[0]!

        // First unmount: another subscriber remains, so the listener stays up.
        act(() => r1.unmount())
        expect(unsubscribe).not.toHaveBeenCalled()

        // Last unmount: the listener is torn down.
        act(() => r2.unmount())
        expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    it('keeps distinct paths on independent subscriptions', () => {
        mountProbe({ tag: 'a', id: 'd1' })
        mountProbe({ tag: 'b', id: 'd2' })

        // Different doc ids → different keys → two listeners, not shared.
        expect(h.listeners()).toHaveLength(2)
    })

    it('shares one listener and state across a writable and a read-only hook', () => {
        // The motivating case: a writable "provider" (sole writer) and a
        // read-only "leaf" on the same document. readOnly is a per-handle
        // capability, not a state fork — both resolve ONE listener and ONE
        // optimistic state, so a write through the writer is instantly visible
        // to the read-only reader.
        mountProbe({ tag: 'writer' })
        mountProbe({ tag: 'reader', readOnly: true })

        // readOnly is not part of the share key → one listener for both.
        expect(h.listeners()).toHaveLength(1)

        fire({ name: 'x', age: 1 })
        expect(handles.writer!.data).toEqual({ name: 'x', age: 1 })
        expect(handles.reader!.data).toEqual({ name: 'x', age: 1 })

        // Write through the writable handle (autosave: 0 so it stays optimistic).
        act(() => {
            handles.writer!.update({ name: 'y' })
        })
        // The read-only leaf sees the optimistic edit immediately, and the
        // shared state reports unsynced.
        expect(handles.reader!.data).toEqual({ name: 'y', age: 1 })
        expect(store.isSynced).toBe(false)
    })

    it('neuters writers on a read-only handle without forking state', () => {
        mountProbe({ tag: 'writer' })
        mountProbe({ tag: 'reader', readOnly: true })
        fire({ name: 'x', age: 1 })

        // update/set/delete on the read-only handle are no-ops: the shared
        // state is untouched and stays synced.
        act(() => {
            handles.reader!.update({ name: 'z' })
            handles.reader!.set({ name: 'z', age: 9 })
            handles.reader!.delete()
        })
        expect(handles.writer!.data).toEqual({ name: 'x', age: 1 })
        expect(handles.reader!.data).toEqual({ name: 'x', age: 1 })
        expect(store.isSynced).toBe(true)
    })

    it('re-registers an evicted entry on re-acquire so siblings still share it', () => {
        // Reproduces the StrictMode pattern: a facade is acquired, released to
        // zero (evicting the entry), then re-acquired on the SAME facade. A
        // sibling resolving the resource afterwards must find the revived entry
        // and share it — not start a second, divergent subscription.
        const shared = getDocumentShared({
            store,
            definition: docDef,
            collectionPath: 'docs',
            docId: 'd1',
        })
        const release = shared.acquire(() => {})
        shared.load()
        release() // ref count hits zero → entry stopped + evicted

        const release2 = shared.acquire(() => {}) // revives + re-registers

        // A sibling resolving the same resource gets the revived entry, proven
        // by the identical (cached) shared handle.
        const sibling = getDocumentShared({
            store,
            definition: docDef,
            collectionPath: 'docs',
            docId: 'd1',
        })
        expect(sibling.getHandle()).toBe(shared.getHandle())
        release2()
    })

    it('serves fresh state (not the stopped subscription) when an evicted entry is revived', () => {
        // The revival path (the SAME facade re-acquired after release-to-zero,
        // e.g. StrictMode's mount/unmount/mount) must rebuild a fresh
        // subscription. The evicted entry's subscription was stop()ed, and
        // stop() leaves its loaded/loading state intact — so revival must not
        // reuse it, or a late joiner would see isLoading:false + stale data
        // with no loading phase, violating "a subsequent mount starts a fresh
        // subscription".
        const shared = getDocumentShared({
            store,
            definition: docDef,
            collectionPath: 'docs',
            docId: 'd1',
        })
        const release = shared.acquire(() => {})
        shared.load()
        fire({ name: 'x', age: 1 })

        // First lifecycle is fully loaded.
        expect(shared.getHandle().isLoaded).toBe(true)
        expect(shared.getHandle().data).toEqual({ name: 'x', age: 1 })

        release() // ref count hits zero → stopped + evicted

        // Revive on the same facade: the handle must read as a brand-new
        // subscription — not loaded, no data — not the stale stopped one.
        const release2 = shared.acquire(() => {})
        const revived = shared.getHandle()
        expect(revived.isLoaded).toBe(false)
        expect(revived.data).toBeUndefined()
        release2()
    })

    it('starts a fresh subscription after the last hook unmounts and one remounts', () => {
        const r1 = mountProbe({ tag: 'a' })
        fire({ name: 'x' })
        expect(handles.a!.data).toEqual({ name: 'x' })

        act(() => r1.unmount())

        // Remount: the previous entry was evicted, so a brand-new listener is
        // attached and the new hook begins loading from scratch.
        mountProbe({ tag: 'b' })
        expect(h.listeners()).toHaveLength(2)
        expect(handles.b!.isLoaded).toBe(false)
        expect(handles.b!.data).toBeUndefined()

        fire({ name: 'z' })
        expect(handles.b!.data).toEqual({ name: 'z' })
    })

    it('releases the lease when load() throws, so the entry does not leak', () => {
        // load() attaches the listener via onSnapshot, which can throw
        // synchronously. The hook takes the shared lease in acquire() *before*
        // load(); if a throw skips the returned release, refCount sticks >=1 —
        // the entry is never evicted and the listener never tears down, even
        // after every hook unmounts.
        vi.mocked(onSnapshot).mockImplementationOnce(() => {
            throw new Error('listener attach failed')
        })

        // First mount: acquire() then load() throws out of the subscribe effect.
        const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
        expect(() => mountProbe({ tag: 'a' })).toThrow('listener attach failed')
        errSpy.mockRestore()

        // A sibling on the same key mounts cleanly and attaches the one listener.
        const r = mountProbe({ tag: 'b' })
        expect(h.listeners()).toHaveLength(1)
        const { unsubscribe } = h.listeners()[0]!

        // Unmounting the only live hook must tear the listener down. If the
        // failed mount leaked its lease, refCount never reaches zero.
        act(() => r.unmount())
        expect(unsubscribe).toHaveBeenCalledTimes(1)
    })

    it('defers registration to acquire(), so a render that never commits leaks nothing', () => {
        // getDocumentShared runs in the render-phase useMemo. A render that is
        // aborted/suspended/StrictMode-discarded never runs its effect, so
        // acquire() never fires. Registration is therefore deferred to
        // acquire(): a render-only facade must NOT register the resource (which
        // would strand a refCount-0 entry the registry keeps forever). Observable
        // proxy: two render-only facades resolve to INDEPENDENT subscriptions —
        // neither registered the resource for the other to find. (Eager
        // registration would have made the second adopt the first's entry.)
        const params = {
            store,
            definition: docDef,
            collectionPath: 'docs',
            docId: 'd1',
        }
        const a = getDocumentShared(params)
        const b = getDocumentShared(params)
        expect(b.getHandle()).not.toBe(a.getHandle())

        // Once a lease commits, the entry IS registered and shared normally: a
        // later facade adopts it. (And it tears down cleanly on release.)
        const release = a.acquire(() => {})
        const c = getDocumentShared(params)
        expect(c.getHandle()).toBe(a.getHandle())
        release()
    })
})
