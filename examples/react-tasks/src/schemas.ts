import { z } from 'zod'
import { defineDocument, defineCollection } from '@hvakr/firestate'

// Schema for a task list (document)
export const TaskListSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type TaskList = z.infer<typeof TaskListSchema>

// Schema for individual tasks (collection)
export const TaskSchema = z.object({
  title: z.string(),
  completed: z.boolean(),
  priority: z.enum(['low', 'medium', 'high']),
  createdAt: z.number(),
})

export type Task = z.infer<typeof TaskSchema>

// Define the task list document
export const taskListDoc = defineDocument({
  schema: TaskListSchema,
  collection: 'taskLists',
  id: (params: { listId: string }) => params.listId,
  autosave: 500,
})

// Define the tasks collection (subcollection of a task list)
export const tasksCollection = defineCollection({
  schema: TaskSchema,
  path: (params: { listId: string }) => `taskLists/${params.listId}/tasks`,
  autosave: 500,
})
