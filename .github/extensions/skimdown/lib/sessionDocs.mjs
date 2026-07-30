/* Registry of "Markdown produced during this session".
 *
 * The live registry stays in memory. Disk persistence is user opt-in and every
 * persisted registry has an expiry. Legacy, corrupt, opted-out, and expired
 * registries are removed automatically from $COPILOT_HOME.
 */

import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import {
    sessionStateDir,
    sessionStateFile,
    readJson,
    writeJsonAtomic,
    withStateLock,
} from "./paths.mjs";
import {
    advanceSessionHistoryGeneration,
    loadSettings,
    updateSettingsWithPrevious,
} from "./settings.mjs";

const MAX_INLINE_DOCS = 50;
const MAX_TOUCHED_FILES = 300;
const MAX_INLINE_BYTES = 2 * 1024 * 1024;
const REGISTRY_SCHEMA_VERSION = 2;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const registryEvents = new EventEmitter();

let cache = null;
let cacheKey = null;
let inlineCounter = 0;
let lastCleanupAt = 0;
let cacheGeneration = 0;
let cacheMemoryGeneration = 0;
let cacheDiskGeneration = 0;
let cachePersistedAt = Number.POSITIVE_INFINITY;
let cacheExpiresAt = Number.POSITIVE_INFINITY;
let cacheCanPersist = true;
let cachePersistenceEnabled = false;

export async function loadRegistry(sessionId, { now = Date.now(), fresh = false } = {}) {
    return withStateLock(async () => {
        const settings = await loadSettings({ fresh: true });
        await cleanupExpiredSessionHistory({ now });
        const memoryGeneration = memoryClearGeneration(settings, sessionId);
        const diskGeneration = diskClearGeneration(settings, sessionId);

        if (cache && cacheKey === sessionId) {
            if (settings.persistSessionHistory && Number.isFinite(cachePersistedAt)) {
                cacheExpiresAt = cachePersistedAt + settings.sessionRetentionDays * DAY_MS;
            }
            if (
                cacheMemoryGeneration < memoryGeneration
                || (settings.persistSessionHistory && cacheExpiresAt <= now)
            ) {
                resetCache(
                    sessionId,
                    settings.sessionHistoryGeneration,
                    memoryGeneration,
                    diskGeneration,
                );
            } else if (settings.persistSessionHistory && !cachePersistenceEnabled) {
                if (cacheDiskGeneration < diskGeneration) {
                    resetCache(
                        sessionId,
                        settings.sessionHistoryGeneration,
                        memoryGeneration,
                        diskGeneration,
                    );
                } else {
                    const stored = await readJson(sessionStateFile(sessionId), null);
                    if (stored && isCurrentRegistry(stored, now, settings, sessionId)) {
                        cache = mergeRegistries(cache, normalize(stored));
                        cachePersistedAt = stored.persistedAt;
                        cacheExpiresAt = stored.expiresAt;
                    } else if (stored) {
                        await removeSessionFile(sessionId);
                    }
                    cacheGeneration = settings.sessionHistoryGeneration;
                    cacheDiskGeneration = diskGeneration;
                    cacheCanPersist = true;
                    cachePersistenceEnabled = true;
                    return cache;
                }
            } else if (!fresh || !settings.persistSessionHistory) {
                cacheGeneration = settings.sessionHistoryGeneration;
                cachePersistenceEnabled = settings.persistSessionHistory;
                if (!settings.persistSessionHistory) cacheCanPersist = false;
                return cache;
            } else {
                cachePersistenceEnabled = true;
            }
        }

        let stored = null;
        if (settings.persistSessionHistory) {
            stored = await readJson(sessionStateFile(sessionId), null);
            if (!isCurrentRegistry(stored, now, settings, sessionId)) {
                await removeSessionFile(sessionId);
                stored = null;
            }
        } else {
            await removeSessionFile(sessionId);
        }

        cache = normalize(stored || {});
        cacheKey = sessionId;
        inlineCounter = cache.inlineDocs.length;
        cacheGeneration = settings.sessionHistoryGeneration;
        cacheMemoryGeneration = memoryGeneration;
        cacheDiskGeneration = diskGeneration;
        cachePersistedAt = stored?.persistedAt ?? Number.POSITIVE_INFINITY;
        cacheExpiresAt = stored?.expiresAt ?? Number.POSITIVE_INFINITY;
        cacheCanPersist = true;
        cachePersistenceEnabled = settings.persistSessionHistory;
        return cache;
    });
}

