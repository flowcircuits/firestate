import { createFirestate, doc, col } from '@hvakr/firestate'
import { TaskListSchema, TaskSchema } from './types'

// The whole data API for this app, in one place. Declare each resource's schema
// + path ONCE, then define the named slice-hooks next to it with `.select`.
//
//   - A bare resource (`taskList`, `tasks`) generates a full-handle hook.
//   - A `.select(...)` derives a sibling hook whose `data` is just the slice;
//     it re-renders only when that slice changes. The selector receives the full
//     observable state, and for a parameterized slice the SAME params bag the
//     path resolves from (so `taskById` reads `p.id`). Writers and `ref` stay on
//     the full resource — selecting one task never narrows what you can write.
//
// The schema is handed to firestate exactly once, here; every slice reuses it.
const taskList = doc({
    path: 'taskLists/{listId}',
    schema: TaskListSchema,
    autosave: 500,
})

const tasks = col({
    path: 'taskLists/{listId}/tasks',
    schema: TaskSchema,
    autosave: 500,
})

export const {
    // Full handles — the bare resource.
    useTaskList,
    useTasks,
    // Document slices.
    useListName,
    useListGate,
    // Collection slices.
    useTaskListView,
    useTaskById,
} = createFirestate({
    taskList,
    tasks,

    // The list title only — re-renders only when the name changes.
    listName: taskList.select((s) => s.data?.name),

    // Loading + existence gate. Status isn't a freebie under the pure selector
    // model, so the gate folds `isLoading` into its slice on purpose.
    listGate: taskList.select((s) => ({
        loading: s.isLoading,
        exists: Boolean(s.data),
    })),

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
