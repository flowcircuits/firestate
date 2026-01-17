import { z } from 'zod'
import type { DocumentDefinition, CollectionDefinition } from './types'

/**
 * Define a document schema for use with Firestate.
 * This creates a type-safe document definition with all necessary metadata.
 *
 * @example
 * ```ts
 * const ProjectSchema = z.object({
 *   name: z.string(),
 *   createdAt: z.number(),
 * })
 *
 * const projectDoc = defineDocument({
 *   schema: ProjectSchema,
 *   collection: 'projects',
 *   id: (params) => params.projectId,
 * })
 * ```
 */
export const defineDocument = <T extends z.ZodType>(
    definition: DocumentDefinition<T>
): DocumentDefinition<T> => definition

/**
 * Define a collection schema for use with Firestate.
 * This creates a type-safe collection definition with all necessary metadata.
 *
 * @example
 * ```ts
 * const SpaceSchema = z.object({
 *   name: z.string(),
 *   area: z.number(),
 * })
 *
 * const spacesCollection = defineCollection({
 *   schema: SpaceSchema,
 *   path: (params) => `projects/${params.projectId}/spaces`,
 *   lazy: true,
 * })
 * ```
 */
export const defineCollection = <T extends z.ZodType>(
    definition: CollectionDefinition<T>
): CollectionDefinition<T> => definition

/**
 * Validate data against a Zod schema, returning the parsed data or undefined.
 * Useful for safe parsing without throwing errors.
 */
export const validateSafe = <T extends z.ZodType>(
    schema: T,
    data: unknown
): z.infer<T> | undefined => {
    const result = schema.safeParse(data)
    return result.success ? result.data : undefined
}

/**
 * Validate data against a Zod schema, throwing on failure.
 * Use at API boundaries where invalid data should fail fast.
 */
export const validate = <T extends z.ZodType>(
    schema: T,
    data: unknown
): z.infer<T> => schema.parse(data)

/**
 * Create a partial schema that makes all fields optional.
 * Useful for update operations where you only specify changed fields.
 */
export const partialSchema = <T extends z.ZodObject<z.ZodRawShape>>(
    schema: T
): z.ZodObject<{
    [K in keyof T['shape']]: z.ZodOptional<T['shape'][K]>
}> => schema.partial() as z.ZodObject<{
    [K in keyof T['shape']]: z.ZodOptional<T['shape'][K]>
}>

/**
 * Extract metadata from a Zod schema field.
 * Returns the metadata object if defined, or undefined.
 * Works with Zod 3 and Zod 4 schemas that have metadata attached via .meta()
 */
export const getFieldMeta = <T extends z.ZodType>(
    schema: T
): Record<string, unknown> | undefined => {
    // In Zod 4, meta is stored in _zod.meta
    // In Zod 3, meta is stored in _def.meta (when using zod-meta or similar)
    const def = schema._def as unknown as Record<string, unknown>
    const zod = def._zod as Record<string, unknown> | undefined
    const meta = zod?.meta ?? def.meta
    return meta as Record<string, unknown> | undefined
}

/**
 * Walk a Zod object schema and collect all field metadata.
 * Returns a map of dotted paths to metadata objects.
 *
 * @example
 * ```ts
 * const meta = collectMeta(ProjectSchema)
 * // { 'name': { title: 'Project Name', ... }, 'building.floors': { ... } }
 * ```
 */
export const collectMeta = <T extends z.ZodObject<z.ZodRawShape>>(
    schema: T,
    prefix = ''
): Record<string, Record<string, unknown>> => {
    const result: Record<string, Record<string, unknown>> = {}

    for (const [key, fieldSchema] of Object.entries(schema.shape)) {
        const path = prefix ? `${prefix}.${key}` : key
        const meta = getFieldMeta(fieldSchema as z.ZodType)

        if (meta) {
            result[path] = meta
        }

        // Recurse into nested objects
        if (fieldSchema instanceof z.ZodObject) {
            Object.assign(result, collectMeta(fieldSchema, path))
        }

        // Handle optional wrappers
        if (fieldSchema instanceof z.ZodOptional) {
            const inner = fieldSchema.unwrap()
            if (inner instanceof z.ZodObject) {
                Object.assign(result, collectMeta(inner, path))
            }
        }
    }

    return result
}

/**
 * Create an "extends" version of a document type that adds the id field.
 * This mirrors the pattern: `interface User extends UserData { id: string }`
 */
export const withId = <T extends z.ZodObject<z.ZodRawShape>>(
    schema: T
): z.ZodObject<T['shape'] & { id: z.ZodString }> =>
    schema.extend({ id: z.string() }) as z.ZodObject<
        T['shape'] & { id: z.ZodString }
    >

/**
 * Type helper to infer the data type from a document definition
 */
export type InferDocumentData<T extends DocumentDefinition<z.ZodType>> =
    z.infer<T['schema']>

/**
 * Type helper to infer the full document type (with id) from a definition
 */
export type InferDocument<T extends DocumentDefinition<z.ZodType>> = z.infer<
    T['schema']
> & { id: string }

/**
 * Type helper to infer the data type from a collection definition
 */
export type InferCollectionData<T extends CollectionDefinition<z.ZodType>> =
    z.infer<T['schema']>

/**
 * Type helper to infer the full document type from a collection definition
 */
export type InferCollectionDocument<
    T extends CollectionDefinition<z.ZodType>,
> = z.infer<T['schema']> & { id: string }
