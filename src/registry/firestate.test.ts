import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
    createFirestate,
    doc,
    col,
    interpolatePath,
    splitDocPath,
    buildDocumentDefinition,
    buildCollectionDefinition,
} from './firestate'

const tlSchema = z.object({
    name: z.string(),
    createdAt: z.number(),
})
const taskSchema = z.object({
    title: z.string(),
    completed: z.boolean(),
})

type TaskList = z.infer<typeof tlSchema>
type Task = z.infer<typeof taskSchema>

describe('doc', () => {
    it('builds a document entry from a schema-form call', () => {
        const entry = doc({
            path: 'taskLists/{listId}',
            schema: tlSchema,
            autosave: 250,
        })
        expect(entry.__kind).toBe('document')
        expect(entry.path).toBe('taskLists/{listId}')
        expect(entry.autosave).toBe(250)
        expect(entry.schema).toBe(tlSchema)
    })
})

describe('col', () => {
    it('builds a collection entry from a schema-form call', () => {
        const entry = col({
            path: 'taskLists/{listId}/tasks',
            schema: taskSchema,
            autosave: 250,
            lazy: true,
        })
        expect(entry.__kind).toBe('collection')
        expect(entry.path).toBe('taskLists/{listId}/tasks')
        expect(entry.autosave).toBe(250)
        expect(entry.lazy).toBe(true)
        expect(entry.schema).toBe(taskSchema)
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

    it('throws on empty-string param values', () => {
        // A `''` value would silently produce `taskLists//tasks` and crash
        // deep in Firestore. Catch it at the boundary instead.
        expect(() =>
            interpolatePath('taskLists/{listId}/tasks', { listId: '' })
        ).toThrow(/must not be an empty string/)
    })
})

describe('template validation at registration time', () => {
    it('rejects unclosed placeholders', () => {
        expect(() =>
            doc({ path: 'taskLists/{listId/tasks', schema: tlSchema })
        ).toThrow(/malformed placeholder/)
    })

    it('rejects malformed placeholder names (hyphens, dots)', () => {
        expect(() =>
            doc({ path: 'taskLists/{list-Id}', schema: tlSchema })
        ).toThrow(/malformed placeholder/)
    })

    it('rejects empty document collection or id segments', () => {
        expect(() =>
            doc({ path: 'taskLists/', schema: tlSchema })
        ).toThrow(/non-empty collection and id/)
        expect(() =>
            doc({ path: '/listId', schema: tlSchema })
        ).toThrow(/non-empty collection and id/)
    })

    it('accepts well-formed placeholders including underscores', () => {
        expect(() =>
            doc({ path: 'projects/{project_id}', schema: tlSchema })
        ).not.toThrow()
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

describe('createFirestate', () => {
    it('produces a hook per registry key', () => {
        const api = createFirestate({
            taskList: doc({ path: 'taskLists/{listId}', schema: tlSchema }),
            tasks: col({
                path: 'taskLists/{listId}/tasks',
                schema: taskSchema,
            }),
        })

        expect(typeof api.useTaskList).toBe('function')
        expect(typeof api.useTasks).toBe('function')
    })

    it('capitalizes the first character of each key', () => {
        const api = createFirestate({
            a: doc({ path: 'a/{id}', schema: tlSchema }),
            longerName: col({ path: 'a/{id}/sub', schema: taskSchema }),
        })

        expect(typeof (api as any).useA).toBe('function')
        expect(typeof (api as any).useLongerName).toBe('function')
    })

    it('rejects invalid keys', () => {
        expect(() =>
            createFirestate({
                '1bad': doc({ path: 'a/{id}', schema: tlSchema }),
            } as any)
        ).toThrow(/must start with a letter/)

        expect(() =>
            createFirestate({
                'bad-key': doc({ path: 'a/{id}', schema: tlSchema }),
            } as any)
        ).toThrow(/must start with a letter/)
    })
})

describe('type-level schema requirement', () => {
    // Pin the contract that schema is REQUIRED on the entry interface,
    // not just on the factory function. tsc validates these directives.
    it('rejects entries without a schema field', () => {
        function _typeTest() {
            // @ts-expect-error schema field is required on the factory
            doc({ path: 'taskLists/{listId}' })

            // @ts-expect-error schema field is required on the factory
            col({ path: 'taskLists/{listId}/tasks' })

            // @ts-expect-error schema field is required on DocEntry itself
            const _badDoc: import('./firestate').DocEntry<TaskList> = {
                __kind: 'document',
                path: 'taskLists/{listId}',
            }

            // @ts-expect-error schema field is required on ColEntry itself
            const _badCol: import('./firestate').ColEntry<Task> = {
                __kind: 'collection',
                path: 'taskLists/{listId}/tasks',
            }

            void _badDoc
            void _badCol
        }
        void _typeTest
        expect(true).toBe(true)
    })
})

describe('type-level params extraction', () => {
    // These assertions are checked by tsc; vitest just verifies the
    // wrapper function exists. `@ts-expect-error` errors the build if the
    // line below does NOT produce a TS error, which is what we want for
    // "is this call signature actually enforced?".
    it('requires the right param keys at call sites', () => {
        function _typeTest() {
            const api = createFirestate({
                taskList: doc({
                    path: 'taskLists/{listId}',
                    schema: tlSchema,
                }),
                tasks: col({
                    path: 'taskLists/{listId}/tasks',
                    schema: taskSchema,
                }),
                bare: col({ path: 'settings', schema: taskSchema }),
            })

            // Missing required param → error
            // @ts-expect-error params object lacks `listId`
            api.useTaskList({})

            // Wrong key → error
            // @ts-expect-error `wrongKey` is not part of the template
            api.useTaskList({ wrongKey: 'a' })

            // Calling with no args at all on a template that needs them → error
            // @ts-expect-error template requires `listId`
            api.useTaskList()

            // Valid usage
            api.useTaskList({ listId: 'a' })
            api.useTasks({ listId: 'a' })

            // Bare path (no placeholders) accepts no params
            api.useBare()
            api.useBare({})

            // Options arg passes through
            api.useTaskList({ listId: 'a' }, { enabled: false })
        }
        void _typeTest
        expect(true).toBe(true)
    })
})

describe('buildDocumentDefinition', () => {
    const projectSchema = z.object({ name: z.string() })
    const revisionSchema = z.object({ title: z.string() })
    const spaceSchema = z.object({ label: z.string() })

    it('resolves a flat doc path', () => {
        const def = buildDocumentDefinition(
            doc({ path: 'projects/{projectId}', schema: projectSchema })
        )
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

    it('resolves a doc nested under a dynamic parent', () => {
        // The collection portion contains `{projectId}` and must be
        // interpolated per-call, not passed to Firestore verbatim.
        const def = buildDocumentDefinition(
            doc({
                path: 'projects/{projectId}/revisions/{revisionId}',
                schema: revisionSchema,
            })
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
            doc({
                path: 'projects/{projectId}/revisions/{revisionId}/spaces/{spaceId}',
                schema: spaceSchema,
            })
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
            doc({
                path: 'projects/{projectId}/revisions/{revisionId}',
                schema: revisionSchema,
            })
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
    const spaceSchema = z.object({ label: z.string() })

    it('resolves a collection nested under a dynamic parent', () => {
        const def = buildCollectionDefinition(
            col({
                path: 'projects/{projectId}/revisions/{revisionId}/spaces',
                schema: spaceSchema,
            })
        )

        expect(typeof def.path).toBe('function')
        const path = def.path as (p: Record<string, string>) => string
        expect(path({ projectId: 'p1', revisionId: 'r1' })).toBe(
            'projects/p1/revisions/r1/spaces'
        )
    })
})
