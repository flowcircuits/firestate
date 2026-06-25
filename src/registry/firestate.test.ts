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

            // Function paths can't infer keys from a template, so params fall
            // back to Record<string, string> — the hook still type-checks and
            // branches on whichever params it gets.
            const fnApi = createFirestate({
                spaces: col({
                    path: (p) => `projects/${p.projectId}/spaces`,
                    schema: taskSchema,
                }),
                space: doc({
                    path: (p) => `projects/${p.projectId}/spaces/${p.spaceId}`,
                    schema: taskSchema,
                }),
            })
            fnApi.useSpaces({ projectId: 'p1' })
            fnApi.useSpace({ projectId: 'p1', spaceId: 's1' })
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

describe('doc — function path', () => {
    const projectSchema = z.object({ name: z.string() })
    const spaceSchema = z.object({ label: z.string() })

    it('does not validate the path at registration time', () => {
        // A function can't be template-checked up front; registration is a
        // no-op on validation and must not throw.
        expect(() =>
            doc({ path: (p) => `projects/${p.projectId}`, schema: projectSchema })
        ).not.toThrow()
    })

    it('stores the function as the entry path', () => {
        const pathFn = (p: Record<string, string>) => `projects/${p.projectId}`
        const entry = doc({ path: pathFn, schema: projectSchema })
        expect(entry.__kind).toBe('document')
        expect(entry.path).toBe(pathFn)
    })

    it('splits the resolved full path into collection + id per-call', () => {
        const def = buildDocumentDefinition(
            doc({
                path: (p) => `projects/${p.projectId}`,
                schema: projectSchema,
            })
        )
        const collection = def.collection as (
            p: Record<string, string>
        ) => string
        const id = def.id as (p: Record<string, string>) => string

        expect(collection({ projectId: 'p1' })).toBe('projects')
        expect(id({ projectId: 'p1' })).toBe('p1')
    })

    it('branches the path on a runtime param (live vs. revision)', () => {
        // Mirrors HVAKR's ProjectProvider: the revision segment only appears
        // when a revisionId is present.
        const def = buildDocumentDefinition(
            doc({
                path: (p) =>
                    p.revisionId
                        ? `projects/${p.projectId}/revisions/${p.revisionId}/spaces/${p.spaceId}`
                        : `projects/${p.projectId}/spaces/${p.spaceId}`,
                schema: spaceSchema,
            })
        )
        const collection = def.collection as (
            p: Record<string, string>
        ) => string
        const id = def.id as (p: Record<string, string>) => string

        // live branch
        expect(collection({ projectId: 'p1', spaceId: 's1' })).toBe(
            'projects/p1/spaces'
        )
        expect(id({ projectId: 'p1', spaceId: 's1' })).toBe('s1')

        // revision branch
        expect(
            collection({ projectId: 'p1', revisionId: 'r1', spaceId: 's1' })
        ).toBe('projects/p1/revisions/r1/spaces')
        expect(
            id({ projectId: 'p1', revisionId: 'r1', spaceId: 's1' })
        ).toBe('s1')
    })

    it('still fails loud when the resolved path has no slash', () => {
        const def = buildDocumentDefinition(
            doc({ path: () => 'projects', schema: projectSchema })
        )
        const collection = def.collection as (
            p: Record<string, string>
        ) => string
        expect(() => collection({})).toThrow(/must contain at least one '\/'/)
    })
})

describe('col — function path', () => {
    const spaceSchema = z.object({ label: z.string() })

    it('does not validate the path at registration time', () => {
        expect(() =>
            col({ path: (p) => `projects/${p.projectId}/spaces`, schema: spaceSchema })
        ).not.toThrow()
    })

    it('stores the function as the entry path', () => {
        const pathFn = (p: Record<string, string>) =>
            `projects/${p.projectId}/spaces`
        const entry = col({ path: pathFn, schema: spaceSchema })
        expect(entry.__kind).toBe('collection')
        expect(entry.path).toBe(pathFn)
    })

    it('branches the collection path on a runtime param (live vs. revision)', () => {
        const def = buildCollectionDefinition(
            col({
                path: (p) =>
                    p.revisionId
                        ? `projects/${p.projectId}/revisions/${p.revisionId}/spaces`
                        : `projects/${p.projectId}/spaces`,
                schema: spaceSchema,
            })
        )
        expect(typeof def.path).toBe('function')
        const path = def.path as (p: Record<string, string>) => string

        // live branch
        expect(path({ projectId: 'p1' })).toBe('projects/p1/spaces')
        // revision branch
        expect(path({ projectId: 'p1', revisionId: 'r1' })).toBe(
            'projects/p1/revisions/r1/spaces'
        )
    })
})

