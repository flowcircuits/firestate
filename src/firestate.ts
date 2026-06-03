/**
 * Registry-driven Firestate API.
 *
 * Declare every document and collection in a single object and let the
 * library generate the typed read/write hooks. Replaces hand-writing a
 * `useSpaces`, `useWallTypes`, ... hook per Firestore collection.
 *
 * ```ts
 * interface TaskList { name: string; createdAt: number }
 * interface Task { title: string; completed: boolean }
 *
 * export const { useTaskList, useTasks } = defineFirestate({
 *   taskList: doc<TaskList>('taskLists/{listId}'),
 *   tasks:    col<Task>('taskLists/{listId}/tasks'),
 * })
 *
 * // At the call site:
 * const taskList = useTaskList({ listId })
 * const tasks    = useTasks({ listId })
 * ```
 */
import { defineDocument, defineCollection } from "./schema";
import { useDocument, useCollection } from "./hooks";
import type {
  CollectionDefinition,
  CollectionHandle,
  DocumentDefinition,
  DocumentHandle,
  FirestoreObject,
  StandardSchemaV1,
} from "./types";
import type { QueryConstraint } from "firebase/firestore";

// ---------------------------------------------------------------------------
// Registry entry shapes
// ---------------------------------------------------------------------------

interface CommonEntryOptions {
  /** Debounce interval for autosave (ms). */
  autosave?: number;
  /** Minimum loading indicator time (ms). */
  minLoadTime?: number;
  /** Whether this entry is read-only. */
  readOnly?: boolean;
  /** Retry the snapshot listener on transient errors. */
  retryOnError?: boolean;
  /** Retry interval (ms). */
  retryInterval?: number;
}

/**
 * Document entry in a Firestate registry. Produced by {@link doc}.
 *
 * `__kind` is a runtime discriminator; `__type` is a phantom field used
 * purely for inference at the call site and is never read.
 */
export interface DocEntry<T extends FirestoreObject> extends CommonEntryOptions {
  readonly __kind: "document";
  readonly __type?: T;
  /** Path template, e.g. `'taskLists/{listId}'`. */
  path: string;
  /** Optional Standard Schema validator. Firestate stores it; never invokes it. */
  schema?: StandardSchemaV1<unknown, T>;
}

/** Collection entry in a Firestate registry. Produced by {@link col}. */
export interface ColEntry<T extends FirestoreObject> extends CommonEntryOptions {
  readonly __kind: "collection";
  readonly __type?: T;
  /** Path template, e.g. `'taskLists/{listId}/tasks'`. */
  path: string;
  /** Optional Standard Schema validator. */
  schema?: StandardSchemaV1<unknown, T>;
  /** Only subscribe when `load()` is called. */
  lazy?: boolean;
  /** Additional Firestore query constraints. */
  queryConstraints?: QueryConstraint[];
}

export type FirestateEntry<T extends FirestoreObject = FirestoreObject> =
  | DocEntry<T>
  | ColEntry<T>;

export type FirestateRegistry = Record<string, FirestateEntry<any>>;

// ---------------------------------------------------------------------------
// Entry factories
// ---------------------------------------------------------------------------

type DocOpts<T extends FirestoreObject> = Omit<DocEntry<T>, "__kind" | "__type" | "path">;
type ColOpts<T extends FirestoreObject> = Omit<ColEntry<T>, "__kind" | "__type" | "path">;

/**
 * Declare a single-document entry for a Firestate registry.
 *
 * Two ways to use:
 *
 * 1. Plain TypeScript type:
 * ```ts
 * doc<TaskList>('taskLists/{listId}')
 * ```
 *
 * 2. With a Standard Schema validator (type inferred from the schema):
 * ```ts
 * doc({ path: 'taskLists/{listId}', schema: TaskListSchema })
 * ```
 */
export function doc<
  S extends StandardSchemaV1<unknown, FirestoreObject>
>(
  opts: Omit<DocOpts<StandardSchemaV1.InferOutput<S>>, "schema"> & {
    schema: S;
    path: string;
  }
): DocEntry<StandardSchemaV1.InferOutput<S>>;
export function doc<T extends FirestoreObject>(
  path: string,
  opts?: DocOpts<T>
): DocEntry<T>;
export function doc(
  pathOrOpts: string | (DocOpts<FirestoreObject> & { path: string }),
  opts: DocOpts<FirestoreObject> = {}
): DocEntry<FirestoreObject> {
  if (typeof pathOrOpts === "string") {
    return { __kind: "document", path: pathOrOpts, ...opts };
  }
  const { path, ...rest } = pathOrOpts;
  return { __kind: "document", path, ...rest };
}

/** Declare a collection entry for a Firestate registry. See {@link doc}. */
export function col<
  S extends StandardSchemaV1<unknown, FirestoreObject>
>(
  opts: Omit<ColOpts<StandardSchemaV1.InferOutput<S>>, "schema"> & {
    schema: S;
    path: string;
  }
): ColEntry<StandardSchemaV1.InferOutput<S>>;
export function col<T extends FirestoreObject>(
  path: string,
  opts?: ColOpts<T>
): ColEntry<T>;
export function col(
  pathOrOpts: string | (ColOpts<FirestoreObject> & { path: string }),
  opts: ColOpts<FirestoreObject> = {}
): ColEntry<FirestoreObject> {
  if (typeof pathOrOpts === "string") {
    return { __kind: "collection", path: pathOrOpts, ...opts };
  }
  const { path, ...rest } = pathOrOpts;
  return { __kind: "collection", path, ...rest };
}

