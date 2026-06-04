import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { defineDocument, defineCollection } from './schema'

const ProjectSchema = z.object({
    name: z.string(),
    createdAt: z.number(),
})

const TaskSchema = z.object({
    title: z.string(),
    completed: z.boolean(),
})

interface Project {
    name: string
    createdAt: number
}

interface Task {
    title: string
    completed: boolean
}

describe('defineDocument', () => {
    it('accepts a plain TypeScript type without any schema', () => {
        const projectDoc = defineDocument<Project>({
            collection: 'projects',
            id: 'project-123',
        })

        expect(projectDoc.collection).toBe('projects')
        expect(projectDoc.id).toBe('project-123')
        expect(projectDoc.schema).toBeUndefined()
    })

    it('supports dynamic id', () => {
        const projectDoc = defineDocument<Project>({
            collection: 'projects',
            id: (params) => params.projectId ?? 'fallback',
        })

        expect(typeof projectDoc.id).toBe('function')
        if (typeof projectDoc.id === 'function') {
            expect(projectDoc.id({ projectId: 'abc' })).toBe('abc')
        }
    })

    it('accepts an optional Zod schema', () => {
        const projectDoc = defineDocument({
            schema: ProjectSchema,
            collection: 'projects',
            id: 'project-123',
        })

        expect(projectDoc.schema).toBe(ProjectSchema)
        expect(projectDoc.collection).toBe('projects')
    })

    it('passes through optional configuration options', () => {
        const doc = defineDocument<Project>({
            collection: 'items',
            id: 'item-1',
            autosave: 500,
            minLoadTime: 200,
            readOnly: true,
            retryOnError: true,
            retryInterval: 3000,
        })

        expect(doc.autosave).toBe(500)
        expect(doc.minLoadTime).toBe(200)
        expect(doc.readOnly).toBe(true)
        expect(doc.retryOnError).toBe(true)
        expect(doc.retryInterval).toBe(3000)
    })
})

describe('defineCollection', () => {
    it('accepts a plain TypeScript type without any schema', () => {
        const tasks = defineCollection<Task>({
            path: 'tasks',
        })

        expect(tasks.path).toBe('tasks')
        expect(tasks.schema).toBeUndefined()
    })

    it('supports dynamic path', () => {
        const spaces = defineCollection<Project>({
            path: (params) => `projects/${params.projectId}/spaces`,
        })

        expect(typeof spaces.path).toBe('function')
        if (typeof spaces.path === 'function') {
            expect(spaces.path({ projectId: 'abc' })).toBe('projects/abc/spaces')
        }
    })

    it('accepts an optional Zod schema', () => {
        const tasks = defineCollection({
            schema: TaskSchema,
            path: 'tasks',
        })

        expect(tasks.schema).toBe(TaskSchema)
    })

    it('supports lazy and queryConstraints options', () => {
        const lazy = defineCollection<Task>({
            path: 'tasks',
            lazy: true,
        })

        expect(lazy.lazy).toBe(true)
    })
})
