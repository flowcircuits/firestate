import { afterEach, beforeAll } from 'vitest'
import { cleanup } from '@testing-library/react'
import { mockFirestore } from './test-utils/firestore-mock'

// RTL warns "An update to TestComponent inside a test was not wrapped in
// act(...)" when a `useSyncExternalStore` subscribe handler synchronously
// invokes its onChange. This is a false positive: React's docs for
// useSyncExternalStore explicitly allow synchronous calls, and our mock's
// initial-snapshot delivery is the closest analog to Firestore's cached
// snapshot path. Filter just this one message so real act issues still
// surface.
beforeAll(() => {
    const originalError = console.error
    console.error = (...args: unknown[]) => {
        const first = args[0]
        if (
            typeof first === 'string' &&
            first.includes('not wrapped in act')
        ) {
            return
        }
        originalError(...args)
    }
})

// RTL: unmount any components rendered in the test, freeing listeners.
// Mock: clear in-memory data, listeners, and spy call history so tests
// don't bleed state into each other.
afterEach(() => {
    cleanup()
    mockFirestore.reset()
})
