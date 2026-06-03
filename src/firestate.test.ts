import { describe, it, expect } from 'vitest'
import {
    defineFirestate,
    doc,
    col,
    interpolatePath,
    splitDocPath,
    buildDocumentDefinition,
    buildCollectionDefinition,
} from './firestate'
import type { StandardSchemaV1 } from './types'

interface TaskList {
    name: string
    createdAt: number
}

interface Task {
    title: string
    completed: boolean
}

// Minimal Standard Schema validator for inference tests — mirrors the
// helper in schema.test.ts. Sufficient to drive the schema-overload path.
const standardSchema = <T>(vendor: string): StandardSchemaV1<unknown, T> => ({
    '~standard': {
        version: 1,
        vendor,
        validate: (value) => ({ value: value as T }),
        types: undefined,
    },
})

describe('doc', () => {
    it('builds a document entry with an explicit type', () => {
        const entry = doc<TaskList>('taskLists/{listId}', { autosave: 250 })
        expect(entry.__kind).toBe('document')
        expect(entry.path).toBe('taskLists/{listId}')
        expect(entry.autosave).toBe(250)
        expect(entry.schema).toBeUndefined()
    })

    it('accepts the object form with a schema', () => {
        const schema = standardSchema<TaskList>('test')
        const entry = doc({ path: 'taskLists/{listId}', schema })
        expect(entry.__kind).toBe('document')
        expect(entry.path).toBe('taskLists/{listId}')
        expect(entry.schema).toBe(schema)
    })
})

describe('col', () => {
    it('builds a collection entry with an explicit type', () => {
        const entry = col<Task>('taskLists/{listId}/tasks', {
            autosave: 250,
            lazy: true,
        })
        expect(entry.__kind).toBe('collection')
        expect(entry.path).toBe('taskLists/{listId}/tasks')
        expect(entry.autosave).toBe(250)
        expect(entry.lazy).toBe(true)
    })

    it('accepts the object form with a schema', () => {
        const schema = standardSchema<Task>('test')
        const entry = col({ path: 'taskLists/{listId}/tasks', schema })
        expect(entry.schema).toBe(schema)
    })
})

describe('interpolatePath', () => {
    it('substitutes placeholders', () => {
        expect(
            interpolatePath('taskLists/{listId}/tasks', { listId: 'abc' })
        ).toBe('taskLists/abc/tasks')
    })

    it('handles multiple placeholders', () => {
        expect(
            interpolatePath('orgs/{orgId}/projects/{projectId}', {
                orgId: 'o1',
                projectId: 'p1',
            })
        ).toBe('orgs/o1/projects/p1')
    })

    it('leaves paths without placeholders unchanged', () => {
        expect(interpolatePath('users', {})).toBe('users')
    })

    it('throws if a placeholder is missing', () => {
        expect(() =>
            interpolatePath('taskLists/{listId}/tasks', {})
        ).toThrow(/missing param "listId"/)
    })
})

describe('splitDocPath', () => {
    it('splits on the last slash', () => {
        expect(splitDocPath('taskLists/{listId}')).toEqual({
            collectionPath: 'taskLists',
            idTemplate: '{listId}',
        })
    })

    it('handles deeper paths', () => {
        expect(splitDocPath('orgs/{orgId}/projects/{projectId}')).toEqual({
            collectionPath: 'orgs/{orgId}/projects',
            idTemplate: '{projectId}',
        })
    })

    it('throws on a path with no slash', () => {
        expect(() => splitDocPath('taskLists')).toThrow(
            /must contain at least one '\/'/
        )
    })
})

describe('defineFirestate', () => {
    it('produces a hook per registry key', () => {
        const api = defineFirestate({
            taskList: doc<TaskList>('taskLists/{listId}'),
            tasks: col<Task>('taskLists/{listId}/tasks'),
        })

        expect(typeof api.useTaskList).toBe('function')
        expect(typeof api.useTasks).toBe('function')
    })

    it('capitalizes the first character of each key', () => {
        const api = defineFirestate({
            a: doc<TaskList>('a/{id}'),
            longerName: col<Task>('a/{id}/sub'),
        })

        expect(typeof (api as any).useA).toBe('function')
        expect(typeof (api as any).useLongerName).toBe('function')
    })

    it('rejects invalid keys', () => {
        expect(() =>
            defineFirestate({
                '1bad': doc<TaskList>('a/{id}'),
            } as any)
        ).toThrow(/must start with a letter/)

        expect(() =>
            defineFirestate({
                'bad-key': doc<TaskList>('a/{id}'),
            } as any)
        ).toThrow(/must start with a letter/)
    })
})

describe('buildDocumentDefinition', () => {
    interface Project {
        name: string
    }
    interface Revision {
        title: string
    }
    interface Space {
        label: string
    }

    it('resolves a flat doc path', () => {
        const def = buildDocumentDefinition(doc<Project>('projects/{projectId}'))
        // Both halves are functions so params can interpolate uniformly.
        expect(typeof def.collection).toBe('function')
        expect(typeof def.id).toBe('function')

        const collection = def.collection as (
            p: Record<string, string>
        ) => string
        const id = def.id as (p: Record<string, string>) => string

        expect(collection({ projectId: 'p1' })).toBe('projects')
        expect(id({ projectId: 'p1' })).toBe('p1')
    })

    it('resolves a doc nested under a dynamic parent (regression for hvakr-style paths)', () => {
        // This is the case that used to silently break: the collection portion
        // contained `{projectId}` and was passed verbatim to Firestore.
        const def = buildDocumentDefinition(
            doc<Revision>('projects/{projectId}/revisions/{revisionId}')
        )

        const collection = def.collection as (
            p: Record<string, string>
        ) => string
        const id = def.id as (p: Record<string, string>) => string

        const params = { projectId: 'p1', revisionId: 'r1' }
        expect(collection(params)).toBe('projects/p1/revisions')
        expect(id(params)).toBe('r1')
    })

    it('resolves a doc inside a deeper subcollection chain', () => {
        const def = buildDocumentDefinition(
            doc<Space>(
                'projects/{projectId}/revisions/{revisionId}/spaces/{spaceId}'
            )
        )

        const collection = def.collection as (
            p: Record<string, string>
        ) => string
        const id = def.id as (p: Record<string, string>) => string

        const params = {
            projectId: 'p1',
            revisionId: 'r1',
            spaceId: 's1',
        }
        expect(collection(params)).toBe('projects/p1/revisions/r1/spaces')
        expect(id(params)).toBe('s1')
    })

    it('throws when a required param is missing at resolution time', () => {
        const def = buildDocumentDefinition(
            doc<Revision>('projects/{projectId}/revisions/{revisionId}')
        )

        const collection = def.collection as (
            p: Record<string, string>
        ) => string

        expect(() => collection({ revisionId: 'r1' })).toThrow(
            /missing param "projectId"/
        )
    })
})

describe('buildCollectionDefinition', () => {
    interface Space {
        label: string
    }

    it('resolves a collection nested under a dynamic parent', () => {
        const def = buildCollectionDefinition(
            col<Space>('projects/{projectId}/revisions/{revisionId}/spaces')
        )

        expect(typeof def.path).toBe('function')
        const path = def.path as (p: Record<string, string>) => string
        expect(path({ projectId: 'p1', revisionId: 'r1' })).toBe(
            'projects/p1/revisions/r1/spaces'
        )
    })
})
