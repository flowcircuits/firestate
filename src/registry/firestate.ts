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
  useDocumentSyncStatus,
  useDocumentLoadingStatus,
  useCollectionSyncStatus,
  useCollectionLoadingStatus,
  type UseDocumentOptions,
  type UseCollectionOptions,
  type DocumentSelectorOptions,
  type CollectionSelectorOptions,
} from "../react/hooks";
import type {
  CollectionDefinition,
  CollectionHandle,
  CollectionState,
  DocumentDefinition,
  DocumentHandle,
  DocumentState,
  FirestoreObject,
  LoadingStatus,
  SelectedCollectionHandle,
  SelectedDocumentHandle,
  SyncStatus,
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

  /**
   * Derive a **named slice-hook** off this document, sharing its schema and
   * path — the schema is handed to firestate once, here, and never
   * re-specified. The `selector` receives the full {@link DocumentState};
   * return the slice the generated hook reacts to. For a *parameterized* slice,
   * declare the extra params as the selector's second argument — the generated
   * hook then requires the path params **and** those, merged into one bag.
   *
   * Pass the result to {@link createFirestate} under the key the hook is named
   * for. Status is reactive only if the slice reads it, exactly as the inline
   * `selector` option (see {@link DocumentHandle}); the comparator (`isEqual`)
   * is baked in here, not passed per call.
   *
   * ```ts
   * const project = doc({ path: 'projects/{projectId}', schema: ProjectSchema })
   * const { useProject, useProjectTitle } = createFirestate({
   *   project,                                           // → useProject (full)
   *   projectTitle: project.select((s) => s.data?.name), // → useProjectTitle
   * })
   * ```
   *
   * A derived entry is a leaf, not a base: there is intentionally no
   * `.select(...).select(...)` chaining.
   *
   * `PExtra` (the selector's own params) defaults to `{}`: a one-argument
   * selector leaves it unbound, a two-argument one infers it from the annotated
   * second parameter. One signature keeps the selector's `state` arg reliably
   * typed in both cases. `PExtra` is intentionally unconstrained — leaving it
   * `extends Record<string, string>` made TS resolve a param-less selector's
   * `PExtra` to that constraint (not the `{}` default), wrongly forcing a
   * `params` arg on no-placeholder paths; unconstrained also lets a slice take
   * non-string params (e.g. `{ index: number }`).
   */
  select<TSelected, PExtra = {}>(
    selector: (state: DocumentState<T>, params: PExtra) => TSelected,
    options?: SelectOptions<TSelected>
  ): SelectedDocEntry<T, P, PExtra, TSelected>;
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

  /**
   * Derive a **named slice-hook** off this collection, sharing its schema,
   * path, and query — see {@link DocEntry.select}. The `selector` receives the
   * full {@link CollectionState} (`s.data` is the keyed record), and a
   * parameterized slice declares its extra params as the selector's second
   * argument.
   *
   * ```ts
   * const tasks = col({ path: 'projects/{projectId}/tasks', schema: TaskSchema })
   * const { useTasks, useTaskIds, useTaskById } = createFirestate({
   *   tasks,                                                  // → useTasks (full)
   *   taskIds:  tasks.select((s) => Object.keys(s.data)),     // → useTaskIds
   *   taskById: tasks.select((s, p: { id: string }) => s.data[p.id]), // → useTaskById
   * })
   * // useTaskById requires the merged bag: useTaskById({ projectId, id })
   * ```
   *
   * `PExtra` defaults to `{}` and is unconstrained — see {@link DocEntry.select}.
   */
  select<TSelected, PExtra = {}>(
    selector: (state: CollectionState<T>, params: PExtra) => TSelected,
    options?: SelectOptions<TSelected>
  ): SelectedColEntry<T, P, PExtra, TSelected>;
}

/**
 * Options bundled into a `.select(...)` entry at definition time. Kept separate
 * from the runtime hook options (`enabled`/`readOnly`/`queryConstraints`)
 * because these are baked into the named hook, not passed per call.
 */
export interface SelectOptions<TSelected> {
  /**
   * Comparator for this named hook's slice; the hook re-renders only when it
   * returns `false`. Defaults to a deep value compare (so a fresh object/array
   * of equal shape does not over-render). Pass {@link shallow} or a custom fn.
   */
  isEqual?: (a: TSelected, b: TSelected) => boolean;
}

