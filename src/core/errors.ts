import type { ErrorContext } from '../types'

/**
 * Error wrapper that carries its own {@link ErrorContext}.
 *
 * `store.reportError` builds one of these before it calls the consumer's
 * `onError`. The context (resource `type`, `path`, and `operation`) used to
 * travel only as a second argument, so a consumer that forwarded just the first
 * argument to an error tracker dropped every useful field. Then every rules
 * denial from every resource shared one fingerprint whose stack lived inside
 * the minified `@firebase/firestore` bundle.
 *
 * A FirestateError puts the path into the message and onto own fields, so a
 * consumer that forwards the error alone still gets a usable path and a
 * distinct fingerprint per resource. The original error stays reachable through
 * `cause`, and a Firestore error `code` (e.g. `permission-denied`) is copied
 * onto `code` for consumers that branch on it.
 */
export class FirestateError extends Error {
    /** Resource kind the error came from. */
    readonly type: ErrorContext['type']
    /** Firestore path of the document or collection. */
    readonly path: string
    /** Operation that failed. */
    readonly operation: ErrorContext['operation']
    /** Firestore error code copied from the cause, when present. */
    readonly code?: string

    constructor(cause: Error, context: ErrorContext) {
        super(
            `Firestate ${context.type} ${context.operation} failed at ${context.path}: ${cause.message}`,
            { cause }
        )
        this.name = 'FirestateError'
        this.type = context.type
        this.path = context.path
        this.operation = context.operation
        const code = (cause as { code?: unknown }).code
        if (typeof code === 'string') {
            this.code = code
        }
    }
}

/**
 * Firestore error codes that a listener retry can never clear. Re-attaching the
 * listener for one of these spins forever behind a loading spinner, so the
 * subscription treats them as terminal even when `retryOnError` is set.
 *
 * `permission-denied` is a rules denial; `unauthenticated` means the request
 * carried no valid credential. Neither becomes valid by waiting.
 */
const TERMINAL_FIRESTORE_CODES = new Set(['permission-denied', 'unauthenticated'])

/**
 * Report whether a listener error is terminal — a code that a retry will never
 * clear. Unknown or transient codes (e.g. `unavailable`) return `false` so the
 * retry path stays free to re-attach.
 */
export const isTerminalListenerError = (error: unknown): boolean => {
    const code = (error as { code?: unknown } | null)?.code
    return typeof code === 'string' && TERMINAL_FIRESTORE_CODES.has(code)
}
