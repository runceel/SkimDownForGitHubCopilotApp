/* User-global reader preferences.
 *
 * Persisted at $COPILOT_HOME/extensions/skimdown/artifacts/settings.json so the
 * reader feels the same in every session and every repository, which is what a
 * user expects from sidebar width / zoom / view mode.
 */

import { settingsFile, readJson, writeJsonAtomic } from "./paths.mjs";

const CONTENT_WIDTHS = ["760px", "960px", "1200px", "none"];

const DEFAULTS = {
    sidebarVisible: true,
    sidebarWidth: 260,
    sidebarPosition: "left", // "left" | "right"
    viewMode: "tree", // "tree" | "recent"
    zoomFactor: 1,
    contentMaxWidth: "760px",
    lastSource: "session",
    /** rootPath -> array of expanded directory relPaths */
    expanded: {},
};

let cache = null;
let writeChain = Promise.resolve();

export function contentWidths() {
    return [...CONTENT_WIDTHS];
}

export async function loadSettings() {
    if (cache) return cache;
    const stored = await readJson(settingsFile(), {});
    cache = normalize({ ...DEFAULTS, ...stored });
    return cache;
}

export async function updateSettings(patch) {
    const current = await loadSettings();
    cache = normalize({ ...current, ...patch });
    const snapshot = cache;
    // Serialize writes so rapid UI changes cannot interleave and lose updates.
    writeChain = writeChain.then(() => writeJsonAtomic(settingsFile(), snapshot)).catch(() => {});
    await writeChain;
    return cache;
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
    out.expanded = out.expanded && typeof out.expanded === "object" ? out.expanded : {};
    return out;
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
