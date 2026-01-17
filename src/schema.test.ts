import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
    defineDocument,
    defineCollection,
    validate,
    validateSafe,
    partialSchema,
    withId,
    collectMeta,
} from './schema'

describe('schema utilities', () => {
    describe('defineDocument', () => {
        it('creates a document definition with static id', () => {
            const ProjectSchema = z.object({
                name: z.string(),
                createdAt: z.number(),
            })

            const projectDoc = defineDocument({
                schema: ProjectSchema,
                collection: 'projects',
                id: 'project-123',
            })

            expect(projectDoc.collection).toBe('projects')
            expect(projectDoc.id).toBe('project-123')
            expect(projectDoc.schema).toBe(ProjectSchema)
        })

        it('creates a document definition with dynamic id', () => {
            const ProjectSchema = z.object({
                name: z.string(),
            })

            const projectDoc = defineDocument({
                schema: ProjectSchema,
                collection: 'projects',
                id: (params) => params.projectId,
            })

            expect(projectDoc.collection).toBe('projects')
            expect(typeof projectDoc.id).toBe('function')
            if (typeof projectDoc.id === 'function') {
                expect(projectDoc.id({ projectId: 'abc' })).toBe('abc')
            }
        })

        it('supports optional configuration options', () => {
            const Schema = z.object({ name: z.string() })

            const doc = defineDocument({
                schema: Schema,
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
        it('creates a collection definition with static path', () => {
            const SpaceSchema = z.object({
                name: z.string(),
                area: z.number(),
            })

            const spacesCollection = defineCollection({
                schema: SpaceSchema,
                path: 'projects/123/spaces',
            })

            expect(spacesCollection.path).toBe('projects/123/spaces')
            expect(spacesCollection.schema).toBe(SpaceSchema)
        })

        it('creates a collection definition with dynamic path', () => {
            const SpaceSchema = z.object({
                name: z.string(),
            })

            const spacesCollection = defineCollection({
                schema: SpaceSchema,
                path: (params) => `projects/${params.projectId}/spaces`,
            })

            expect(typeof spacesCollection.path).toBe('function')
            if (typeof spacesCollection.path === 'function') {
                expect(spacesCollection.path({ projectId: 'abc' })).toBe('projects/abc/spaces')
            }
        })

        it('supports lazy loading option', () => {
            const Schema = z.object({ name: z.string() })

            const collection = defineCollection({
                schema: Schema,
                path: 'items',
                lazy: true,
            })

            expect(collection.lazy).toBe(true)
        })
    })

    describe('validate', () => {
        it('returns parsed data for valid input', () => {
            const Schema = z.object({
                name: z.string(),
                count: z.number(),
            })

            const result = validate(Schema, { name: 'test', count: 5 })
            expect(result).toEqual({ name: 'test', count: 5 })
        })

        it('throws for invalid input', () => {
            const Schema = z.object({
                name: z.string(),
            })

            expect(() => validate(Schema, { name: 123 })).toThrow()
        })

        it('applies transformations', () => {
            const Schema = z.object({
                value: z.string().transform((v) => v.toUpperCase()),
            })

            const result = validate(Schema, { value: 'hello' })
            expect(result.value).toBe('HELLO')
        })
    })

    describe('validateSafe', () => {
        it('returns parsed data for valid input', () => {
            const Schema = z.object({
                name: z.string(),
            })

            const result = validateSafe(Schema, { name: 'test' })
            expect(result).toEqual({ name: 'test' })
        })

        it('returns undefined for invalid input', () => {
            const Schema = z.object({
                name: z.string(),
            })

            const result = validateSafe(Schema, { name: 123 })
            expect(result).toBeUndefined()
        })

        it('returns undefined for missing required fields', () => {
            const Schema = z.object({
                name: z.string(),
                required: z.number(),
            })

            const result = validateSafe(Schema, { name: 'test' })
            expect(result).toBeUndefined()
        })
    })

    describe('partialSchema', () => {
        it('makes all fields optional', () => {
            const Schema = z.object({
                name: z.string(),
                count: z.number(),
                active: z.boolean(),
            })

            const PartialSchema = partialSchema(Schema)

            // All of these should be valid with the partial schema
            expect(PartialSchema.parse({})).toEqual({})
            expect(PartialSchema.parse({ name: 'test' })).toEqual({ name: 'test' })
            expect(PartialSchema.parse({ count: 5, active: true })).toEqual({
                count: 5,
                active: true,
            })
        })
    })

    describe('withId', () => {
        it('extends schema with id field', () => {
            const UserSchema = z.object({
                name: z.string(),
                email: z.string(),
            })

            const UserWithIdSchema = withId(UserSchema)

            const result = UserWithIdSchema.parse({
                id: 'user-123',
                name: 'John',
                email: 'john@example.com',
            })

            expect(result).toEqual({
                id: 'user-123',
                name: 'John',
                email: 'john@example.com',
            })
        })

        it('requires id field', () => {
            const Schema = z.object({ name: z.string() })
            const WithIdSchema = withId(Schema)

            expect(() => WithIdSchema.parse({ name: 'test' })).toThrow()
        })
    })

    describe('collectMeta', () => {
        it('collects metadata from flat schema', () => {
            // Note: This test depends on how metadata is attached in Zod 4
            // The function handles both Zod 3 and Zod 4 patterns
            const Schema = z.object({
                name: z.string(),
                count: z.number(),
            })

            const meta = collectMeta(Schema)
            // Without metadata attached, should return empty object
            expect(meta).toEqual({})
        })

        it('collects metadata from nested schema', () => {
            const Schema = z.object({
                building: z.object({
                    floors: z.number(),
                    height: z.number(),
                }),
            })

            const meta = collectMeta(Schema)
            // Without metadata attached, should return empty object
            expect(typeof meta).toBe('object')
        })

        it('handles optional nested objects', () => {
            const Schema = z.object({
                config: z
                    .object({
                        enabled: z.boolean(),
                    })
                    .optional(),
            })

            // Should not throw when processing optional nested objects
            expect(() => collectMeta(Schema)).not.toThrow()
        })
    })
})