async function persist(sessionId, next) {
    cache = next;
    cacheKey = sessionId;

    await withStateLock(async () => {
        const settings = await loadSettings({ fresh: true });
        if (
            cacheGeneration !== settings.sessionHistoryGeneration
            || cacheDiskGeneration < diskClearGeneration(settings, sessionId)
            || (settings.persistSessionHistory && !cacheCanPersist)
        ) {
            cacheGeneration = settings.sessionHistoryGeneration;
            cacheCanPersist = false;
            return;
        }
        if (!settings.persistSessionHistory) {
            cachePersistedAt = Number.POSITIVE_INFINITY;
            cacheExpiresAt = Number.POSITIVE_INFINITY;
            cachePersistenceEnabled = false;
            await removeSessionFile(sessionId);
            return;
        }

        const stored = persistedRegistry(
            next,
            sessionId,
            settings.sessionRetentionDays,
            settings.sessionHistoryGeneration,
        );
        cacheExpiresAt = stored.expiresAt;
        cachePersistedAt = stored.persistedAt;
        cachePersistenceEnabled = true;
        await writeJsonAtomic(sessionStateFile(sessionId), stored);
    });
    registryEvents.emit("changed", sessionId, { kind: "updated" });
    return cache;
}

/** Store (or replace) an inline document and return it. */
export async function addInlineDoc(sessionId, { markdown, title, id }) {
    return withStateLock(async () => {
        const current = await loadRegistry(sessionId, { fresh: true });
        const text = typeof markdown === "string" ? markdown.slice(0, MAX_INLINE_BYTES) : "";
        const now = Date.now();

        const docId = normalizeInlineId(id) || nextInlineId(current);
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
    });
}

export async function getInlineDoc(sessionId, id) {
    const current = await loadRegistry(sessionId);
    return current.inlineDocs.find((doc) => doc.id === id) || null;
}

/** Record a Markdown file the agent created or edited during this session. */
export async function recordTouchedFile(sessionId, absPath, toolName) {
    if (typeof absPath !== "string" || absPath.length === 0) return null;
    const resolved = path.resolve(absPath);
    return withStateLock(async () => {
        const current = await loadRegistry(sessionId, { fresh: true });
        const touchedFiles = current.touchedFiles.filter((entry) => entry.path !== resolved);
        touchedFiles.unshift({ path: resolved, at: Date.now(), tool: toolName || "" });

        await persist(sessionId, {
            ...current,
            touchedFiles: touchedFiles.slice(0, MAX_TOUCHED_FILES),
        });
        return resolved;
    });
}

export async function rememberSelection(sessionId, selection, root) {
    return withStateLock(async () => {
        const current = await loadRegistry(sessionId, { fresh: true });
        await persist(sessionId, {
            ...current,
            lastSelection: selection || null,
            lastRoot: typeof root === "string" ? root : current.lastRoot,
        });
    });
}

/** Delete the current session's body and metadata from memory and disk. */
export async function clearSessionHistory(sessionId) {
    await withStateLock(async () => {
        const settings = await advanceSessionHistoryGeneration({ sessionId });
        await removeSessionFile(sessionId);
        if (cacheKey === sessionId) {
            resetCache(
                sessionId,
                settings.sessionHistoryGeneration,
                memoryClearGeneration(settings, sessionId),
                diskClearGeneration(settings, sessionId),
            );
        }
    });
    registryEvents.emit("changed", sessionId, { kind: "cleared", scope: "current" });
}

/** Delete every persisted session registry, including registries from other sessions. */
export async function clearAllSessionHistory() {
    const changedSessionId = cacheKey;
    const deleted = await withStateLock(async () => {
        const settings = await advanceSessionHistoryGeneration({ clearAll: true });
        const count = await removeAllSessionFiles();
        resetCache(
            cacheKey,
            settings.sessionHistoryGeneration,
            memoryClearGeneration(settings, cacheKey),
            diskClearGeneration(settings, cacheKey),
        );
        return count;
    });
    if (changedSessionId) {
        registryEvents.emit("changed", changedSessionId, { kind: "cleared", scope: "all" });
    }
    return deleted;
}

