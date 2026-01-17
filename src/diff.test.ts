import { describe, it, expect } from 'vitest'
import {
    computeDiff,
    applyDiff,
    applyDiffMutable,
    isDeepEqual,
    deepClone,
    isDiffEmpty,
    mergeDiffs,
    flattenDiff,
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
})
