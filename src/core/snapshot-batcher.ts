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
 * into one publish on the next task.
 */
export const createSnapshotBatcher = (publish: () => void) => {
    let windowTimeout: ReturnType<typeof setTimeout> | null = null
    let hasDeferredSnapshot = false

    const publishSnapshot = () => {
        if (windowTimeout !== null) {
            hasDeferredSnapshot = true
            return
        }
        publish()
        windowTimeout = setTimeout(() => {
            windowTimeout = null
            if (!hasDeferredSnapshot) return
            hasDeferredSnapshot = false
            publish()
        }, 0)
    }

    const cancel = () => {
        if (windowTimeout !== null) {
            clearTimeout(windowTimeout)
            windowTimeout = null
        }
        hasDeferredSnapshot = false
    }

    // A synchronous notify already delivered the latest state, so a deferred
    // snapshot has nothing new to publish.
    const discardDeferred = () => {
        hasDeferredSnapshot = false
    }

    return { publishSnapshot, discardDeferred, cancel }
}
