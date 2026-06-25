import { z } from 'zod'
import { createFirestate, col } from '@hvakr/firestate'

// The tasks collection resource — see `taskList.ts` for the resource-module
// pattern. Schema declared once, here; every slice-hook below reuses it.
export const TaskSchema = z.object({
    title: z.string(),
    completed: z.boolean(),
    priority: z.enum(['low', 'medium', 'high']),
    createdAt: z.number(),
})

export type Task = z.infer<typeof TaskSchema>

const tasks = col({
    path: 'taskLists/{listId}/tasks',
    schema: TaskSchema,
    autosave: 500,
})

// One call per resource: the base hook and its slice-hooks share a single
// listener and optimistic state (see `taskList.ts`).
export const { useTasks, useTaskListView, useTaskById } = createFirestate({
    // Full handle.
    tasks,
    // A loading flag plus task ids ordered newest-first. `createdAt` is
    // immutable, so the id array is value-equal across field edits — the list
    // body re-renders only when a task is added or removed.
    taskListView: tasks.select((s) => ({
        loading: s.isLoading,
        ids: Object.entries(s.data)
            .sort(([, a], [, b]) => b.createdAt - a.createdAt)
            .map(([id]) => id),
    })),
    // One task by id. The selector declares its own `id` param, so the generated
    // hook requires it alongside the path's `listId`, in one bag:
    // `useTaskById({ listId, id })`.
    taskById: tasks.select((s, p: { id: string }) => s.data[p.id]),
})