/** Update privacy settings and apply their storage effects as one transaction. */
export async function updateSessionPrivacySettings(sessionId, patch) {
    return withStateLock(async () => {
        const result = await updateSettingsWithPrevious(patch);
        if (cacheKey === sessionId && cache) {
            const memoryGeneration = memoryClearGeneration(result.settings, sessionId);
            const staleCache = cacheMemoryGeneration < memoryGeneration;
            const expiredUnderNewRetention =
                result.settings.persistSessionHistory
                && Number.isFinite(cachePersistedAt)
                && cachePersistedAt + result.settings.sessionRetentionDays * DAY_MS <= Date.now();
            const unsafeReenable =
                !result.previous.persistSessionHistory
                && result.settings.persistSessionHistory
                && cacheDiskGeneration < diskClearGeneration(result.previous, sessionId);
            if (staleCache || unsafeReenable || expiredUnderNewRetention) {
                resetCache(
                    sessionId,
                    result.settings.sessionHistoryGeneration,
                    memoryGeneration,
                    diskClearGeneration(result.settings, sessionId),
                );
                if (expiredUnderNewRetention) cacheCanPersist = false;
            } else {
                cacheGeneration = result.settings.sessionHistoryGeneration;
                cacheCanPersist = result.settings.persistSessionHistory;
                cachePersistenceEnabled = result.settings.persistSessionHistory;
            }
        }
        await applySessionRetentionPolicy(sessionId);
        return result.settings;
    });
}

/**
 * Apply changed privacy settings immediately. Opting out erases every disk
 * registry while preserving the current in-memory reading context.
 */
export async function applySessionRetentionPolicy(sessionId) {
    const settings = await loadSettings({ fresh: true });
    const cleanup = await cleanupExpiredSessionHistory({ force: true });
    if (!settings.persistSessionHistory) {
        if (cacheKey === sessionId) {
            cacheGeneration = settings.sessionHistoryGeneration;
            cachePersistedAt = Number.POSITIVE_INFINITY;
            cacheExpiresAt = Number.POSITIVE_INFINITY;
            cacheCanPersist = false;
            cachePersistenceEnabled = false;
        }
        return cleanup;
    }
    if (cacheKey !== sessionId || !cache) return cleanup;
    cacheGeneration = settings.sessionHistoryGeneration;
    await persist(sessionId, cache);
    return cleanup;
}

/** Remove opted-out, legacy, corrupt, and expired registries. */
export async function cleanupExpiredSessionHistory({ now = Date.now(), force = false } = {}) {
    if (!force && now - lastCleanupAt < CLEANUP_INTERVAL_MS) return { deleted: 0, retained: 0 };
    lastCleanupAt = now;

    return withStateLock(async () => {
        const settings = await loadSettings({ fresh: true });
        const files = await listSessionFiles();
        let deleted = 0;
        let retained = 0;

        for (const entry of files) {
            if (entry.temporary) {
                await removeFile(entry.path);
                deleted += 1;
                continue;
            }

            const stored = await readJson(entry.path, null);
            const expiry = expectedExpiry(stored, settings.sessionRetentionDays);
            if (
                !settings.persistSessionHistory
                || !isHistoryGenerationCurrent(stored, settings, stored?.sessionId)
                || !expiry
                || expiry <= now
            ) {
                await removeFile(entry.path);
                deleted += 1;
                continue;
            }

            if (stored.expiresAt !== expiry) {
                await writeJsonAtomic(entry.path, { ...stored, expiresAt: expiry });
            }
            retained += 1;
        }
        return { deleted, retained };
    });
}

function persistedRegistry(value, sessionId, retentionDays, historyGeneration) {
    const persistedAt = Date.now();
    return {
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        sessionId,
        historyGeneration,
        persistedAt,
        expiresAt: persistedAt + retentionDays * DAY_MS,
        ...normalize(value),
    };
}

function isCurrentRegistry(value, now, settings, sessionId) {
    const expiry = expectedExpiry(value, Number.POSITIVE_INFINITY);
    return Boolean(
        isHistoryGenerationCurrent(value, settings, sessionId)
        && expiry
        && expiry > now,
    );
}

