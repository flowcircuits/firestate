import { defineFirestate, doc, col } from '@hvakr/firestate'
import { Task, TaskList } from './types'

// One giant object describes every Firestore thing this app touches.
// The library generates `useTaskList` and `useTasks` from it.
export const { useTaskList, useTasks } = defineFirestate({
    taskList: doc<TaskList>('taskLists/{listId}', { autosave: 500 }),
    tasks: col<Task>('taskLists/{listId}/tasks', { autosave: 500 }),
})