/**
 * A {@link DocEntry} narrowed by a `.select(...)` projection. Produced by
 * {@link DocEntry.select}, consumed by {@link createFirestate}, which turns it
 * into a hook whose `data` is the slice (`TSelected`) and whose params are the
 * path params (`P`) merged with the selector's own params (`PExtra`).
 *
 * The schema/path/options live on `base` — a derived entry never re-declares
 * them. `PExtra` is `{}` for an un-parameterized selector.
 */
export interface SelectedDocEntry<
  T extends FirestoreObject,
  P extends string,
  PExtra,
  TSelected
> {
  readonly __kind: "document-selected";
  /** Base entry carrying schema/path/options — handed to firestate once. */
  readonly base: DocEntry<T, P>;
  /** Projection over the full state; receives the merged params bag at runtime. */
  readonly selector: (state: DocumentState<T>, params: PExtra) => TSelected;
  /** Comparator baked in at definition time (see {@link SelectOptions}). */
  readonly isEqual?: (a: TSelected, b: TSelected) => boolean;
}

/**
 * A {@link ColEntry} narrowed by a `.select(...)` projection. See
 * {@link SelectedDocEntry}; the selector receives the collection's keyed state.
 */
export interface SelectedColEntry<
  T extends FirestoreObject,
  P extends string,
  PExtra,
  TSelected
> {
  readonly __kind: "collection-selected";
  /** Base entry carrying schema/path/query/options — handed to firestate once. */
  readonly base: ColEntry<T, P>;
  /** Projection over the full state; receives the merged params bag at runtime. */
  readonly selector: (state: CollectionState<T>, params: PExtra) => TSelected;
  /** Comparator baked in at definition time (see {@link SelectOptions}). */
  readonly isEqual?: (a: TSelected, b: TSelected) => boolean;
}

export type FirestateEntry<
  T extends FirestoreObject = FirestoreObject,
  P extends string = string
> = DocEntry<T, P> | ColEntry<T, P>;

/** Any `.select(...)`-derived entry, regardless of its type parameters. */
export type AnySelectedEntry =
  | SelectedDocEntry<any, any, any, any>
  | SelectedColEntry<any, any, any, any>;

export type FirestateRegistry = Record<
  string,
  FirestateEntry<any, any> | AnySelectedEntry
>;

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

// `select` is excluded too: it's a method the factory attaches, never an input.
type DocOpts<T extends FirestoreObject> = Omit<
  DocEntry<T>,
  "__kind" | "__type" | "path" | "select"
>;
type ColOpts<T extends FirestoreObject> = Omit<
  ColEntry<T>,
  "__kind" | "__type" | "path" | "select"
>;

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
  const entry = { __kind: "document", path, ...rest } as Record<string, unknown>;
  // Attach the `.select(...)` builder. It closes over `entry`, so a derived
  // entry's `base` is this exact object — the schema/path/options are handed to
  // firestate once, here, and reused by every slice-hook derived from it.
  entry.select = (
    selector: (
      state: DocumentState<FirestoreObject>,
      params: Record<string, string>
    ) => unknown,
    options?: SelectOptions<unknown>
  ): SelectedDocEntry<FirestoreObject, string, Record<string, string>, unknown> => ({
    __kind: "document-selected",
    base: entry as unknown as DocEntry<FirestoreObject, string>,
    selector,
    isEqual: options?.isEqual,
  });
  return entry as unknown as DocEntry<z.infer<S>, P>;
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
  const entry = { __kind: "collection", path, ...rest } as Record<string, unknown>;
  // See doc(): the builder closes over `entry` so derived hooks reuse this
  // collection's schema/path/query — never re-specified.
  entry.select = (
    selector: (
      state: CollectionState<FirestoreObject>,
      params: Record<string, string>
    ) => unknown,
    options?: SelectOptions<unknown>
  ): SelectedColEntry<FirestoreObject, string, Record<string, string>, unknown> => ({
    __kind: "collection-selected",
    base: entry as unknown as ColEntry<FirestoreObject, string>,
    selector,
    isEqual: options?.isEqual,
  });
  return entry as unknown as ColEntry<z.infer<S>, P>;
}

// ---------------------------------------------------------------------------
// createFirestate
// ---------------------------------------------------------------------------

type HookName<K extends string> = `use${Capitalize<K>}`;

