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
 * export const { useTaskList, useTasks } = createFirestate({
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
import {
  useDocument,
  useCollection,
  type UseDocumentOptions,
  type UseCollectionOptions,
} from "../react/hooks";
import type {
  CollectionDefinition,
  CollectionHandle,
  DocumentDefinition,
  DocumentHandle,
  FirestoreObject,
} from "../types";
import type { QueryConstraint } from "firebase/firestore";
import type { ZodType, z } from "zod";

/**
 * Knobs forwarded from a generated document hook to {@link useDocument}.
 * Same shape as `UseDocumentOptions` minus the fields the registry already
 * owns (`definition`, `params`).
 */
export type DocHookOptions<T extends FirestoreObject> = Omit<
  UseDocumentOptions<T>,
  "definition" | "params"
>;

/**
 * Knobs forwarded from a generated collection hook to {@link useCollection}.
 */
export type ColHookOptions<T extends FirestoreObject> = Omit<
  UseCollectionOptions<T>,
  "definition" | "params"
>;

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
 * The `P` generic carries the path template's string-literal type so the
 * generated hook can type-check param keys. `__kind` is a runtime
 * discriminator; `__type` is a phantom field used purely for inference at
 * the call site and is never read.
 */
export interface DocEntry<
  T extends FirestoreObject,
  P extends string = string
> extends CommonEntryOptions {
  readonly __kind: "document";
  readonly __type?: T;
  /**
   * Path template, e.g. `'taskLists/{listId}'`, or a function returning the
   * **full document path** at runtime (the collection/id split happens
   * per-call via {@link splitDocPath}). Use the function form for paths that
   * branch on a param. See {@link PathArg}.
   */
  path: PathArg<P>;
  /**
   * Zod schema. **Required** — firestate's registry API is opinionated
   * about Zod. The schema is the source of `T` for the generated hooks
   * via `z.infer`, and firestate runs `schema.parse(...)` on full-payload
   * writes (`set`/`add`) so bad data throws at the call site rather than
   * after a Firestore round trip. Partial `update(diff)` is NOT validated
   * (diffs frequently contain Firestore sentinels like `serverTimestamp()`).
   *
   * If you don't want a schema at all, use {@link defineDocument} directly —
   * the escape hatch keeps the plain-TypeScript form at the cost of looser
   * param typing and no runtime validation.
   */
  schema: ZodType<T>;
}

/** Collection entry in a Firestate registry. Produced by {@link col}. */
export interface ColEntry<
  T extends FirestoreObject,
  P extends string = string
> extends CommonEntryOptions {
  readonly __kind: "collection";
  readonly __type?: T;
  /**
   * Path template, e.g. `'taskLists/{listId}/tasks'`, or a function returning
   * the **collection path** at runtime. Use the function form for paths that
   * branch on a param. See {@link PathArg}.
   */
  path: PathArg<P>;
  /** Zod schema. Required. See {@link DocEntry.schema}. */
  schema: ZodType<T>;
  /** Only subscribe when `load()` is called. */
  lazy?: boolean;
  /** Additional Firestore query constraints. */
  queryConstraints?: QueryConstraint[];
}

export type FirestateEntry<
  T extends FirestoreObject = FirestoreObject,
  P extends string = string
> = DocEntry<T, P> | ColEntry<T, P>;

export type FirestateRegistry = Record<string, FirestateEntry<any, any>>;

// ---------------------------------------------------------------------------
// Path → params extraction
// ---------------------------------------------------------------------------

/**
 * Extract `{name}` placeholders from a path template into a params shape.
 *
 * - `'users'` → `{}`
 * - `'users/{userId}'` → `{ userId: string }`
 * - `'projects/{projectId}/revisions/{revisionId}'` → `{ projectId: string; revisionId: string }`
 *
 * When the path is widened to `string` (no literal preserved), we fall
 * back to `Record<string, string>` so existing call sites keep compiling.
 */
export type ParamsOf<P extends string> = string extends P
  ? Record<string, string>
  : Prettify<RawParamsOf<P>>;

type RawParamsOf<P extends string> =
  P extends `${string}{${infer K}}${infer Rest}`
    ? { [Key in K]: string } & RawParamsOf<Rest>
    : {};

// Force TS to evaluate intersections so error messages show
// `{ projectId: string; revisionId: string }` instead of an intersection.
type Prettify<T> = { [K in keyof T]: T[K] } & {};

/**
 * The `path` accepted by {@link doc} / {@link col}. Either a static template
 * (whose `{param}` placeholders are interpolated and whose param keys are
 * inferred via {@link ParamsOf}), or a function that returns the path at
 * runtime — for paths that branch on a param, e.g. live
 * `projects/{projectId}/spaces` vs. revision
 * `projects/{projectId}/revisions/{revisionId}/spaces`.
 *
 * With the function form, params can't be inferred from a template, so the
 * generated hook's params fall back to `Record<string, string>`.
 */
export type PathArg<P extends string> =
  | P
  | ((params: Record<string, string>) => string);

// ---------------------------------------------------------------------------
// Entry factories
// ---------------------------------------------------------------------------

type DocOpts<T extends FirestoreObject> = Omit<DocEntry<T>, "__kind" | "__type" | "path">;
type ColOpts<T extends FirestoreObject> = Omit<ColEntry<T>, "__kind" | "__type" | "path">;

/**
 * Declare a single-document entry for a Firestate registry.
 *
 * **A Zod `schema` field is required.** Both the data type (`T`) and the
 * path's literal type (`P`) are inferred from the call — `T` via
 * `z.infer<S>`, `P` from `path` — so the generated hook can statically
 * type-check the params object the caller passes. The schema also runs
 * at runtime on full-payload writes (`set`/`add`).
 *
 * If you'd rather not provide a schema at all, use {@link defineDocument}
 * directly — that escape hatch keeps the plain-TypeScript form, at the
 * cost of looser param typing on the hook and no runtime validation.
 *
 * `path` may also be a function returning the full document path at runtime —
 * for paths that branch on a param. Param keys can't be inferred from a
 * function, so they fall back to `Record<string, string>`. See {@link PathArg}.
 *
 * ```ts
 * import { z } from 'zod'
 *
 * const TaskListSchema = z.object({ name: z.string(), createdAt: z.number() })
 * doc({ path: 'taskLists/{listId}', schema: TaskListSchema })
 * // → DocEntry<{ name: string; createdAt: number }, 'taskLists/{listId}'>
 * ```
 */
export function doc<
  S extends ZodType<FirestoreObject>,
  const P extends string = string
>(
  opts: Omit<DocOpts<z.infer<S>>, "schema"> & {
    schema: S;
    path: PathArg<P>;
  }
): DocEntry<z.infer<S>, P> {
  const { path, ...rest } = opts;
  // Static templates fail loud at registration: a malformed placeholder or a
  // path that can't be split into a non-empty collection + id throws here.
  // Function paths are checked per-call in buildDocumentDefinition, once they
  // resolve to a concrete string.
  if (typeof path === "string") {
    validateTemplate(path);
    splitDocPath(path);
  }
  return { __kind: "document", path, ...rest } as unknown as DocEntry<
    z.infer<S>,
    P
  >;
}

/**
 * Declare a collection entry for a Firestate registry. See {@link doc}
 * for the schema/typing contract. `path` may also be a function returning
 * the collection path at runtime — see {@link PathArg}.
 */
export function col<
  S extends ZodType<FirestoreObject>,
  const P extends string = string
>(
  opts: Omit<ColOpts<z.infer<S>>, "schema"> & {
    schema: S;
    path: PathArg<P>;
  }
): ColEntry<z.infer<S>, P> {
  const { path, ...rest } = opts;
  // Static templates fail loud at registration; function paths resolve later.
  if (typeof path === "string") {
    validateTemplate(path);
  }
  return { __kind: "collection", path, ...rest } as unknown as ColEntry<
    z.infer<S>,
    P
  >;
}

// ---------------------------------------------------------------------------
// createFirestate
// ---------------------------------------------------------------------------

type HookName<K extends string> = `use${Capitalize<K>}`;

// If the path template has no placeholders, `params` is optional (any
// caller-supplied object is fine). When the template has placeholders,
// the caller must pass an object with exactly the extracted keys.
type HookFor<E> = E extends DocEntry<infer T, infer P>
  ? keyof ParamsOf<P> extends never
    ? (
        params?: Record<string, string>,
        options?: DocHookOptions<T>
      ) => DocumentHandle<T>
    : (
        params: ParamsOf<P>,
        options?: DocHookOptions<T>
      ) => DocumentHandle<T>
  : E extends ColEntry<infer T, infer P>
  ? keyof ParamsOf<P> extends never
    ? (
        params?: Record<string, string>,
        options?: ColHookOptions<T>
      ) => CollectionHandle<T>
    : (
        params: ParamsOf<P>,
        options?: ColHookOptions<T>
      ) => CollectionHandle<T>
  : never;

export type FirestateApi<R extends FirestateRegistry> = {
  [K in keyof R & string as HookName<K>]: HookFor<R[K]>;
};

/**
 * Turn a Firestate registry into a map of typed React hooks. Each entry
 * `K` produces a hook named `use{Capitalize<K>}`.
 *
 * ```ts
 * export const { useTaskList, useTasks } = createFirestate({
 *   taskList: doc<TaskList>('taskLists/{listId}'),
 *   tasks:    col<Task>('taskLists/{listId}/tasks'),
 * })
 * ```
 */
export function createFirestate<R extends FirestateRegistry>(
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
      api[hookName] = (
        params: Record<string, string> = {},
        options: DocHookOptions<FirestoreObject> = {}
      ) => useDocument({ ...options, definition, params });
    } else {
      const definition = buildCollectionDefinition(entry);
      api[hookName] = (
        params: Record<string, string> = {},
        options: ColHookOptions<FirestoreObject> = {}
      ) => useCollection({ ...options, definition, params });
    }
  }

  return api as FirestateApi<R>;
}

