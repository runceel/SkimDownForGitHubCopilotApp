/* Logging for the extension process.
 *
 * Observability must never be able to stop the reading UI. `session.log` is a
 * JSON-RPC request, so it can fail in two different ways: it can throw when
 * called, and — more easily missed — it can return a promise that rejects
 * later. A synchronous try/catch only covers the first, so a rejected log
 * request becomes an unhandled rejection and Node terminates the extension
 * process. That is how a single unsupported log level took the whole canvas
 * down. Both failure modes are absorbed here so callers can log unconditionally.
 *
 * The host accepts a fixed set of severities; anything else is rejected rather
 * than ignored, so levels are normalised before the request leaves this module.
 */

/** Severities the host accepts (`SessionLogLevel`). */
export const LOG_LEVELS = Object.freeze(["info", "warning", "error"]);

const DEFAULT_LEVEL = "info";

/** Maps an arbitrary caller level onto a severity the host accepts. */
export function normalizeLogLevel(level) {
    if (typeof level !== "string") return DEFAULT_LEVEL;
    const candidate = level.trim().toLowerCase();
    return LOG_LEVELS.includes(candidate) ? candidate : DEFAULT_LEVEL;
}

/* Rejections are absorbed rather than retried, because the fallback below has
 * already had its turn and a log line is never worth a second failure. */
function absorb(result) {
    if (result && typeof result.then === "function") {
        result.then(undefined, () => {});
    }
}

/** Sends one log request, absorbing a synchronous throw. Returns false if the
 *  call itself threw, so the caller can decide whether a retry is worthwhile. */
function attempt(sessionLog, session, message, options) {
    try {
        absorb(options === undefined ? sessionLog.call(session, message) : sessionLog.call(session, message, options));
        return true;
    } catch {
        return false;
    }
}

/**
 * Builds the extension's logger.
 *
 * `getSession` is resolved per call because the session is only available after
 * the extension has joined it, while logging is wired up before that.
 */
export function createLogger(getSession) {
    return function log(message, options) {
        let session;
        try {
            session = typeof getSession === "function" ? getSession() : getSession;
        } catch {
            return;
        }

        const sessionLog = session?.log;
        if (typeof sessionLog !== "function") return;

        const text = typeof message === "string" ? message : String(message);
        const level = normalizeLogLevel(options?.level);
        const ephemeral = options?.ephemeral ?? true;

        if (attempt(sessionLog, session, text, { ...options, level, ephemeral })) return;

        // Some hosts reject the options shape rather than the level. One retry
        // without options is worth a plain log line; a second failure is not.
        attempt(sessionLog, session, text, undefined);
    };
}