// Excludes selector options from the non-selector overload, so passing a real
// `selector` falls through to the selector overload (which infers `TSelected`)
// instead of resolving to the full-data return.
type NoSelector = { selector?: undefined; isEqual?: undefined };

// Each generated hook is overloaded: call it without a `selector` to get the
// full handle, or with one to get a handle whose `data` is the selected slice.
// The two `*OptionalParams` / `*RequiredParams` shapes capture whether the path
// template has placeholders (optional vs. required `params`). In the selector
// overload `options` is required (it must carry `selector`), so `params` cannot
// be optional before it — the no-placeholder selector form therefore takes
// `params` as `Record<string, string> | undefined` (pass `{}` or `undefined`).

interface DocHookOptionalParams<T extends FirestoreObject> {
  (
    params?: Record<string, string>,
    options?: DocHookOptions<T> & NoSelector
  ): DocumentHandle<T>;
  <TSelected>(
    params: Record<string, string> | undefined,
    options: DocHookOptions<T> & DocumentSelectorOptions<T, TSelected>
  ): SelectedDocumentHandle<T, TSelected>;
}

interface DocHookRequiredParams<T extends FirestoreObject, P extends string> {
  (
    params: ParamsOf<P>,
    options?: DocHookOptions<T> & NoSelector
  ): DocumentHandle<T>;
  <TSelected>(
    params: ParamsOf<P>,
    options: DocHookOptions<T> & DocumentSelectorOptions<T, TSelected>
  ): SelectedDocumentHandle<T, TSelected>;
}

interface ColHookOptionalParams<T extends FirestoreObject> {
  (
    params?: Record<string, string>,
    options?: ColHookOptions<T> & NoSelector
  ): CollectionHandle<T>;
  <TSelected>(
    params: Record<string, string> | undefined,
    options: ColHookOptions<T> & CollectionSelectorOptions<T, TSelected>
  ): SelectedCollectionHandle<T, TSelected>;
}

interface ColHookRequiredParams<T extends FirestoreObject, P extends string> {
  (
    params: ParamsOf<P>,
    options?: ColHookOptions<T> & NoSelector
  ): CollectionHandle<T>;
  <TSelected>(
    params: ParamsOf<P>,
    options: ColHookOptions<T> & CollectionSelectorOptions<T, TSelected>
  ): SelectedCollectionHandle<T, TSelected>;
}

// ---------------------------------------------------------------------------
// Selected (`.select`) hook shapes
// ---------------------------------------------------------------------------

// The merged params bag for a selected hook: the path-template params (`P`)
// intersected with the selector's own params (`PExtra`), flattened so errors
// read as one object instead of an intersection.
//
// `PExtra` arrives as `any` when the selector took no params (an empty `{}`
// `PExtra` widens to `any` through the registry's `AnySelectedEntry` bound — the
// `{}` is absorbed in the contravariant selector position). `any` here means "no
// declared params", so the bag is just the path params; otherwise a no-arg slice
// on a no-placeholder path would wrongly demand a `Record<string, any>`. A real
// `PExtra` (e.g. `{ id: string }`) is never `any` and merges normally.
type IsAny<T> = 0 extends 1 & T ? true : false;
type SelectedParams<P extends string, PExtra> = IsAny<PExtra> extends true
  ? ParamsOf<P>
  : Prettify<ParamsOf<P> & PExtra>;

// Generated hook for a selected document entry: `data` is the slice, `params`
// is the merged bag, and `options` carries only the runtime knobs — the
// selector and its comparator are baked in, so neither appears here. Params are
// optional only when the merged bag has no keys (static path, no selector params).
type SelectedDocHookFor<
  T extends FirestoreObject,
  P extends string,
  PExtra,
  TSelected
> = keyof SelectedParams<P, PExtra> extends never
  ? (
      params?: Record<string, string>,
      options?: DocHookOptions<T>
    ) => SelectedDocumentHandle<T, TSelected>
  : (
      params: SelectedParams<P, PExtra>,
      options?: DocHookOptions<T>
    ) => SelectedDocumentHandle<T, TSelected>;

// As {@link SelectedDocHookFor}, for a selected collection entry.
type SelectedColHookFor<
  T extends FirestoreObject,
  P extends string,
  PExtra,
  TSelected
