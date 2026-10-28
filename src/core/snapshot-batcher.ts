import type { FirestateStore } from './store'

/**
 * Firestore can deliver many listener snapshots in one task: its queue runs as
 * a promise chain, so a burst of server writes (e.g. a Cloud Function that
 * updates 100+ documents one by one) arrives back to back. Publishing each one
 * makes React run one synchronous `useSyncExternalStore` commit per snapshot.
 * When a consumer's effect schedules more work after each commit, React counts
 * the commits as nested updates and throws "Maximum update depth exceeded"
 * (#185) after 50 of them.
 *
 * The batcher publishes the first snapshot of a task right away, so a single
 * snapshot stays synchronous. It folds every later snapshot of the same task
 * into one publish per subscription on the next task. One batcher is shared by
 * every subscription on a store, because a burst spread across many document
 * subscriptions (one snapshot each) commits just as often as a burst on one.
 */
export const createSnapshotBatcher = () => {
    let windowTimeout: ReturnType<typeof setTimeout> | null = null
    const deferred = new Set<() => void>()

    const publishSnapshot = (publish: () => void) => {
        if (windowTimeout !== null) {
            deferred.add(publish)
            return
        }
        publish()
        windowTimeout = setTimeout(() => {
            windowTimeout = null
            const pending = [...deferred]
            deferred.clear()
            // Publishing in one synchronous loop lets React batch them into a
            // single commit.
            pending.forEach((fn) => fn())
        }, 0)
    }

    // Called when a synchronous notify already delivered the latest state, or
    // when the subscription stops, so its deferred snapshot has nothing to do.
    const discardDeferred = (publish: () => void) => {
        deferred.delete(publish)
    }

    return { publishSnapshot, discardDeferred }
}

export type SnapshotBatcher = ReturnType<typeof createSnapshotBatcher>

const batchers = new WeakMap<FirestateStore, SnapshotBatcher>()

/** The snapshot batcher shared by every subscription on `store`. */
export const getSnapshotBatcher = (store: FirestateStore): SnapshotBatcher => {
    let batcher = batchers.get(store)
    if (!batcher) {
        batcher = createSnapshotBatcher()
        batchers.set(store, batcher)
    }
    return batcher
}