describe('.select derives a named slice entry', () => {
    it('produces a document-selected entry that reuses the base (schema handed once)', () => {
        const base = doc({ path: 'taskLists/{listId}', schema: tlSchema })
        const derived = base.select((s) => s.data?.name)

        expect(derived.__kind).toBe('document-selected')
        // The derived entry points back at the SAME base object — the schema and
        // path live there and are never re-specified per slice.
        expect(derived.base).toBe(base)
        expect(derived.base.schema).toBe(tlSchema)
        expect(typeof derived.selector).toBe('function')
    })

    it('produces a collection-selected entry and carries the baked-in comparator', () => {
        const base = col({ path: 'taskLists/{listId}/tasks', schema: taskSchema })
        const cmp = (a: string[], b: string[]): boolean => a.length === b.length
        const derived = base.select((s) => Object.keys(s.data), { isEqual: cmp })

        expect(derived.__kind).toBe('collection-selected')
        expect(derived.base).toBe(base)
        // Comparator is baked into the entry, not passed at the call site.
        expect(derived.isEqual).toBe(cmp)
    })
})

describe('type-level .select param threading', () => {
    // tsc validates these; vitest only confirms the wrapper exists. Each
    // `@ts-expect-error` fails the build if the line below does NOT error.
    it('merges path params with selector params and drops status from the slice handle', () => {
        function _typeTest(): void {
            const listDoc = doc({ path: 'taskLists/{listId}', schema: tlSchema })
            const tasksCol = col({
                path: 'taskLists/{listId}/tasks',
                schema: taskSchema,
            })

            const api = createFirestate({
                // base hooks (full handle) coexist with derived slice hooks…
                list: listDoc,
                tasks: tasksCol,
                // …all as flat siblings, named by their registry key.
                listName: listDoc.select((s) => s.data?.name),
                taskIds: tasksCol.select((s) => Object.keys(s.data)),
                taskById: tasksCol.select((s, p: { id: string }) => s.data[p.id]),
            })

            // Un-parameterized doc slice: only the path param is required.
            const name: string | undefined = api.useListName({ listId: 'l1' }).data
            void name

            // Parameterized collection slice: the path param AND the selector's
            // own param, merged into one bag.
            const handle = api.useTaskById({ listId: 'l1', id: 't1' })
            const task: Task | undefined = handle.data
            void task
            // Writers stay typed against the FULL collection (keyed by id), not
            // the slice — selecting one doc never narrows what you can write.
            handle.update({ t1: { completed: true } })
            // A selected handle drops the status fields.
            // @ts-expect-error isSynced is not on a selected handle
            void handle.isSynced

            // Missing the selector param → error.
            // @ts-expect-error `id` is required by the selector
            api.useTaskById({ listId: 'l1' })
            // Missing the path param → error.
            // @ts-expect-error `listId` is required by the path template
            api.useTaskById({ id: 't1' })

            // The ids slice is a string[].
            const ids: string[] = api.useTaskIds({ listId: 'l1' }).data
            void ids

            // Base hooks are unchanged — the full keyed record.
            const full: Record<string, Task> = api.useTasks({ listId: 'l1' }).data
            void full

            // Runtime options pass through; selector/isEqual are NOT call-site
            // options (they're baked into the named hook).
            api.useListName({ listId: 'l1' }, { enabled: false })
            // @ts-expect-error selector is baked in, not passed per call
            api.useListName({ listId: 'l1' }, { selector: (s) => s.data?.name })

            // No-placeholder path + un-parameterized selector → NO args required.
            // Regression guard: PExtra must default to `{}`, not resolve to its
            // old `Record<string, string>` constraint (which wrongly forced a
            // params arg here).
            const settings = col({ path: 'settings', schema: taskSchema })
            const settingsApi = createFirestate({
                settings,
                settingIds: settings.select((s) => Object.keys(s.data)),
            })
            settingsApi.useSettings()
            const settingIds: string[] = settingsApi.useSettingIds().data
            void settingIds

            // A non-string selector param is allowed (PExtra is unconstrained),
            // and the merged bag type-checks it.
            const things2 = col({ path: 'things2', schema: taskSchema })
            const idxApi = createFirestate({
                things2,
                byIndex: things2.select(
                    (s, p: { index: number }) => Object.values(s.data)[p.index]
                ),
            })
            idxApi.useByIndex({ index: 0 })
            // @ts-expect-error index must be a number, not a string
            idxApi.useByIndex({ index: 'nope' })

            // No chaining: a derived entry is a leaf, not a base.
            // @ts-expect-error cannot .select() a selected entry
            void listDoc.select((s) => s.data?.name).select
        }
        void _typeTest
        expect(true).toBe(true)
    })
})
