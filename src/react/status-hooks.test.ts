/**
 * Sync-agnostic default handle + per-entry status hooks.
 *
 * Contract:
 * - A data hook called WITHOUT a selector returns the *sync-agnostic default*
 *   handle: `data`, `isLoaded`, `error` (+ a collection's `isActive`) — never
 *   `isSynced`. So a write *settling* (the isSynced flip on every autosave) does
 *   NOT re-render a plain data consumer; only data/load/error transitions do.
 * - `use{Name}SyncStatus` is the opt-in sync channel — `{ isSynced, isSaving }`.
 *   It shares the resource's one listener with the data hook (sharing is keyed
 *   by (definition, path, query), not readOnly/selector) and re-renders only on
 *   sync flips.
 * - `use{Name}LoadingStatus` is a loading-only channel — `{ isLoading, isLoaded }`
 *   — that does not re-render on data changes.
 *
 * Real React renders over the deterministic harness; render counting proves what
 * collapses. Documents share by string key in this harness (collection sharing,
 * which keys on semantic query identity, is covered in hooks.test.ts).
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

import { createElement, Fragment, type ReactNode } from 'react'
import { create, act, type ReactTestRenderer } from 'react-test-renderer'
import { z } from 'zod'
import { createHarness, type Harness } from '../__tests__/test-harness'
import { FirestateContext } from './hooks'
import { createFirestate, doc, col } from '../registry/firestate'
import { createStore, type FirestateStore } from '../core/store'
import type { DocumentHandle, LoadingStatus, SyncStatus } from '../types'

type Thing = { name: string; count: number }
const ThingSchema = z.object({ name: z.string(), count: z.number() })

// Schema/path declared once; the base hook and its status siblings share it.
const thingDoc = doc({ path: 'things/{thingId}', schema: ThingSchema })
const api = createFirestate({
    thing: thingDoc,
    // A selected (slice) entry — proves status hooks are generated for BASE
    // entries only (see the type checks at the bottom).
    thingName: thingDoc.select((s) => s.data?.name),
    things: col({ path: 'things', schema: ThingSchema }),
})

describe('sync-agnostic default handle', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined
    let renders = 0

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        // autosave: 0 so an edit stays optimistic until we fire a confirming
        // snapshot — letting us settle isSynced with data unchanged.
        store = createStore({ firestore: {} as never, autosave: 0 })
        renders = 0
    })

    afterEach(() => {
        act(() => renderer?.unmount())
        renderer = undefined
        vi.useRealTimers()
    })

    const mount = (node: ReactNode): void => {
        act(() => {
            renderer = create(
                createElement(FirestateContext.Provider, { value: store }, node)
            )
        })
    }

    const fireDoc = (data: Thing | null): void => {
        act(() => {
            h.fireDocSnapshot(data)
            vi.runAllTimers()
        })
    }

    it('omits isSynced and exposes isLoaded on the default handle', () => {
        let handle: DocumentHandle<Thing> | undefined
        const Probe = (): null => {
            handle = api.useThing({ thingId: 't1' })
            return null
        }
        mount(createElement(Probe))
        expect(handle!.isLoaded).toBe(false)
        // isSynced/isLoading are structurally gone (see the type checks); guard
        // against an accidental reintroduction at runtime too.
        expect('isSynced' in handle!).toBe(false)
        expect('isLoading' in handle!).toBe(false)

        fireDoc({ name: 'a', count: 1 })
        expect(handle!.isLoaded).toBe(true)
        expect(handle!.data).toEqual({ name: 'a', count: 1 })
    })

    it('does NOT re-render when a write settles (the footgun this fixes)', () => {
        let handle: DocumentHandle<Thing> | undefined
        const Probe = (): null => {
            renders++
            handle = api.useThing({ thingId: 't1' })
            return null
        }
        mount(createElement(Probe))
        fireDoc({ name: 'a', count: 1 })
        const loaded = renders

        // An edit changes data → one expected, data-driven re-render. The
        // resource is now unsynced, but the default handle doesn't carry that.
        act(() => handle!.update({ count: 2 }))
        expect(renders).toBe(loaded + 1)
        expect(handle!.data).toEqual({ name: 'a', count: 2 })

        // The server confirms: a snapshot matching the optimistic state flips
        // isSynced false → true with data UNCHANGED. Pre-change this was the
        // extra render every save incurred; now it collapses to zero.
        fireDoc({ name: 'a', count: 2 })
        expect(renders).toBe(loaded + 1)
        expect(handle!.data).toEqual({ name: 'a', count: 2 })
    })
})

describe('useDocumentSyncStatus (generated useThingSyncStatus)', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never, autosave: 0 })
    })

    afterEach(() => {
        act(() => renderer?.unmount())
        renderer = undefined
        vi.useRealTimers()
    })

    const mount = (node: ReactNode): void => {
        act(() => {
            renderer = create(
                createElement(FirestateContext.Provider, { value: store }, node)
            )
        })
    }

    const fireDoc = (data: Thing | null): void => {
        act(() => {
            h.fireDocSnapshot(data)
            vi.runAllTimers()
        })
    }

    it('shares the data hook listener and re-renders only on sync flips', () => {
        let writer: DocumentHandle<Thing> | undefined
        let status: SyncStatus | undefined
        let statusRenders = 0
        const Writer = (): null => {
            writer = api.useThing({ thingId: 't1' })
            return null
        }
        const StatusReader = (): null => {
            statusRenders++
            status = api.useThingSyncStatus({ thingId: 't1' })
            return null
        }
        mount(
            createElement(
                Fragment,
                null,
                createElement(Writer),
                createElement(StatusReader)
            )
        )
        fireDoc({ name: 'a', count: 1 })

        // The data hook and the sync-status hook resolve ONE shared entry.
        expect(h.listeners()).toHaveLength(1)
        expect(status).toEqual({ isSynced: true, isSaving: false })
        const base = statusRenders

        // A write flips sync state → the status reader re-renders, reports saving.
        act(() => writer!.update({ count: 2 }))
        expect(status).toEqual({ isSynced: false, isSaving: true })
        expect(statusRenders).toBe(base + 1)

        // The write settles (data unchanged) → flips back to synced.
        fireDoc({ name: 'a', count: 2 })
        expect(status).toEqual({ isSynced: true, isSaving: false })
        expect(statusRenders).toBe(base + 2)
    })

    it('returns the idle status when disabled (no listener)', () => {
        let status: SyncStatus | undefined
        const Probe = (): null => {
            status = api.useThingSyncStatus({ thingId: 't1' }, { enabled: false })
            return null
        }
        mount(createElement(Probe))
        expect(status).toEqual({ isSynced: true, isSaving: false })
        expect(h.listeners()).toHaveLength(0)
    })
})

describe('useDocumentLoadingStatus (generated useThingLoadingStatus)', () => {
    let store: FirestateStore
    let h: Harness
    let renderer: ReactTestRenderer | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
        h = createHarness()
        store = createStore({ firestore: {} as never, autosave: 0 })
    })

    afterEach(() => {
        act(() => renderer?.unmount())
        renderer = undefined
        vi.useRealTimers()
    })

    const mount = (node: ReactNode): void => {
        act(() => {
            renderer = create(
                createElement(FirestateContext.Provider, { value: store }, node)
            )
        })
    }

    const fireDoc = (data: Thing | null): void => {
        act(() => {
            h.fireDocSnapshot(data)
            vi.runAllTimers()
        })
    }

    it('tracks the load transition and does not re-render on data changes', () => {
        let writer: DocumentHandle<Thing> | undefined
        let status: LoadingStatus | undefined
        let loadRenders = 0
        const Writer = (): null => {
            writer = api.useThing({ thingId: 't1' })
            return null
        }
        const LoadReader = (): null => {
            loadRenders++
            status = api.useThingLoadingStatus({ thingId: 't1' })
            return null
        }
        mount(
            createElement(
                Fragment,
                null,
                createElement(Writer),
                createElement(LoadReader)
            )
        )

        // Before the first snapshot: loading.
        expect(status).toEqual({ isLoading: true, isLoaded: false })

        fireDoc({ name: 'a', count: 1 })
        expect(status).toEqual({ isLoading: false, isLoaded: true })
        const base = loadRenders

        // A subsequent data change does not move load state → no re-render here,
        // even though the data hook itself would re-render.
        fireDoc({ name: 'b', count: 1 })
        expect(loadRenders).toBe(base)
        expect(status).toEqual({ isLoading: false, isLoaded: true })
        expect(writer!.data).toEqual({ name: 'b', count: 1 })
    })

    it('returns the idle status when disabled', () => {
        let status: LoadingStatus | undefined
        const Probe = (): null => {
            status = api.useThingLoadingStatus(
                { thingId: 't1' },
                { enabled: false }
            )
            return null
        }
        mount(createElement(Probe))
        expect(status).toEqual({ isLoading: false, isLoaded: false })
        expect(h.listeners()).toHaveLength(0)
    })
})

// Compile-time contract checks (never executed; validated by `tsc --noEmit`).
// The generated status hooks exist for BASE entries with the right return type
// and param rules, and do NOT exist for `.select` (derived) entries.
export function _statusTypeChecks(): void {
    // Document status hooks: params required (path has {thingId}), options take
    // `enabled`, return the right shape.
    const ds: SyncStatus = api.useThingSyncStatus({ thingId: 't' })
    const dl: LoadingStatus = api.useThingLoadingStatus(
        { thingId: 't' },
        { enabled: true }
    )
    void ds
    void dl

    // Collection status hooks: no path params here (optional), and they accept
    // queryConstraints (must match the data hook's to share one listener).
    const cs: SyncStatus = api.useThingsSyncStatus()
    const cl: LoadingStatus = api.useThingsLoadingStatus(undefined, {
        queryConstraints: [],
    })
    void cs
    void cl

    // @ts-expect-error thingId is required for this document's sync-status hook
    api.useThingSyncStatus()

    // The slice hook exists...
    const name: string | undefined = api.useThingName({ thingId: 't' }).data
    void name
    // ...but a derived entry gets NO status hooks.
    // @ts-expect-error selected entries do not produce a sync-status hook
    void api.useThingNameSyncStatus
    // @ts-expect-error selected entries do not produce a loading-status hook
    void api.useThingNameLoadingStatus
}
