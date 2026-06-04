import { z } from 'zod'

// Zod is the source of truth for our document shapes. Firestate's registry
// API requires a Zod schema per entry — the schema both feeds `z.infer` for
// the generated hooks and gets called via `schema.parse(...)` on full-payload
// writes (set/add). Partial update() diffs are not validated.

export const TaskListSchema = z.object({
    name: z.string(),
    description: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
})

export const TaskSchema = z.object({
    title: z.string(),
    completed: z.boolean(),
    priority: z.enum(['low', 'medium', 'high']),
    createdAt: z.number(),
})

export type TaskList = z.infer<typeof TaskListSchema>
export type Task = z.infer<typeof TaskSchema>