/**
 * Build the underlying {@link DocumentDefinition} for a registry doc entry.
 * Exported for unit testing — registry consumers should call
 * {@link createFirestate} instead.
 *
 * @internal
 */
export function buildDocumentDefinition<T extends FirestoreObject>(
  entry: DocEntry<T>
): DocumentDefinition<T> {
  const { path } = entry;
  const common = {
    schema: entry.schema,
    autosave: entry.autosave,
    minLoadTime: entry.minLoadTime,
    readOnly: entry.readOnly,
    retryOnError: entry.retryOnError,
    retryInterval: entry.retryInterval,
  };

  if (typeof path === "function") {
    // The function returns the FULL document path; split it per-call. It has
    // no `{param}` placeholders left to interpolate, but splitDocPath still
    // throws loud on a missing '/' or an empty collection/id segment — the
    // boundary check, just deferred to resolution time.
    return defineDocument<T>({
      ...common,
      collection: (params) => splitDocPath(path(params)).collectionPath,
      id: (params) => splitDocPath(path(params)).idTemplate,
    } as DocumentDefinition<T>);
  }

  // Static template. Both halves are functions so any `{param}` placeholder in
  // the collection portion (e.g. `projects/{projectId}/revisions`) is resolved
  // per-call against the params passed to the hook.
  const { collectionPath, idTemplate } = splitDocPath(path);
  return defineDocument<T>({
    ...common,
    collection: (params) => interpolate(collectionPath, params),
    id: (params) => interpolate(idTemplate, params),
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
  const { path } = entry;
  return defineCollection<T>({
    schema: entry.schema,
    // Function paths pass straight through to defineCollection; static
    // templates are interpolated per-call.
    path:
      typeof path === "function"
        ? path
        : (params) => interpolate(path, params),
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

// Matches a single `{name}` placeholder where the name is a valid JS-ish
// identifier (letter or underscore start, then letters/digits/underscores).
// Used both to interpolate and to validate templates up front.
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * Validate that a path template uses only well-formed `{name}` placeholders
 * — no unclosed braces, no hyphens/dots inside placeholders, no `{1}` style
 * digit-leading names. Throws at definition time so a typo in the template
 * fails loud at `doc()` / `col()`, not three layers deep when a component
 * mounts.
 */
function validateTemplate(template: string): void {
  // Strip the well-formed placeholders, then look for any stray `{` or `}` —
  // those signal a malformed (unclosed or weirdly-spelled) placeholder.
  const stripped = template.replace(PLACEHOLDER, "");
  if (stripped.includes("{") || stripped.includes("}")) {
    throw new Error(
      `[firestate] path "${template}" contains a malformed placeholder. ` +
        `Placeholders must look like "{name}" where name starts with a letter or underscore.`
    );
  }
}

function interpolate(template: string, params: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (_, key) => {
    const v = params[key];
    if (v === undefined) {
      throw new Error(
        `[firestate] missing param "${key}" for path "${template}"`
      );
    }
    if (v === "") {
      // An empty value would silently produce `taskLists//tasks`, which
      // Firestore later rejects with an opaque "Document path must not be
      // empty" — keep the friendly error at the boundary.
      throw new Error(
        `[firestate] param "${key}" for path "${template}" must not be an empty string`
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
  const collectionPath = path.slice(0, lastSlash);
  const idTemplate = path.slice(lastSlash + 1);
  if (collectionPath === "" || idTemplate === "") {
    throw new Error(
      `[firestate] document path "${path}" must have non-empty collection and id segments`
    );
  }
  return { collectionPath, idTemplate };
}
