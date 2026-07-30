/* Registry of "Markdown produced during this session".
 *
 * Three feeds land here:
 *   1. Files the agent wrote this session, recorded by the `onPostToolUse` hook.
 *   2. Inline Markdown pushed straight into the canvas via the `show_markdown`
 *      action (no file on disk).
 *   3. The host's own session artifacts (plan.md, files/**) — those are not
 *      stored here, they are discovered live by `sources.mjs`.
 *
 * State is keyed by sessionId and stored under $COPILOT_HOME rather than the
 * workspace, because the workspace is the user's git worktree.
 */

import { EventEmitter } from "node:events";
import path from "node:path";
import { sessionStateFile, readJson, writeJsonAtomic } from "./paths.mjs";

const MAX_INLINE_DOCS = 50;
const MAX_TOUCHED_FILES = 300;
const MAX_INLINE_BYTES = 2 * 1024 * 1024;

export const registryEvents = new EventEmitter();

const DEFAULTS = {
    inlineDocs: [],
    touchedFiles: [],
    lastSelection: null,
    lastRoot: null,
};

let cache = null;
let cacheKey = null;
let writeChain = Promise.resolve();
let inlineCounter = 0;

export async function loadRegistry(sessionId) {
    if (cache && cacheKey === sessionId) return cache;
    const stored = await readJson(sessionStateFile(sessionId), {});
    cache = normalize({ ...DEFAULTS, ...stored });
    cacheKey = sessionId;
    inlineCounter = Math.max(inlineCounter, cache.inlineDocs.length);
    return cache;
}

async function persist(sessionId, next) {
    cache = next;
    cacheKey = sessionId;
    writeChain = writeChain
        .then(() => writeJsonAtomic(sessionStateFile(sessionId), next))
        .catch(() => {});
    await writeChain;
    registryEvents.emit("changed", sessionId);
    return cache;
}

/** Store (or replace) an inline document and return it. */
export async function addInlineDoc(sessionId, { markdown, title, id }) {
    const current = await loadRegistry(sessionId);
    const text = typeof markdown === "string" ? markdown.slice(0, MAX_INLINE_BYTES) : "";
    const now = Date.now();

    const docId = normalizeInlineId(id) || `inline-${++inlineCounter}`;
    const cleanTitle =
        typeof title === "string" && title.trim().length > 0
            ? title.trim().slice(0, 200)
            : deriveTitle(text) || `Markdown ${docId}`;

    const existingIndex = current.inlineDocs.findIndex((doc) => doc.id === docId);
    const doc = {
        id: docId,
        title: cleanTitle,
        markdown: text,
        createdAt: existingIndex >= 0 ? current.inlineDocs[existingIndex].createdAt : now,
        updatedAt: now,
    };

    const inlineDocs = [...current.inlineDocs];
    if (existingIndex >= 0) inlineDocs.splice(existingIndex, 1);
    inlineDocs.unshift(doc);

    await persist(sessionId, {
        ...current,
        inlineDocs: inlineDocs.slice(0, MAX_INLINE_DOCS),
    });
    return doc;
}

export async function getInlineDoc(sessionId, id) {
    const current = await loadRegistry(sessionId);
    return current.inlineDocs.find((doc) => doc.id === id) || null;
}

/** Record a Markdown file the agent created or edited during this session. */
export async function recordTouchedFile(sessionId, absPath, toolName) {
    if (typeof absPath !== "string" || absPath.length === 0) return null;
    const resolved = path.resolve(absPath);
    const current = await loadRegistry(sessionId);

    const touchedFiles = current.touchedFiles.filter((entry) => entry.path !== resolved);
    touchedFiles.unshift({ path: resolved, at: Date.now(), tool: toolName || "" });

    await persist(sessionId, {
        ...current,
        touchedFiles: touchedFiles.slice(0, MAX_TOUCHED_FILES),
    });
    return resolved;
}

export async function rememberSelection(sessionId, selection, root) {
    const current = await loadRegistry(sessionId);
    await persist(sessionId, {
        ...current,
        lastSelection: selection || null,
        lastRoot: typeof root === "string" ? root : current.lastRoot,
    });
}

function normalizeInlineId(id) {
    if (typeof id !== "string") return null;
    const clean = id.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
    return clean.length > 0 ? clean : null;
}

function deriveTitle(markdown) {
    if (typeof markdown !== "string") return null;
    for (const line of markdown.split(/\r?\n/, 40)) {
        const heading = /^\s{0,3}#{1,6}\s+(.*\S)\s*$/.exec(line);
        if (heading) return heading[1].slice(0, 200);
    }
    const firstText = markdown.split(/\r?\n/).find((line) => line.trim().length > 0);
    return firstText ? firstText.trim().slice(0, 80) : null;
}

function normalize(value) {
    return {
        inlineDocs: Array.isArray(value.inlineDocs)
            ? value.inlineDocs.filter((doc) => doc && typeof doc.id === "string")
            : [],
        touchedFiles: Array.isArray(value.touchedFiles)
            ? value.touchedFiles.filter((entry) => entry && typeof entry.path === "string")
            : [],
        lastSelection: value.lastSelection && typeof value.lastSelection === "object"
            ? value.lastSelection
            : null,
        lastRoot: typeof value.lastRoot === "string" ? value.lastRoot : null,
    };
}
