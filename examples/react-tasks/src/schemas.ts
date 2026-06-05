import { createFirestate, doc, col } from '@hvakr/firestate'
import { TaskListSchema, TaskSchema } from './types'

export const { useTaskList, useTasks } = createFirestate({
    taskList: doc({
        path: 'taskLists/{listId}',
        schema: TaskListSchema,
        autosave: 500,
    }),
    tasks: col({
        path: 'taskLists/{listId}/tasks',
        schema: TaskSchema,
        autosave: 500,
    }),
})
