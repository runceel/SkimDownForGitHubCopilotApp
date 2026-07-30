const REASON_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SOURCES = new Set(["shell", "renderer"]);
const READY_STATES = new Set(["loading", "interactive", "complete"]);
const DIRECT_HANDLES = new Set(["function", "missing"]);
const INSTALL_STRATEGIES = new Set([
    "define-on-chrome",
    "replace-chrome",
    "patch-webview",
    "failed",
]);
const JAVASCRIPT_TYPES = new Set([
    "undefined",
    "object",
    "function",
    "string",
    "number",
    "boolean",
    "symbol",
    "bigint",
]);
const VENDOR_KEYS = ["markdownit", "hljs", "DOMPurify", "katex", "mermaid"];

export const DIAG_REQUEST_MAX_BYTES = 12 * 1024;
export const DIAG_ENTRY_MAX_BYTES = 10 * 1024;
export const DIAG_SEGMENT_MAX_BYTES = 32 * 1024;
export const DIAG_RATE_LIMIT = 12;
export const DIAG_RATE_WINDOW_MS = 60 * 1000;
export const DIAG_SCHEMA_VERSION = 2;

export class DiagnosticValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "DiagnosticValidationError";
    }
}

export function validateDiagnostic(input) {
    const value = requireObject(input, "diagnostic");
    assertKeys(value, [
        "from",
        "reason",
        "nested",
        "retried",
        "logs",
        "readyState",
        "bodyChildren",
        "hasBridge",
        "docError",
        "bridge",
        "rendererSnapshot",
        "snapshotError",
        "install",
        "readySent",
        "listeners",
        "directHandle",
        "contentChildren",
        "vendors",
        "errors",
    ], "diagnostic");

    const output = {
        from: requireEnum(value.from, SOURCES, "from"),
        reason: requirePattern(value.reason, REASON_PATTERN, "reason"),
    };
    copyBoolean(value, output, "nested");
    copyBoolean(value, output, "retried");
    copyDiscardedStringArray(value, "logs", 6, 256);
    copyEnum(value, output, "readyState", READY_STATES);
    copyInteger(value, output, "bodyChildren", -1, 100000);
    copyBoolean(value, output, "hasBridge");
    copyErrorPresence(value, output, "docError");
    copyNullableObject(value, output, "bridge", validateBridge);
    copyObject(value, output, "rendererSnapshot", validateSnapshot);
    copyErrorPresence(value, output, "snapshotError");
    copyObject(value, output, "install", validateInstall);
    copyBoolean(value, output, "readySent");
    copyInteger(value, output, "listeners", 0, 1000);
    copyEnum(value, output, "directHandle", DIRECT_HANDLES);
    copyInteger(value, output, "contentChildren", -1, 100000);
    copyObject(value, output, "vendors", validateVendors);
    copyDiscardedStringArray(value, "errors", 8, 256);
    return output;
}

export function createDiagnosticRateLimiter({
    limit = DIAG_RATE_LIMIT,
    windowMs = DIAG_RATE_WINDOW_MS,
    now = Date.now,
} = {}) {
    let accepted = [];
    return {
        take() {
            const current = now();
            accepted = accepted.filter((at) => current - at < windowMs);
            if (accepted.length >= limit) {
                return {
                    allowed: false,
                    retryAfterMs: Math.max(1, windowMs - (current - accepted[0])),
                };
            }
            accepted.push(current);
            return { allowed: true, retryAfterMs: 0 };
        },
    };
}

export function diagnosticByteLength(value) {
    return Buffer.byteLength(JSON.stringify(value) + "\n", "utf8");
}

function validateSnapshot(input) {
    const value = requireObject(input, "rendererSnapshot");
    assertKeys(value, [
        "from",
        "reason",
        "readySent",
        "listeners",
        "directHandle",
        "install",
        "readyState",
        "bodyChildren",
        "contentChildren",
        "vendors",
        "errors",
    ], "rendererSnapshot");

    const output = {
        from: requireEnum(value.from, new Set(["renderer"]), "rendererSnapshot.from"),
        reason: requirePattern(value.reason, REASON_PATTERN, "rendererSnapshot.reason"),
    };
    copyBoolean(value, output, "readySent", "rendererSnapshot");
    copyInteger(value, output, "listeners", 0, 1000, "rendererSnapshot");
    copyEnum(value, output, "directHandle", DIRECT_HANDLES, "rendererSnapshot");
    copyObject(value, output, "install", validateInstall, "rendererSnapshot");
    copyEnum(value, output, "readyState", READY_STATES, "rendererSnapshot");
    copyInteger(value, output, "bodyChildren", -1, 100000, "rendererSnapshot");
    copyInteger(value, output, "contentChildren", -1, 100000, "rendererSnapshot");
    copyObject(value, output, "vendors", validateVendors, "rendererSnapshot");
    copyDiscardedStringArray(value, "errors", 8, 256, "rendererSnapshot");
    return output;
}

