import type {
  CollectionDefinition,
  DocumentDefinition,
  FirestoreObject,
  StandardSchemaV1,
} from "./types";

/**
 * Define a typed document. `TData` is the document's TypeScript shape.
 *
 * Two ways to use:
 *
 * 1. Plain TypeScript type (no validator dependency):
 * ```ts
 * interface Project { name: string; createdAt: number }
 *
 * const projectDoc = defineDocument<Project>({
 *     collection: 'projects',
 *     id: (params) => params.projectId,
 * })
 * ```
 *
 * 2. With a Standard Schema validator (zod 3.24+/4, valibot, arktype, etc.) —
 *    `TData` is inferred from the schema's output type. Firestate stores the
 *    schema on the definition but does not invoke validation; consumers run it
 *    at their own boundaries.
 * ```ts
 * const projectDoc = defineDocument({
 *     schema: ProjectSchema,
 *     collection: 'projects',
 *     id: (params) => params.projectId,
 * })
 * ```
 */
export function defineDocument<
  S extends StandardSchemaV1<unknown, FirestoreObject>
>(
  definition: Omit<
    DocumentDefinition<StandardSchemaV1.InferOutput<S>>,
    "schema"
  > & {
    schema: S;
  }
): DocumentDefinition<StandardSchemaV1.InferOutput<S>>;
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
export function defineCollection<
  S extends StandardSchemaV1<unknown, FirestoreObject>
>(
  definition: Omit<
    CollectionDefinition<StandardSchemaV1.InferOutput<S>>,
    "schema"
  > & {
    schema: S;
  }
): CollectionDefinition<StandardSchemaV1.InferOutput<S>>;
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
