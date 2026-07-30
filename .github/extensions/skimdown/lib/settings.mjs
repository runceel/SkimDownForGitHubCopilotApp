/* User-global reader preferences.
 *
 * Persisted at $COPILOT_HOME/extensions/skimdown/artifacts/settings.json so the
 * reader feels the same in every session and every repository, which is what a
 * user expects from sidebar width / zoom / view mode.
 */

import { settingsFile, readJson, writeJsonAtomic, withStateLock } from "./paths.mjs";

const CONTENT_WIDTHS = ["760px", "960px", "1200px", "none"];
const SESSION_RETENTION_DAYS = [1, 7, 30];

const DEFAULTS = {
    sidebarVisible: true,
    sidebarWidth: 260,
    sidebarPosition: "left", // "left" | "right"
    viewMode: "tree", // "tree" | "recent"
    zoomFactor: 1,
    contentMaxWidth: "760px",
    lastSource: "session",
    persistSessionHistory: false,
    sessionRetentionDays: 7,
    sessionHistoryGeneration: 0,
    sessionHistoryClearGeneration: 0,
    sessionMemoryClearGeneration: 0,
    sessionDeletionGenerations: {},
    /** rootPath -> array of expanded directory relPaths */
    expanded: {},
};

let cache = null;

export function contentWidths() {
    return [...CONTENT_WIDTHS];
}

export function sessionRetentionDays() {
    return [...SESSION_RETENTION_DAYS];
}

export async function loadSettings({ fresh = false } = {}) {
    if (cache && !fresh) return cache;
    const stored = await readJson(settingsFile(), {});
    cache = normalize({ ...DEFAULTS, ...stored });
    return cache;
}

export async function updateSettings(patch) {
    const result = await updateSettingsWithPrevious(patch);
    return result.settings;
}

export async function updateSettingsWithPrevious(patch) {
    return mutateSettings((current) => {
        const next = normalize({ ...current, ...patch });
        const optedOut = current.persistSessionHistory && !next.persistSessionHistory;
        if (optedOut || current.sessionRetentionDays !== next.sessionRetentionDays) {
            next.sessionHistoryGeneration = current.sessionHistoryGeneration + 1;
        }
        if (optedOut) next.sessionHistoryClearGeneration = next.sessionHistoryGeneration;
        return next;
    });
}

export async function advanceSessionHistoryGeneration({ clearAll = false, sessionId } = {}) {
    const result = await mutateSettings((current) => {
        const generation = current.sessionHistoryGeneration + 1;
        const next = {
            ...current,
            sessionHistoryGeneration: generation,
        };
        if (clearAll) {
            next.sessionHistoryClearGeneration = generation;
            next.sessionMemoryClearGeneration = generation;
        }
        if (typeof sessionId === "string" && sessionId.length > 0) {
            next.sessionDeletionGenerations = {
                ...current.sessionDeletionGenerations,
                [sessionId]: generation,
            };
        }
        return next;
    });
    return result.settings;
}

async function mutateSettings(mutator) {
    return withStateLock(async () => {
        const stored = await readJson(settingsFile(), {});
        const current = normalize({ ...DEFAULTS, ...stored });
        cache = normalize(mutator(current));
        await writeJsonAtomic(settingsFile(), cache);
        return { previous: current, settings: cache };
    });
}

export async function setExpanded(rootPath, expandedRelPaths) {
    if (!rootPath) return loadSettings();
    const current = await loadSettings();
    const expanded = { ...current.expanded };
    const list = Array.isArray(expandedRelPaths)
        ? expandedRelPaths.filter((p) => typeof p === "string").slice(0, 500)
        : [];
    if (list.length === 0) {
        delete expanded[rootPath];
    } else {
        expanded[rootPath] = list;
    }
    return updateSettings({ expanded });
}

function normalize(value) {
    const out = { ...DEFAULTS, ...value };
    out.sidebarVisible = out.sidebarVisible !== false;
    out.sidebarWidth = clamp(toNumber(out.sidebarWidth, DEFAULTS.sidebarWidth), 160, 520);
    out.sidebarPosition = out.sidebarPosition === "right" ? "right" : "left";
    out.viewMode = out.viewMode === "recent" ? "recent" : "tree";
    out.zoomFactor = clamp(toNumber(out.zoomFactor, 1), 0.5, 3);
    out.contentMaxWidth = CONTENT_WIDTHS.includes(out.contentMaxWidth)
        ? out.contentMaxWidth
        : DEFAULTS.contentMaxWidth;
    out.lastSource = ["session", "workspace", "path"].includes(out.lastSource)
        ? out.lastSource
        : DEFAULTS.lastSource;
    out.persistSessionHistory = out.persistSessionHistory === true;
    out.sessionRetentionDays = SESSION_RETENTION_DAYS.includes(Number(out.sessionRetentionDays))
        ? Number(out.sessionRetentionDays)
        : DEFAULTS.sessionRetentionDays;
    out.sessionHistoryGeneration = Number.isSafeInteger(out.sessionHistoryGeneration)
        && out.sessionHistoryGeneration >= 0
        ? out.sessionHistoryGeneration
        : DEFAULTS.sessionHistoryGeneration;
    out.sessionHistoryClearGeneration = Number.isSafeInteger(out.sessionHistoryClearGeneration)
        && out.sessionHistoryClearGeneration >= 0
        ? out.sessionHistoryClearGeneration
        : DEFAULTS.sessionHistoryClearGeneration;
    out.sessionMemoryClearGeneration = Number.isSafeInteger(out.sessionMemoryClearGeneration)
        && out.sessionMemoryClearGeneration >= 0
        ? out.sessionMemoryClearGeneration
        : DEFAULTS.sessionMemoryClearGeneration;
    out.sessionDeletionGenerations = normalizeDeletionGenerations(out.sessionDeletionGenerations);
    out.expanded = out.expanded && typeof out.expanded === "object" ? out.expanded : {};
    return out;
}

function normalizeDeletionGenerations(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
        Object.entries(value).filter(([, generation]) =>
            Number.isSafeInteger(generation) && generation >= 0),
    );
}

function toNumber(value, fallback) {
    const n = typeof value === "number" ? value : Number.parseFloat(value);
    return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
}
