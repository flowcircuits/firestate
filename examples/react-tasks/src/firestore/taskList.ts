import { z } from 'zod'
import { createFirestate, doc } from '@hvakr/firestate'

// A Firestate *resource module*: one document (or collection), its schema, and
// every hook that reads it, all in one file. Add a `firestore/projects.ts`,
// `firestore/spaces.ts`, ... beside this one as the app grows — there is no
// central registry you have to keep editing.
//
// Zod is the source of truth for the shape. The schema is declared ONCE, here,
// next to the hooks; firestate infers the type via `z.infer` and validates
// full-payload writes (`set`) against it.
export const TaskListSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
})

export type TaskList = z.infer<typeof TaskListSchema>

const taskList = doc({
    path: 'taskLists/{listId}',
    schema: TaskListSchema,
    autosave: 500,
})

// ONE `createFirestate` call owns this resource: the base hook plus its named
// slice-hooks. Keep them together — sharing is keyed by definition identity, and
// each call builds its own definitions, so the base and all its `.select`
// siblings must go through the SAME call to share one Firestore listener and one
// optimistic state. (Splitting them across separate calls would fork the
// subscription.) Different resources are different calls in different files, and
// that's exactly right — they're meant to be independent.
export const { useTaskList, useListName, useListGate } = createFirestate({
    // Full handle.
    taskList,
    // The list title only — re-renders only when the name changes.
    listName: taskList.select((s) => s.data?.name),
    // Loading + existence gate. Status isn't a freebie under the pure selector
    // model, so the gate folds `isLoading` into its slice on purpose.
    listGate: taskList.select((s) => ({
        loading: s.isLoading,
        exists: Boolean(s.data),
    })),
})