function isHistoryGenerationCurrent(value, settings, sessionId) {
    if (!Number.isSafeInteger(value?.historyGeneration)) return false;
    const minimum = diskClearGeneration(settings, sessionId);
    return value.historyGeneration >= minimum;
}

function diskClearGeneration(settings, sessionId) {
    const sessionDeletion = typeof sessionId === "string"
        ? settings.sessionDeletionGenerations?.[sessionId] || 0
        : 0;
    return Math.max(settings.sessionHistoryClearGeneration || 0, sessionDeletion);
}

function memoryClearGeneration(settings, sessionId) {
    const sessionDeletion = typeof sessionId === "string"
        ? settings.sessionDeletionGenerations?.[sessionId] || 0
        : 0;
    return Math.max(settings.sessionMemoryClearGeneration || 0, sessionDeletion);
}

function expectedExpiry(value, retentionDays) {
    if (!value || value.schemaVersion !== REGISTRY_SCHEMA_VERSION) return null;
    if (!Number.isFinite(value.persistedAt)) return null;
    if (!Number.isFinite(retentionDays)) {
        return Number.isFinite(value.expiresAt) ? value.expiresAt : null;
    }
    return value.persistedAt + retentionDays * DAY_MS;
}

async function listSessionFiles() {
    let entries;
    try {
        entries = await fs.readdir(sessionStateDir(), { withFileTypes: true });
    } catch (error) {
        if (error?.code === "ENOENT") return [];
        throw error;
    }
    return entries
        .filter((entry) => entry.isFile() && /\.json(?:\.\d+\.tmp)?$/.test(entry.name))
        .map((entry) => ({
            path: path.join(sessionStateDir(), entry.name),
            temporary: entry.name.endsWith(".tmp"),
        }));
}

async function removeAllSessionFiles() {
    const entries = await listSessionFiles();
    await Promise.all(entries.map((entry) => removeFile(entry.path)));
    return entries.length;
}

async function removeSessionFile(sessionId) {
    await removeFile(sessionStateFile(sessionId));
}

async function removeFile(file) {
    try {
        await fs.unlink(file);
    } catch (error) {
        if (error?.code !== "ENOENT") throw error;
    }
}

function normalizeInlineId(id) {
    if (typeof id !== "string") return null;
    const clean = id.trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
    return clean.length > 0 ? clean : null;
}

function nextInlineId(current) {
    const ids = new Set(current.inlineDocs.map((doc) => doc.id));
    let id;
    do {
        id = `inline-${++inlineCounter}`;
    } while (ids.has(id));
    return id;
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

function createDefaultRegistry() {
    return {
        inlineDocs: [],
        touchedFiles: [],
        lastSelection: null,
        lastRoot: null,
    };
}

function resetCache(
    sessionId,
    historyGeneration,
    memoryGeneration = 0,
    diskGeneration = 0,
) {
    cache = createDefaultRegistry();
    cacheKey = sessionId;
    inlineCounter = 0;
    cacheGeneration = historyGeneration;
    cacheMemoryGeneration = memoryGeneration;
    cacheDiskGeneration = diskGeneration;
    cachePersistedAt = Number.POSITIVE_INFINITY;
    cacheExpiresAt = Number.POSITIVE_INFINITY;
    cacheCanPersist = true;
    cachePersistenceEnabled = false;
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

function mergeRegistries(memory, stored) {
    const inlineDocs = [...memory.inlineDocs];
    const inlineIds = new Set(inlineDocs.map((doc) => doc.id));
    inlineDocs.push(...stored.inlineDocs.filter((doc) => !inlineIds.has(doc.id)));

    const touchedFiles = [...memory.touchedFiles];
    const touchedPaths = new Set(touchedFiles.map((entry) => entry.path));
    touchedFiles.push(...stored.touchedFiles.filter((entry) => !touchedPaths.has(entry.path)));

    return {
        inlineDocs: inlineDocs
            .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
            .slice(0, MAX_INLINE_DOCS),
        touchedFiles: touchedFiles
            .sort((a, b) => (b.at || 0) - (a.at || 0))
            .slice(0, MAX_TOUCHED_FILES),
        lastSelection: memory.lastSelection || stored.lastSelection,
        lastRoot: memory.lastRoot || stored.lastRoot,
    };
}
