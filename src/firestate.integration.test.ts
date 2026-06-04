/**
 * Integration test: from a Firestate registry entry, through the generated
 * hook plumbing, to the actual Firebase `collection()` / `doc()` calls.
 *
 * The unit tests in `firestate.test.ts` verify that `buildDocumentDefinition`
 * produces a definition whose `collection`/`id` functions return the right
 * strings. That's necessary but not sufficient — what we actually care about
 * is that those strings reach Firestore in `collection(firestore, path)`.
 * This file pins that contract directly.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.mock('firebase/firestore', async () => {
    const actual =
        await vi.importActual<typeof import('firebase/firestore')>(
            'firebase/firestore'
        )
    return {
        ...actual,
        collection: vi.fn((_firestore: unknown, path: string) => ({
            __mockColl: path,
        })),
        doc: vi.fn((collRef: unknown, docId: string) => ({
            __mockDoc: { collRef, docId },
        })),
        onSnapshot: vi.fn(() => () => {
            /* noop unsubscribe */
        }),
    }
})

import * as firestore from 'firebase/firestore'
import {
    doc,
    col,
    buildDocumentDefinition,
    buildCollectionDefinition,
} from './firestate'
import { createDocumentSubscription } from './document'
import { createStore, type FirestateStore } from './store'
import type { StandardSchemaV1 } from './types'

interface Revision {
    title: string
}
interface Space {
    label: string
}

// Minimal Standard Schema validator — schema-only API requires one per entry.
const standardSchema = <T>(): StandardSchemaV1<unknown, T> => ({
    '~standard': {
        version: 1,
        vendor: 'test',
        validate: (value) => ({ value: value as T }),
        types: undefined,
    },
})

const revisionSchema = standardSchema<Revision>()
const spaceSchema = standardSchema<Space>()

describe('Firestate registry → Firestore path', () => {
    let store: FirestateStore

    beforeEach(() => {
        vi.clearAllMocks()
        store = createStore({ firestore: {} as any })
    })

    it('resolves a flat document path through to collection() + doc()', () => {
        const definition = buildDocumentDefinition(
            doc({ path: 'projects/{projectId}', schema: revisionSchema })
        )
        const params = { projectId: 'p1' }

        const collectionPath = (
            definition.collection as (p: Record<string, string>) => string
        )(params)
        const docId = (definition.id as (p: Record<string, string>) => string)(
            params
        )

        createDocumentSubscription({ store, definition, collectionPath, docId })

        expect(firestore.collection).toHaveBeenCalledWith(
            store.firestore,
            'projects'
        )
        expect(firestore.doc).toHaveBeenCalledWith(
            { __mockColl: 'projects' },
            'p1'
        )
    })

    it('resolves a document nested under a dynamic parent (regression for hvakr-style paths)', () => {
        // This is the case that motivated the function-form `collection`.
        // If the registry-to-Firestore handoff regresses, this test catches it.
        const definition = buildDocumentDefinition(
            doc({
                path: 'projects/{projectId}/revisions/{revisionId}',
                schema: revisionSchema,
            })
        )
        const params = { projectId: 'p1', revisionId: 'r1' }

        const collectionPath = (
            definition.collection as (p: Record<string, string>) => string
        )(params)
        const docId = (definition.id as (p: Record<string, string>) => string)(
            params
        )

        createDocumentSubscription({ store, definition, collectionPath, docId })

        expect(firestore.collection).toHaveBeenCalledWith(
            store.firestore,
            'projects/p1/revisions'
        )
        expect(firestore.doc).toHaveBeenCalledWith(
            { __mockColl: 'projects/p1/revisions' },
            'r1'
        )
    })

    it('resolves a deep subcollection collection path', () => {
        const definition = buildCollectionDefinition(
            col({
                path: 'projects/{projectId}/revisions/{revisionId}/spaces',
                schema: spaceSchema,
            })
        )
        const path = (definition.path as (p: Record<string, string>) => string)(
            { projectId: 'p1', revisionId: 'r1' }
        )

        expect(path).toBe('projects/p1/revisions/r1/spaces')
    })
})