function validateBridge(input) {
    const value = requireObject(input, "bridge");
    assertKeys(value, ["version", "isReady", "install"], "bridge");
    const output = {};
    copyInteger(value, output, "version", 1, 100, "bridge");
    copyBoolean(value, output, "isReady", "bridge");
    copyObject(value, output, "install", validateInstall, "bridge");
    return output;
}

function validateInstall(input) {
    const value = requireObject(input, "install");
    assertKeys(value, [
        "strategy",
        "failures",
        "hadChrome",
        "hadWebview",
        "chromeProperty",
        "webviewProperty",
        "probeError",
    ], "install");
    const output = {};
    copyEnum(value, output, "strategy", INSTALL_STRATEGIES, "install");
    if ("failures" in value) {
        copyDiscardedStringArray(value, "failures", 4, 256, "install");
        output.failureCount = value.failures.length;
    }
    copyBoolean(value, output, "hadChrome", "install");
    copyBoolean(value, output, "hadWebview", "install");
    copyDiscardedString(value, "chromeProperty", 128, "install");
    copyDiscardedString(value, "webviewProperty", 128, "install");
    copyErrorPresence(value, output, "probeError", "install");
    return output;
}

function validateVendors(input) {
    const value = requireObject(input, "vendors");
    assertKeys(value, VENDOR_KEYS, "vendors");
    const output = {};
    for (const key of VENDOR_KEYS) copyEnum(value, output, key, JAVASCRIPT_TYPES, "vendors");
    return output;
}

function requireObject(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new DiagnosticValidationError(`${field} must be an object`);
    }
    return value;
}

function assertKeys(value, allowed, field) {
    const keys = new Set(allowed);
    for (const key of Object.keys(value)) {
        if (!keys.has(key)) {
            throw new DiagnosticValidationError(`${field}.${key} is not allowed`);
        }
    }
}

function requireEnum(value, allowed, field) {
    if (typeof value !== "string" || !allowed.has(value)) {
        throw new DiagnosticValidationError(`${field} has an invalid value`);
    }
    return value;
}

function requirePattern(value, pattern, field) {
    if (typeof value !== "string" || !pattern.test(value)) {
        throw new DiagnosticValidationError(`${field} has an invalid value`);
    }
    return value;
}

function copyDiscardedString(source, key, maxLength, prefix = "") {
    if (!(key in source)) return;
    const value = source[key];
    if (typeof value !== "string" || value.length > maxLength) {
        throw new DiagnosticValidationError(`${qualified(prefix, key)} must be a string of at most ${maxLength} characters`);
    }
}

function copyDiscardedStringArray(source, key, maxItems, maxLength, prefix = "") {
    if (!(key in source)) return;
    const value = source[key];
    if (!Array.isArray(value) || value.length > maxItems) {
        throw new DiagnosticValidationError(`${qualified(prefix, key)} must contain at most ${maxItems} items`);
    }
    for (const item of value) {
        if (typeof item !== "string" || item.length > maxLength) {
            throw new DiagnosticValidationError(`${qualified(prefix, key)} items must be strings of at most ${maxLength} characters`);
        }
    }
}

function copyErrorPresence(source, target, key, prefix = "") {
    if (!(key in source)) return;
    copyDiscardedString(source, key, 64, prefix);
    target[`${key}Present`] = true;
}

function copyBoolean(source, target, key, prefix = "") {
    if (!(key in source)) return;
    if (typeof source[key] !== "boolean") {
        throw new DiagnosticValidationError(`${qualified(prefix, key)} must be a boolean`);
    }
    target[key] = source[key];
}

function copyInteger(source, target, key, minimum, maximum, prefix = "") {
    if (!(key in source)) return;
    const value = source[key];
    if (!Number.isInteger(value) || value < minimum || value > maximum) {
        throw new DiagnosticValidationError(`${qualified(prefix, key)} must be an integer between ${minimum} and ${maximum}`);
    }
    target[key] = value;
}

function copyEnum(source, target, key, allowed, prefix = "") {
    if (!(key in source)) return;
    target[key] = requireEnum(source[key], allowed, qualified(prefix, key));
}

function copyObject(source, target, key, validator, prefix = "") {
    if (!(key in source)) return;
    target[key] = validator(source[key], qualified(prefix, key));
}

function copyNullableObject(source, target, key, validator) {
    if (!(key in source)) return;
    target[key] = source[key] === null ? null : validator(source[key]);
}

function qualified(prefix, key) {
    return prefix ? `${prefix}.${key}` : key;
}