> = keyof SelectedParams<P, PExtra> extends never
  ? (
      params?: Record<string, string>,
      options?: ColHookOptions<T>
    ) => SelectedCollectionHandle<T, TSelected>
  : (
      params: SelectedParams<P, PExtra>,
      options?: ColHookOptions<T>
    ) => SelectedCollectionHandle<T, TSelected>;

// Selected entries are matched first: they carry no `path`/`schema`, so they
// never collide with the base Doc/ColEntry arms below. For a base entry, a path
// template with no placeholders takes optional `params`; one with placeholders
// requires an object with exactly the extracted keys.
type HookFor<E> = E extends SelectedDocEntry<
  infer T,
  infer P,
  infer PExtra,
  infer TSelected
>
  ? SelectedDocHookFor<T, P, PExtra, TSelected>
  : E extends SelectedColEntry<infer T, infer P, infer PExtra, infer TSelected>
  ? SelectedColHookFor<T, P, PExtra, TSelected>
  : E extends DocEntry<infer T, infer P>
  ? keyof ParamsOf<P> extends never
    ? DocHookOptionalParams<T>
    : DocHookRequiredParams<T, P>
  : E extends ColEntry<infer T, infer P>
  ? keyof ParamsOf<P> extends never
    ? ColHookOptionalParams<T>
    : ColHookRequiredParams<T, P>
  : never;

// ---------------------------------------------------------------------------
// Per-entry status hooks (sync / loading)
// ---------------------------------------------------------------------------

// Each *base* doc/col entry also gets `use{Name}SyncStatus` and
// `use{Name}LoadingStatus`. `.select` (derived) entries do not: a slice's sync
// and loading status are the resource's, read through its base hooks.
type SyncStatusHookName<K extends string> = `${HookName<K>}SyncStatus`;
type LoadingStatusHookName<K extends string> = `${HookName<K>}LoadingStatus`;

// Base (non-selected) entries, used to gate which keys produce status hooks.
type BaseEntry = DocEntry<any, any> | ColEntry<any, any>;

// Runtime knobs forwarded to a generated status hook. Documents take only
// `enabled`; collections add `queryConstraints` (which must match the data
// hook's, or the status hook resolves a different shared entry — i.e. a second
// listener). `readOnly`/`selector`/`isEqual` are owned by the status hook.
type DocStatusHookOptions = { enabled?: boolean };
type ColStatusHookOptions = {
  enabled?: boolean;
  queryConstraints?: QueryConstraint[];
};

// Params follow the same optional-vs-required rule as the data hooks: a path
// with no `{placeholder}` takes optional `params`; one with placeholders
// requires exactly those keys. `R` is the returned status shape.
type DocStatusHookFor<P extends string, Ret> = keyof ParamsOf<P> extends never
  ? (params?: Record<string, string>, options?: DocStatusHookOptions) => Ret
  : (params: ParamsOf<P>, options?: DocStatusHookOptions) => Ret;

type ColStatusHookFor<P extends string, Ret> = keyof ParamsOf<P> extends never
  ? (params?: Record<string, string>, options?: ColStatusHookOptions) => Ret
  : (params: ParamsOf<P>, options?: ColStatusHookOptions) => Ret;

type SyncStatusHookFor<E> = E extends DocEntry<any, infer P>
  ? DocStatusHookFor<P, SyncStatus>
  : E extends ColEntry<any, infer P>
  ? ColStatusHookFor<P, SyncStatus>
  : never;

type LoadingStatusHookFor<E> = E extends DocEntry<any, infer P>
  ? DocStatusHookFor<P, LoadingStatus>
  : E extends ColEntry<any, infer P>
  ? ColStatusHookFor<P, LoadingStatus>
  : never;