// ---------------------------------------------------------------------------
// defineFirestate
// ---------------------------------------------------------------------------

type HookName<K extends string> = `use${Capitalize<K>}`;

type HookFor<E> = E extends DocEntry<infer T>
  ? (params?: Record<string, string>) => DocumentHandle<T>
  : E extends ColEntry<infer T>
  ? (params?: Record<string, string>) => CollectionHandle<T>
  : never;

export type FirestateApi<R extends FirestateRegistry> = {
  [K in keyof R & string as HookName<K>]: HookFor<R[K]>;
};

/**
 * Turn a Firestate registry into a map of typed React hooks. Each entry
 * `K` produces a hook named `use{Capitalize<K>}`.
 *
 * ```ts
 * export const { useTaskList, useTasks } = defineFirestate({
 *   taskList: doc<TaskList>('taskLists/{listId}'),
 *   tasks:    col<Task>('taskLists/{listId}/tasks'),
 * })
 * ```
 */
export function defineFirestate<R extends FirestateRegistry>(
  registry: R
): FirestateApi<R> {
  const api: Record<string, unknown> = {};

  for (const key of Object.keys(registry)) {
    if (!isValidKey(key)) {
      throw new Error(
        `[firestate] registry key "${key}" must start with a letter and contain only letters, digits, _ or $`
      );
    }
    const entry = registry[key]!;
    const hookName = toHookName(key);

    if (entry.__kind === "document") {
      const definition = buildDocumentDefinition(entry);
      api[hookName] = (params: Record<string, string> = {}) =>
        useDocument({ definition, params });
    } else {
      const definition = buildCollectionDefinition(entry);
      api[hookName] = (params: Record<string, string> = {}) =>
        useCollection({ definition, params });
    }
  }

  return api as FirestateApi<R>;
}

/**
 * Build the underlying {@link DocumentDefinition} for a registry doc entry.
 * Exported for unit testing — registry consumers should call
 * {@link defineFirestate} instead.
 *
 * @internal
 */
export function buildDocumentDefinition<T extends FirestoreObject>(
  entry: DocEntry<T>
): DocumentDefinition<T> {
  const { collectionPath, idTemplate } = splitDocPath(entry.path);
  // Both halves are functions so any `{param}` placeholder in the
  // collection portion (e.g. `projects/{projectId}/revisions`) is
  // resolved per-call against the params passed to the hook.
  return defineDocument<T>({
    schema: entry.schema,
    collection: (params) => interpolate(collectionPath, params),
    id: (params) => interpolate(idTemplate, params),
    autosave: entry.autosave,
    minLoadTime: entry.minLoadTime,
    readOnly: entry.readOnly,
    retryOnError: entry.retryOnError,
    retryInterval: entry.retryInterval,
  } as DocumentDefinition<T>);
}

/**
 * Build the underlying {@link CollectionDefinition} for a registry col entry.
 *
 * @internal
 */
export function buildCollectionDefinition<T extends FirestoreObject>(
  entry: ColEntry<T>
): CollectionDefinition<T> {
  return defineCollection<T>({
    schema: entry.schema,
    path: (params) => interpolate(entry.path, params),
    autosave: entry.autosave,
    minLoadTime: entry.minLoadTime,
    readOnly: entry.readOnly,
    lazy: entry.lazy,
    queryConstraints: entry.queryConstraints,
    retryOnError: entry.retryOnError,
    retryInterval: entry.retryInterval,
  } as CollectionDefinition<T>);
}

// ---------------------------------------------------------------------------
// Internal helpers (also exported for testing)
// ---------------------------------------------------------------------------

const VALID_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isValidKey(key: string): boolean {
  return VALID_KEY.test(key);
}

function toHookName(key: string): string {
  return `use${key[0]!.toUpperCase()}${key.slice(1)}`;
}

/**
 * Replace `{name}` placeholders in a path template with values from `params`.
 * Throws if a placeholder is missing from `params` — failing loud at the
 * boundary is better than silently building a `taskLists/undefined/tasks`
 * URL and getting a useless Firestore error later.
 *
 * @internal
 */
export function interpolatePath(
  template: string,
  params: Record<string, string>
): string {
  return interpolate(template, params);
}

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => {
    const v = params[key];
    if (v === undefined) {
      throw new Error(
        `[firestate] missing param "${key}" for path "${template}"`
      );
    }
    return v;
  });
}

/**
 * Split a document path template into a collection path and an id template.
 * `'taskLists/{listId}'` → `{ collectionPath: 'taskLists', idTemplate: '{listId}' }`.
 *
 * @internal
 */
export function splitDocPath(path: string): {
  collectionPath: string;
  idTemplate: string;
} {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    throw new Error(
      `[firestate] document path "${path}" must contain at least one '/' separating the collection from the document id`
    );
  }
  return {
    collectionPath: path.slice(0, lastSlash),
    idTemplate: path.slice(lastSlash + 1),
  };
}
