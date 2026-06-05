import type { ZodType, z } from "zod";
import type {
  CollectionDefinition,
  DocumentDefinition,
  FirestoreObject,
} from "./types";

/**
 * Define a typed document. `TData` is the document's TypeScript shape.
 *
 * **Most apps should reach for {@link createFirestate} + {@link doc} instead**
 * — that builds a registry of every Firestore thing in one object and
 * generates typed hooks for you. `defineDocument` is the lower-level
 * escape hatch: use it when you need fully custom `collection` / `id`
 * derivation, when you're calling firestate outside React, or when a
 * registry doesn't fit your control flow.
 *
 * Two ways to use:
 *
 * 1. Plain TypeScript type (no schema, no runtime validation):
 * ```ts
 * interface Project { name: string; createdAt: number }
 *
 * const projectDoc = defineDocument<Project>({
 *     collection: 'projects',
 *     id: (params) => params.projectId,
 * })
 * ```
 *
 * 2. With a Zod schema — `TData` is inferred from `z.infer<S>`. Firestate
 *    runs `schema.parse(...)` on full-payload writes (`set`/`add`) so bad
 *    data throws at the call site. Partial `update(diff)` calls are not
 *    validated (diffs frequently contain Firestore sentinels).
 * ```ts
 * import { z } from 'zod'
 *
 * const ProjectSchema = z.object({ name: z.string(), createdAt: z.number() })
 *
 * const projectDoc = defineDocument({
 *     schema: ProjectSchema,
 *     collection: 'projects',
 *     id: (params) => params.projectId,
 * })
 * ```
 */
export function defineDocument<S extends ZodType<FirestoreObject>>(
  definition: Omit<DocumentDefinition<z.infer<S>>, "schema"> & {
    schema: S;
  }
): DocumentDefinition<z.infer<S>>;
export function defineDocument<TData extends FirestoreObject>(
  definition: DocumentDefinition<TData>
): DocumentDefinition<TData>;
export function defineDocument(
  definition: DocumentDefinition<FirestoreObject>
): DocumentDefinition<FirestoreObject> {
  return definition;
}

/**
 * Define a typed collection. `TData` is the shape of each document in the
 * collection. See {@link defineDocument} for the schema/plain-type tradeoff.
 *
 * **Most apps should reach for {@link createFirestate} + {@link col} instead.**
 * `defineCollection` is the escape hatch for fully custom path derivation
 * or non-React usage.
 *
 * @example
 * ```ts
 * interface Space { name: string; area: number }
 *
 * const spacesCollection = defineCollection<Space>({
 *     path: (params) => `projects/${params.projectId}/spaces`,
 *     lazy: true,
 * })
 * ```
 */
export function defineCollection<S extends ZodType<FirestoreObject>>(
  definition: Omit<CollectionDefinition<z.infer<S>>, "schema"> & {
    schema: S;
  }
): CollectionDefinition<z.infer<S>>;
export function defineCollection<TData extends FirestoreObject>(
  definition: CollectionDefinition<TData>
): CollectionDefinition<TData>;
export function defineCollection(
  definition: CollectionDefinition<FirestoreObject>
): CollectionDefinition<FirestoreObject> {
  return definition;
}

/**
 * Infer the document data type from a {@link DocumentDefinition}.
 */
export type InferDocumentData<T extends DocumentDefinition<FirestoreObject>> =
  T extends DocumentDefinition<infer D> ? D : never;

/**
 * Infer the document data type (with `id` field) from a {@link DocumentDefinition}.
 */
export type InferDocument<T extends DocumentDefinition<FirestoreObject>> =
  InferDocumentData<T> & { id: string };

/**
 * Infer the document data type from a {@link CollectionDefinition}.
 */
export type InferCollectionData<
  T extends CollectionDefinition<FirestoreObject>
> = T extends CollectionDefinition<infer D> ? D : never;

/**
 * Infer the document data type (with `id` field) from a {@link CollectionDefinition}.
 */
export type InferCollectionDocument<
  T extends CollectionDefinition<FirestoreObject>
> = InferCollectionData<T> & { id: string };