// The generated API: the data/slice hooks, plus a sync-status and a
// loading-status hook for every BASE entry (selected entries map their status
// key to `never`, which drops it). Three mapped types intersected because key
// remapping yields one key per source key — destructuring resolves the
// intersection member-by-member.
export type FirestateApi<R extends FirestateRegistry> = {
  [K in keyof R & string as HookName<K>]: HookFor<R[K]>;
} & {
  [K in keyof R & string as R[K] extends BaseEntry
    ? SyncStatusHookName<K>
    : never]: SyncStatusHookFor<R[K]>;
} & {
  [K in keyof R & string as R[K] extends BaseEntry
    ? LoadingStatusHookName<K>
    : never]: LoadingStatusHookFor<R[K]>;
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

  // Built definitions are memoized by their *base entry object*, so the base
  // hook and every `.select` sibling derived from it resolve the SAME definition
  // — and therefore the SAME shared subscription (one onSnapshot listener, one
  // optimistic state). `.select` stores the base entry by reference, so `entry`
  // (a base) and `entry.base` (a selected entry) hit the same key. Without this,
  // each registry key built a fresh definition and the shared-subscription
  // registry (keyed by definition identity) forked one listener per hook.
  const docDefs = new Map<
    DocEntry<FirestoreObject, string>,
    DocumentDefinition<FirestoreObject>
  >();
  const colDefs = new Map<
    ColEntry<FirestoreObject, string>,
    CollectionDefinition<FirestoreObject>
  >();
  const docDefFor = (
    base: DocEntry<FirestoreObject, string>
  ): DocumentDefinition<FirestoreObject> => {
    let def = docDefs.get(base);
    if (!def) {
      def = buildDocumentDefinition(base);
      docDefs.set(base, def);
    }
    return def;
  };
  const colDefFor = (
    base: ColEntry<FirestoreObject, string>
  ): CollectionDefinition<FirestoreObject> => {
    let def = colDefs.get(base);
    if (!def) {
      def = buildCollectionDefinition(base);
      colDefs.set(base, def);
    }
    return def;
  };

  for (const key of Object.keys(registry)) {
    if (!isValidKey(key)) {
      throw new Error(
        `[firestate] registry key "${key}" must start with a letter and contain only letters, digits, _ or $`
      );
    }
    const entry = registry[key]!;
    const hookName = toHookName(key);

    if (entry.__kind === "document") {
      const definition = docDefFor(entry);
      api[hookName] = (
        params: Record<string, string> = {},
        options: DocHookOptions<FirestoreObject> = {}
      ) => useDocument({ ...options, definition, params });
      // Sync/loading status siblings share the same `definition`, so they
      // resolve the SAME shared subscription as the data hook (no extra
      // listener) — see the shared-subscription contract.
      api[`${hookName}SyncStatus`] = (
        params: Record<string, string> = {},
        options: DocStatusHookOptions = {}
      ) => useDocumentSyncStatus({ definition, params, enabled: options.enabled });
      api[`${hookName}LoadingStatus`] = (
        params: Record<string, string> = {},
        options: DocStatusHookOptions = {}
      ) =>
        useDocumentLoadingStatus({ definition, params, enabled: options.enabled });
    } else if (entry.__kind === "collection") {
      const definition = colDefFor(entry);
      api[hookName] = (
        params: Record<string, string> = {},
        options: ColHookOptions<FirestoreObject> = {}
      ) => useCollection({ ...options, definition, params });
      api[`${hookName}SyncStatus`] = (
        params: Record<string, string> = {},
        options: ColStatusHookOptions = {}
      ) =>
        useCollectionSyncStatus({
          definition,
          params,
          enabled: options.enabled,
          queryConstraints: options.queryConstraints,
        });
      api[`${hookName}LoadingStatus`] = (
        params: Record<string, string> = {},
        options: ColStatusHookOptions = {}
      ) =>
        useCollectionLoadingStatus({
          definition,
          params,
          enabled: options.enabled,
          queryConstraints: options.queryConstraints,
        });
    } else if (entry.__kind === "document-selected") {
      const definition = docDefFor(entry.base);
      const { selector, isEqual } = entry;
      api[hookName] = (
        params: Record<string, string> = {},
        options: DocHookOptions<FirestoreObject> = {}
      ) =>
        useDocument({
          ...options,
          definition,
          params,
          // Adapt the (state, params) selector to Level 1's inline `selector`
          // by closing over this call's params bag — so a parameterized slice
          // (e.g. `(s, p) => s.data[p.id]`) reads its id from the same bag the
          // path resolved from. A fresh closure each render is fine: useDocument
          // dedupes on the selected *value*, not the selector's identity.
          selector: (state) => selector(state, params),
          isEqual,
        });
    } else {
      // collection-selected
      const definition = colDefFor(entry.base);
      const { selector, isEqual } = entry;
      api[hookName] = (
        params: Record<string, string> = {},
        options: ColHookOptions<FirestoreObject> = {}
      ) =>
        useCollection({
          ...options,
          definition,
          params,
          selector: (state) => selector(state, params),
          isEqual,
        });
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
