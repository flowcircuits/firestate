import { describe, it, expect } from 'vitest'
import { GeoPoint, serverTimestamp, Timestamp } from 'firebase/firestore'
import {
    computeDiff,
    applyDiff,
    applyDiffMutable,
    applyOverridesAtPaths,
    collectServerTimestampPaths,
    isDeepEqual,
    deepClone,
    isDiffEmpty,
    mergeDiffs,
    flattenDiff,
    reconcileDisplayOverrides,
    unflattenDiff,
    diffContainsPath,
    extractDiffValue,
    createDiffAtPath,
    computeUndoDiff,
} from './diff'

describe('diff utilities', () => {
    describe('isDeepEqual', () => {
        it('compares primitives', () => {
            expect(isDeepEqual(1, 1)).toBe(true)
            expect(isDeepEqual(1, 2)).toBe(false)
            expect(isDeepEqual('a', 'a')).toBe(true)
            expect(isDeepEqual('a', 'b')).toBe(false)
        })

        it('compares arrays', () => {
            expect(isDeepEqual([1, 2], [1, 2])).toBe(true)
            expect(isDeepEqual([1, 2], [1, 3])).toBe(false)
            expect(isDeepEqual([1, 2], [1])).toBe(false)
        })

        it('compares objects', () => {
            expect(isDeepEqual({ a: 1 }, { a: 1 })).toBe(true)
            expect(isDeepEqual({ a: 1 }, { a: 2 })).toBe(false)
            expect(isDeepEqual({ a: 1 }, { b: 1 })).toBe(false)
        })

        it('compares nested objects', () => {
            expect(isDeepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true)
            expect(isDeepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false)
        })
    })

    describe('deepClone', () => {
        it('clones primitives', () => {
            expect(deepClone(1)).toBe(1)
            expect(deepClone('a')).toBe('a')
        })

        it('clones arrays', () => {
            const arr = [1, 2, 3]
            const cloned = deepClone(arr)
            expect(cloned).toEqual(arr)
            expect(cloned).not.toBe(arr)
        })

        it('clones nested objects', () => {
            const obj = { a: { b: 1 } }
            const cloned = deepClone(obj)
            expect(cloned).toEqual(obj)
            expect(cloned).not.toBe(obj)
            expect(cloned.a).not.toBe(obj.a)
        })
    })

    describe('computeDiff', () => {
        it('detects changed fields', () => {
            const from = { name: 'old', count: 5 }
            const to = { name: 'new', count: 5 }
            const diff = computeDiff(from, to)
            expect(diff).toEqual({ name: 'new' })
        })

        it('detects added fields', () => {
            const from = { name: 'test' } as Record<string, unknown>
            const to = { name: 'test', count: 5 }
            const diff = computeDiff(from, to)
            expect(diff).toEqual({ count: 5 })
        })

        it('handles nested objects', () => {
            const from = { building: { floors: 5, height: 100 } }
            const to = { building: { floors: 10, height: 100 } }
            const diff = computeDiff(from, to)
            expect(diff).toEqual({ building: { floors: 10 } })
        })
    })

    describe('applyDiff', () => {
        it('applies changes immutably', () => {
            const original = { name: 'old', count: 5 }
            const diff = { name: 'new' }
            const result = applyDiff(original, diff)
            expect(result).toEqual({ name: 'new', count: 5 })
            expect(original).toEqual({ name: 'old', count: 5 })
        })

        it('handles nested objects', () => {
            const original = { building: { floors: 5, height: 100 } }
            const diff = { building: { floors: 10 } }
            const result = applyDiff(original, diff)
            expect(result).toEqual({ building: { floors: 10, height: 100 } })
        })
    })

    describe('applyDiffMutable', () => {
        it('mutates the target object', () => {
            const target = { name: 'old', count: 5 }
            applyDiffMutable(target, { name: 'new' })
            expect(target).toEqual({ name: 'new', count: 5 })
        })
    })

    describe('isDiffEmpty', () => {
        it('returns true for empty diff', () => {
            expect(isDiffEmpty({})).toBe(true)
        })

        it('returns false for non-empty diff', () => {
            expect(isDiffEmpty({ name: 'test' })).toBe(false)
        })
    })

    describe('mergeDiffs', () => {
        it('merges two diffs with second taking precedence', () => {
            const first = { name: 'first', count: 1 }
            const second = { name: 'second' }
            const merged = mergeDiffs(first, second)
            expect(merged).toEqual({ name: 'second', count: 1 })
        })

        it('deep merges nested objects', () => {
            const first = { building: { floors: 5, height: 100 } }
            const second = { building: { floors: 10 } }
            const merged = mergeDiffs(first, second)
            expect(merged).toEqual({ building: { floors: 10, height: 100 } })
        })
    })

    describe('flattenDiff', () => {
        it('flattens nested object to dot notation', () => {
            const nested = { building: { floors: 5, height: 100 }, name: 'Test' }
            const flat = flattenDiff(nested)
            expect(flat).toEqual({
                'building.floors': 5,
                'building.height': 100,
                'name': 'Test',
            })
        })

        it('preserves arrays without flattening', () => {
            const nested = { tags: ['a', 'b'] }
            const flat = flattenDiff(nested)
            expect(flat).toEqual({ tags: ['a', 'b'] })
        })
    })

    describe('unflattenDiff', () => {
        it('unflattens dot notation to nested object', () => {
            const flat = { 'building.floors': 5, 'building.height': 100, 'name': 'Test' }
            const nested = unflattenDiff(flat)
            expect(nested).toEqual({
                building: { floors: 5, height: 100 },
                name: 'Test',
            })
        })
    })

    describe('diffContainsPath', () => {
        it('finds existing paths', () => {
            const diff = { building: { floors: 5 }, name: 'Test' }
            expect(diffContainsPath(diff, 'name')).toBe(true)
            expect(diffContainsPath(diff, 'building')).toBe(true)
            expect(diffContainsPath(diff, 'building.floors')).toBe(true)
        })

        it('returns false for missing paths', () => {
            const diff = { building: { floors: 5 }, name: 'Test' }
            expect(diffContainsPath(diff, 'building.height')).toBe(false)
            expect(diffContainsPath(diff, 'other')).toBe(false)
        })
    })

    describe('extractDiffValue', () => {
        it('extracts values at paths', () => {
            const diff = { building: { floors: 5, height: 100 }, name: 'Test' }
            expect(extractDiffValue(diff, 'name')).toBe('Test')
            expect(extractDiffValue(diff, 'building.floors')).toBe(5)
            expect(extractDiffValue(diff, 'building')).toEqual({ floors: 5, height: 100 })
        })

        it('returns undefined for missing paths', () => {
            const diff = { building: { floors: 5 } }
            expect(extractDiffValue(diff, 'building.height')).toBeUndefined()
            expect(extractDiffValue(diff, 'other')).toBeUndefined()
        })
    })

    describe('createDiffAtPath', () => {
        it('creates nested diff from path', () => {
            expect(createDiffAtPath('name', 'Test')).toEqual({ name: 'Test' })
            expect(createDiffAtPath('building.floors', 5)).toEqual({
                building: { floors: 5 },
            })
            expect(createDiffAtPath('building.config.enabled', true)).toEqual({
                building: { config: { enabled: true } },
            })
        })
    })

    describe('computeUndoDiff', () => {
        it('computes the reverse diff', () => {
            const startState = { name: 'Foo', count: 5 }
            const diff = { name: 'Bar' }
            const undoDiff = computeUndoDiff(startState, diff)
            expect(undoDiff).toEqual({ name: 'Foo' })
        })

        it('applying undo diff restores original state', () => {
            const startState = { name: 'Foo', count: 5 }
            const diff = { name: 'Bar', count: 10 }
            const endState = applyDiff(startState, diff)
            const undoDiff = computeUndoDiff(startState, diff)
            const restored = applyDiff(endState, undoDiff)
            expect(restored).toEqual(startState)
        })
    })

    // Pins the C1 bug: serverTimestamp() must survive the local pipeline
    // unchanged so Firestore can expand it on the server. Currently the
    // sentinel is replaced with the client clock (or destroyed entirely
    // by deepClone), so the server never gets to stamp its own time.
    describe('serverTimestamp() preservation', () => {
        it('applyDiffMutable preserves the sentinel instead of substituting Timestamp.now()', () => {
            // updateState() funnels every user diff through applyDiffMutable.
            // If the sentinel is replaced here, the rest of the pipeline only
            // ever sees a client Timestamp — Firestore never sees serverTimestamp().
            const target: Record<string, unknown> = {}
            const sentinel = serverTimestamp()

            applyDiffMutable(target, { updatedAt: sentinel })

            expect(target.updatedAt).toBe(sentinel)
        })

        it('deepClone preserves the sentinel', () => {
            // setData() calls deepClone on the user's payload. deepClone
            // currently iterates the sentinel's own keys and produces a
            // plain object with no .isEqual method, so downstream sentinel
            // detection misses it and setDoc writes garbage at that field.
            const sentinel = serverTimestamp()
            const cloned = deepClone({ updatedAt: sentinel })

            expect(cloned.updatedAt).toBe(sentinel)
        })

        it('the diff shipped to updateDoc still contains the sentinel', () => {
            // Mirrors what sync() does after `handle.update({ updatedAt: serverTimestamp() })`:
            //   1. updateState clones currentData and folds in the user's diff.
            //   2. sync computes diff(syncState, localState) and ships it.
            // The diff must contain the sentinel — not a client Timestamp.
            const syncState = { name: 'doc', updatedAt: Timestamp.fromMillis(1000) }
            const localState = deepClone(syncState)
            const sentinel = serverTimestamp()

            applyDiffMutable(localState, { updatedAt: sentinel })
            const diff = computeDiff(syncState, localState) as Record<string, unknown>

            expect(diff.updatedAt).toBe(sentinel)
        })

        it('flattenDiff carries the sentinel through to a dotted key', () => {
            // Final hop before updateDoc — the diff is flattened to dot
            // notation. The sentinel must arrive at the right dotted
            // path so Firestore can expand it on the server.
            const sentinel = serverTimestamp()
            const flat = flattenDiff({ meta: { updatedAt: sentinel } })

            expect(flat['meta.updatedAt']).toBe(sentinel)
        })
    })

    // Pins H3: identical-by-value Timestamps used to fall into the
    // primitive `!==` branch of computeDiff because deepClone returned a
    // fresh instance, so every unrelated edit re-wrote every Timestamp
    // field. Now compared via `.isEqual` at the leaf.
    describe('Timestamp diff suppression (H3)', () => {
        it('does not produce a diff when both sides hold an equal Timestamp', () => {
            const ts = Timestamp.fromMillis(1000)
            const from = { name: 'a', createdAt: ts }
            const to = { name: 'a', createdAt: Timestamp.fromMillis(1000) }

            expect(computeDiff(from, to)).toEqual({})
        })

        it('does include changed Timestamps in the diff', () => {
            const from = { createdAt: Timestamp.fromMillis(1000) }
            const to = { createdAt: Timestamp.fromMillis(2000) }
            const diff = computeDiff(from, to) as Record<string, unknown>

            expect(diff.createdAt).toBe(to.createdAt)
        })

        it('does not re-write the Timestamp when an unrelated field changes', () => {
            // Regression for the specific shape that wasted writes: clone
            // the doc, edit one field, send to sync. The Timestamp in the
            // clone is a different reference but the same value, and
            // shouldn't end up in the diff.
            const syncState = { name: 'old', createdAt: Timestamp.fromMillis(1000) }
            const localState = deepClone(syncState)
            localState.name = 'new'

            const diff = computeDiff(syncState, localState) as Record<string, unknown>

            expect(diff).toEqual({ name: 'new' })
            expect('createdAt' in diff).toBe(false)
        })
    })

    // Pins C3: non-Timestamp Firestore value types (DocumentReference,
    // GeoPoint, Bytes, VectorValue) were silently corrupted by deepClone
    // because it walked their own keys and stripped the prototype. The
    // first user edit on any doc holding such a field would either fail
    // the write or store nonsense. GeoPoint is used here as the proxy
    // for the class because it's the only one constructible without a
    // Firestore instance — the fix is generic via isFirestoreOpaque.
    describe('Firestore value types (C3)', () => {
        it('deepClone returns GeoPoint by reference instead of stripping its prototype', () => {
            const pt = new GeoPoint(40.7, -74.0)
            const cloned = deepClone({ home: pt })

            expect(cloned.home).toBe(pt)
            expect(cloned.home).toBeInstanceOf(GeoPoint)
        })

        it('does not produce a diff when both sides hold an equal GeoPoint', () => {
            const from = { home: new GeoPoint(40.7, -74.0) }
            const to = { home: new GeoPoint(40.7, -74.0) }

            expect(computeDiff(from, to)).toEqual({})
        })

        it('includes a changed GeoPoint in the diff', () => {
            const from = { home: new GeoPoint(40.7, -74.0) }
            const to = { home: new GeoPoint(48.8, 2.3) }
            const diff = computeDiff(from, to) as Record<string, unknown>

            expect(diff.home).toBe(to.home)
        })
    })

    // Pins H5: mergeDiffs called deepClone on `first`, which used to
    // walk a sentinel's own keys and produce a plain object that no
    // longer registered as a sentinel anywhere downstream. Now opaque
    // values pass through by reference.
    describe('mergeDiffs sentinel preservation (H5)', () => {
        it('preserves a serverTimestamp() sentinel from the first diff', () => {
            const sentinel = serverTimestamp()
            const merged = mergeDiffs(
                { updatedAt: sentinel, name: 'a' },
                { name: 'b' }
            ) as Record<string, unknown>

            expect(merged.updatedAt).toBe(sentinel)
            expect(merged.name).toBe('b')
        })

        it('preserves a serverTimestamp() sentinel from the second diff', () => {
            const sentinel = serverTimestamp()
            const merged = mergeDiffs(
                { name: 'a' },
                { updatedAt: sentinel }
            ) as Record<string, unknown>

            expect(merged.updatedAt).toBe(sentinel)
        })
    })

    // Display overrides power the optimistic-UI half of the C1 fix.
    // Sentinels stay in localState (so the write is correct), but the
    // merged view substitutes a frozen Timestamp at each sentinel path
    // so consumers always see a renderable value during the in-flight
    // window.
    describe('displayOverrides helpers', () => {
        describe('collectServerTimestampPaths', () => {
            it('finds sentinels at the top level', () => {
                const paths = collectServerTimestampPaths({
                    name: 'x',
                    updatedAt: serverTimestamp(),
                })
                expect([...paths]).toEqual(['updatedAt'])
            })

            it('finds sentinels nested in plain objects', () => {
                const paths = collectServerTimestampPaths({
                    name: 'x',
                    meta: { updatedAt: serverTimestamp(), revision: 5 },
                })
                expect([...paths]).toEqual(['meta.updatedAt'])
            })

            it('ignores non-serverTimestamp sentinels and value types', () => {
                const paths = collectServerTimestampPaths({
                    createdAt: Timestamp.fromMillis(1000),
                    home: new GeoPoint(0, 0),
                    // deleteField is structural — applyDiffMutable removes the
                    // key before reconcile runs, so it shouldn't show up here
                    // in practice. But the collect helper is defensive.
                })
                expect(paths.size).toBe(0)
            })

            it('returns empty for null / undefined input', () => {
                expect(collectServerTimestampPaths(null).size).toBe(0)
                expect(collectServerTimestampPaths(undefined).size).toBe(0)
            })
        })

        describe('reconcileDisplayOverrides', () => {
            it('captures a frozen Timestamp on first sighting', () => {
                const overrides = new Map<string, unknown>()
                let tick = 1000
                const now = () => Timestamp.fromMillis(tick++)

                reconcileDisplayOverrides(
                    { updatedAt: serverTimestamp() },
                    overrides,
                    now
                )
                expect(overrides.get('updatedAt')).toEqual(Timestamp.fromMillis(1000))
            })

            it('does not advance the captured value on subsequent reconciles', () => {
                // This is the whole point of the frozen-at-first-sighting
                // design: subsequent reads must not see a Timestamp that
                // crept forward to the current clock.
                const overrides = new Map<string, unknown>()
                let tick = 1000
                const now = () => Timestamp.fromMillis(tick++)

                const localState = { updatedAt: serverTimestamp() }
                reconcileDisplayOverrides(localState, overrides, now)
                reconcileDisplayOverrides(localState, overrides, now)
                reconcileDisplayOverrides(localState, overrides, now)

                expect(overrides.get('updatedAt')).toEqual(Timestamp.fromMillis(1000))
            })

            it('drops overrides for paths whose sentinel was overwritten', () => {
                const overrides = new Map<string, unknown>()
                const now = () => Timestamp.fromMillis(1000)

                // First mutation: sentinel arrives.
                reconcileDisplayOverrides(
                    { updatedAt: serverTimestamp() },
                    overrides,
                    now
                )
                expect(overrides.has('updatedAt')).toBe(true)

                // User overwrites with an explicit value.
                reconcileDisplayOverrides(
                    { updatedAt: Timestamp.fromMillis(5000) },
                    overrides,
                    now
                )
                expect(overrides.has('updatedAt')).toBe(false)
            })

            it('clears every override when localState becomes empty (snapshot ack)', () => {
                const overrides = new Map<string, unknown>()
                reconcileDisplayOverrides(
                    {
                        updatedAt: serverTimestamp(),
                        meta: { lastSeen: serverTimestamp() },
                    },
                    overrides
                )
                expect(overrides.size).toBe(2)

                // localState cleared by snapshot ack.
                reconcileDisplayOverrides(undefined, overrides)
                expect(overrides.size).toBe(0)
            })
        })

        describe('applyOverridesAtPaths', () => {
            it('returns the input unchanged when the override map is empty', () => {
                const merged = { name: 'x', updatedAt: Timestamp.fromMillis(1000) }
                const result = applyOverridesAtPaths(merged, new Map())

                expect(result).toBe(merged)
            })

            it('substitutes a top-level override', () => {
                const ts = Timestamp.fromMillis(5000)
                const overrides = new Map<string, unknown>([['updatedAt', ts]])
                const result = applyOverridesAtPaths(
                    { name: 'x', updatedAt: serverTimestamp() },
                    overrides
                )

                expect(result.updatedAt).toBe(ts)
                expect(result.name).toBe('x')
            })

            it('substitutes a nested override without clobbering siblings', () => {
                const ts = Timestamp.fromMillis(5000)
                const overrides = new Map<string, unknown>([['meta.updatedAt', ts]])
                const result = applyOverridesAtPaths(
                    {
                        name: 'x',
                        meta: { updatedAt: serverTimestamp(), revision: 5 },
                    },
                    overrides
                )

                expect(result).toEqual({
                    name: 'x',
                    meta: { updatedAt: ts, revision: 5 },
                })
            })

            it('does not mutate the input merged object', () => {
                const original = {
                    name: 'x',
                    updatedAt: serverTimestamp(),
                }
                const ts = Timestamp.fromMillis(5000)
                const overrides = new Map<string, unknown>([['updatedAt', ts]])

                applyOverridesAtPaths(original, overrides)

                // The original still holds the sentinel — overrides are
                // a render-time concern only.
                expect(original.updatedAt).not.toBe(ts)
            })
        })
    })
})
