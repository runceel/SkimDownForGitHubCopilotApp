import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const copilotHome = await fs.mkdtemp(path.join(os.tmpdir(), "skimdown-privacy-"));
process.env.COPILOT_HOME = copilotHome;

const {
    addInlineDoc,
    cleanupExpiredSessionHistory,
    clearAllSessionHistory,
    clearSessionHistory,
    getInlineDoc,
    loadRegistry,
    updateSessionPrivacySettings,
} = await import("../lib/sessionDocs.mjs");
const {
    sessionStateDir,
    sessionStateFile,
    settingsFile,
    writeJsonAtomic,
} = await import("../lib/paths.mjs");
const { loadSettings, updateSettings } = await import("../lib/settings.mjs");

after(async () => {
    await fs.rm(copilotHome, { recursive: true, force: true });
});

test("session Markdown stays memory-only by default", async () => {
    const sessionId = "default-opt-out";
    await addInlineDoc(sessionId, { markdown: "# Private", title: "Private" });

    assert.equal((await getInlineDoc(sessionId, "inline-1")).markdown, "# Private");
    await assert.rejects(fs.stat(sessionStateFile(sessionId)), { code: "ENOENT" });
});

test("opt-in persistence writes an expiring registry", async () => {
    const sessionId = "opt-in";
    await updateSettings({ persistSessionHistory: true, sessionRetentionDays: 7 });
    await loadRegistry(sessionId);
    await addInlineDoc(sessionId, { id: "saved", markdown: "# Saved" });

    const stored = JSON.parse(await fs.readFile(sessionStateFile(sessionId), "utf8"));
    assert.equal(stored.schemaVersion, 2);
    assert.equal(stored.historyGeneration, 0);
    assert.equal(stored.inlineDocs[0].markdown, "# Saved");
    assert.equal(stored.expiresAt, stored.persistedAt + 7 * 24 * 60 * 60 * 1000);
});

test("cached registries still expire in a long-running process", async () => {
    const sessionId = "cached-expiry";
    const now = Date.now();
    await loadRegistry(sessionId);
    await addInlineDoc(sessionId, { id: "short-lived", markdown: "# Short lived" });

    const registry = await loadRegistry(sessionId, { now: now + 8 * 24 * 60 * 60 * 1000 });

    assert.deepEqual(registry.inlineDocs, []);
    await assert.rejects(fs.stat(sessionStateFile(sessionId)), { code: "ENOENT" });
});

test("shorter retention expires peer caches under the current policy", async () => {
    const sessionId = "shortened-retention";
    const oldPersistedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const peer = await import(new URL("../lib/sessionDocs.mjs?peer=short-retention", import.meta.url));
    const updater = await import(new URL("../lib/sessionDocs.mjs?updater=short-retention", import.meta.url));
    await updateSessionPrivacySettings(sessionId, {
        persistSessionHistory: true,
        sessionRetentionDays: 30,
    });
    const settings = await loadSettings({ fresh: true });
    const oldRegistry = registryAt(
        oldPersistedAt,
        settings.sessionHistoryGeneration,
        sessionId,
        30,
    );
    oldRegistry.inlineDocs = [{
        id: "old",
        title: "Old",
        markdown: "# Old",
        createdAt: oldPersistedAt,
        updatedAt: oldPersistedAt,
    }];
    await writeJsonAtomic(sessionStateFile(sessionId), oldRegistry);
    assert.equal((await peer.loadRegistry(sessionId)).inlineDocs[0].id, "old");

    await updater.updateSessionPrivacySettings(sessionId, { sessionRetentionDays: 1 });

    assert.deepEqual((await peer.loadRegistry(sessionId)).inlineDocs, []);
    await assert.rejects(fs.stat(sessionStateFile(sessionId)), { code: "ENOENT" });
});

test("shorter retention does not re-persist the updater's expired cache", async () => {
    const sessionId = "shortened-retention-owner";
    const oldPersistedAt = Date.now() - 2 * 24 * 60 * 60 * 1000;
    const actor = await import(new URL("../lib/sessionDocs.mjs?actor=short-retention", import.meta.url));
    await actor.updateSessionPrivacySettings(sessionId, {
        persistSessionHistory: true,
        sessionRetentionDays: 30,
    });
    const settings = await loadSettings({ fresh: true });
    const oldRegistry = registryAt(
        oldPersistedAt,
        settings.sessionHistoryGeneration,
        sessionId,
        30,
    );
    oldRegistry.inlineDocs = [{
        id: "old",
        title: "Old",
        markdown: "# Old",
        createdAt: oldPersistedAt,
        updatedAt: oldPersistedAt,
    }];
    await writeJsonAtomic(sessionStateFile(sessionId), oldRegistry);
    assert.equal((await actor.loadRegistry(sessionId)).inlineDocs[0].id, "old");

    await actor.updateSessionPrivacySettings(sessionId, { sessionRetentionDays: 1 });

    assert.equal(await actor.getInlineDoc(sessionId, "old"), null);
    await assert.rejects(fs.stat(sessionStateFile(sessionId)), { code: "ENOENT" });
});

test("cleanup removes legacy and expired registries", async () => {
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    await updateSessionPrivacySettings("cleanup-policy", { sessionRetentionDays: 7 });
    const legacyFile = sessionStateFile("legacy");
    const expiredFile = sessionStateFile("expired");
    const retainedFile = sessionStateFile("retained");
    const orphanedTemporaryFile = `${sessionStateFile("orphaned")}.999.tmp`;

    await writeJsonAtomic(legacyFile, { inlineDocs: [{ id: "legacy", markdown: "secret" }] });
    await writeJsonAtomic(expiredFile, registryAt(now - 8 * day, 0, "expired"));
    await writeJsonAtomic(retainedFile, registryAt(now - day, 0, "retained"));
    await fs.writeFile(
        orphanedTemporaryFile,
        JSON.stringify(registryAt(now, 0, "orphaned")),
        "utf8",
    );

    const result = await cleanupExpiredSessionHistory({ now, force: true });

    assert.ok(result.deleted >= 3);
    await assert.rejects(fs.stat(legacyFile), { code: "ENOENT" });
    await assert.rejects(fs.stat(expiredFile), { code: "ENOENT" });
    await assert.rejects(fs.stat(orphanedTemporaryFile), { code: "ENOENT" });
    assert.equal((await fs.stat(retainedFile)).isFile(), true);
});

test("opting out deletes disk history but preserves the live document", async () => {
    const sessionId = "disable-persistence";
    await loadRegistry(sessionId);
    await addInlineDoc(sessionId, { id: "live", markdown: "# Live" });
    assert.equal((await fs.stat(sessionStateFile(sessionId))).isFile(), true);

    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: false });

    await assert.rejects(fs.stat(sessionStateFile(sessionId)), { code: "ENOENT" });
    assert.equal((await getInlineDoc(sessionId, "live")).markdown, "# Live");
});

test("first opt-in persists existing memory-only history", async () => {
    const sessionId = "first-opt-in";
    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: false });
    await addInlineDoc(sessionId, { id: "live", markdown: "# Live" });

    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: true });

    assert.equal((await getInlineDoc(sessionId, "live")).markdown, "# Live");
    const stored = JSON.parse(await fs.readFile(sessionStateFile(sessionId), "utf8"));
    assert.equal(stored.inlineDocs[0].id, "live");
});

test("opt-in from another process preserves memory-only history", async () => {
    const sessionId = "peer-opt-in";
    const peer = await import(new URL("../lib/sessionDocs.mjs?peer=opt-in", import.meta.url));
    const updater = await import(new URL("../lib/sessionDocs.mjs?updater=opt-in", import.meta.url));
    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: false });
    await peer.addInlineDoc(sessionId, { id: "live", markdown: "# Live" });

    await updater.updateSessionPrivacySettings("different-session", {
        persistSessionHistory: true,
    });
    await peer.addInlineDoc(sessionId, { id: "after-opt-in", markdown: "# After" });

    const stored = JSON.parse(await fs.readFile(sessionStateFile(sessionId), "utf8"));
    assert.deepEqual(
        stored.inlineDocs.map((doc) => doc.id).sort(),
        ["after-opt-in", "live"],
    );
});

test("re-enabling persistence does not restore pre-opt-out history", async () => {
    const sessionId = "opt-out-reenable";
    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: true });
    await loadRegistry(sessionId);
    await addInlineDoc(sessionId, { id: "erased", markdown: "# Erased" });

    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: false });
    assert.equal((await getInlineDoc(sessionId, "erased")).markdown, "# Erased");
    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: true });

    assert.equal(await getInlineDoc(sessionId, "erased"), null);
});

test("an unrelated settings update cannot restore a stale persistence opt-in", async () => {
    const current = await loadSettings({ fresh: true });
    await writeJsonAtomic(settingsFile(), {
        ...current,
        persistSessionHistory: false,
        sessionHistoryGeneration: current.sessionHistoryGeneration + 1,
    });

    const updated = await updateSettings({ sidebarWidth: 321 });

    assert.equal(updated.persistSessionHistory, false);
    assert.equal(updated.sidebarWidth, 321);
});

test("table of contents visibility defaults on and persists explicit changes", async () => {
    const normalized = await updateSettings({ tocVisible: "false" });
    assert.equal(normalized.tocVisible, true);

    const hidden = await updateSettings({ tocVisible: false });
    assert.equal(hidden.tocVisible, false);
    assert.equal((await loadSettings({ fresh: true })).tocVisible, false);

    const visible = await updateSettings({ tocVisible: true });
    assert.equal(visible.tocVisible, true);
});

test("current-session deletion fences stale caches in another process", async () => {
    const sessionId = "shared-session";
    const peer = await import(new URL("../lib/sessionDocs.mjs?peer=shared-session", import.meta.url));
    await updateSettings({ persistSessionHistory: true });
    await loadRegistry(sessionId);
    await addInlineDoc(sessionId, { id: "old", markdown: "# Old" });
    assert.equal((await peer.loadRegistry(sessionId)).inlineDocs[0].id, "old");

    await clearSessionHistory(sessionId);
    await peer.addInlineDoc(sessionId, { id: "new", markdown: "# New" });

    const stored = JSON.parse(await fs.readFile(sessionStateFile(sessionId), "utf8"));
    assert.deepEqual(stored.inlineDocs.map((doc) => doc.id), ["new"]);
});

test("deleting another session preserves memory-only live history", async () => {
    const liveSession = "unrelated-live";
    const deletedSession = "unrelated-delete";
    const peer = await import(new URL("../lib/sessionDocs.mjs?peer=unrelated-live", import.meta.url));
    await updateSessionPrivacySettings(deletedSession, { persistSessionHistory: false });
    await peer.addInlineDoc(liveSession, { id: "live", markdown: "# Still live" });

    await clearSessionHistory(deletedSession);

    assert.equal((await peer.getInlineDoc(liveSession, "live")).markdown, "# Still live");
});

test("a crash residue cannot bypass the current-session deletion tombstone", async () => {
    const sessionId = "crash-after-clear";
    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: true });
    await loadRegistry(sessionId);
    await addInlineDoc(sessionId, { id: "deleted", markdown: "# Deleted" });
    const stale = await fs.readFile(sessionStateFile(sessionId), "utf8");

    await clearSessionHistory(sessionId);
    await fs.writeFile(sessionStateFile(sessionId), stale, "utf8");

    assert.deepEqual((await loadRegistry(sessionId, { fresh: true })).inlineDocs, []);
    await assert.rejects(fs.stat(sessionStateFile(sessionId)), { code: "ENOENT" });
});

test("concurrent registry mutations merge instead of overwriting", async () => {
    const sessionId = "concurrent-mutations";
    const peer = await import(new URL("../lib/sessionDocs.mjs?peer=concurrent-mutations", import.meta.url));
    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: true });

    await Promise.all([
        addInlineDoc(sessionId, { id: "first", markdown: "# First" }),
        peer.addInlineDoc(sessionId, { id: "second", markdown: "# Second" }),
    ]);

    const stored = JSON.parse(await fs.readFile(sessionStateFile(sessionId), "utf8"));
    assert.deepEqual(
        stored.inlineDocs.map((doc) => doc.id).sort(),
        ["first", "second"],
    );
});

test("preloaded stale caches reload persisted history before mutation", async () => {
    const sessionId = "preloaded-stale-caches";
    const first = await import(new URL("../lib/sessionDocs.mjs?first=preloaded", import.meta.url));
    const second = await import(new URL("../lib/sessionDocs.mjs?second=preloaded", import.meta.url));
    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: true });
    await Promise.all([first.loadRegistry(sessionId), second.loadRegistry(sessionId)]);

    await first.addInlineDoc(sessionId, { id: "first", markdown: "# First" });
    await second.addInlineDoc(sessionId, { id: "second", markdown: "# Second" });

    const stored = JSON.parse(await fs.readFile(sessionStateFile(sessionId), "utf8"));
    assert.deepEqual(
        stored.inlineDocs.map((doc) => doc.id).sort(),
        ["first", "second"],
    );
});

test("concurrent re-enable cannot resurrect data erased by opt-out", async () => {
    const sessionId = "concurrent-opt-out";
    const peer = await import(new URL("../lib/sessionDocs.mjs?peer=concurrent-opt-out", import.meta.url));
    await updateSessionPrivacySettings(sessionId, { persistSessionHistory: true });
    await loadRegistry(sessionId);
    await addInlineDoc(sessionId, { id: "private", markdown: "# Private" });
    await peer.loadRegistry(sessionId);

    await Promise.all([
        updateSessionPrivacySettings(sessionId, { persistSessionHistory: false }),
        peer.updateSessionPrivacySettings(sessionId, { persistSessionHistory: true }),
    ]);

    const stored = await fs.readFile(sessionStateFile(sessionId), "utf8").catch((error) => {
        if (error?.code === "ENOENT") return null;
        throw error;
    });
    const ids = stored ? JSON.parse(stored).inlineDocs.map((doc) => doc.id) : [];
    assert.equal(ids.includes("private"), false);
});

test("current and all-history deletion remove body and metadata", async () => {
    const current = "clear-current";
    await updateSettings({ persistSessionHistory: true });
    await loadRegistry(current);
    await addInlineDoc(current, { id: "delete-me", markdown: "# Delete me" });

    await clearSessionHistory(current);
    assert.deepEqual(await loadRegistry(current), {
        inlineDocs: [],
        touchedFiles: [],
        lastSelection: null,
        lastRoot: null,
    });
    await assert.rejects(fs.stat(sessionStateFile(current)), { code: "ENOENT" });

    const settings = await loadSettings({ fresh: true });
    await writeJsonAtomic(
        sessionStateFile("other"),
        registryAt(Date.now(), settings.sessionHistoryGeneration, "other"),
    );
    assert.ok(await clearAllSessionHistory() >= 1);
    assert.deepEqual(await fs.readdir(sessionStateDir()), []);
});

test("per-session deletion tombstones are not evicted", async () => {
    const tombstones = Object.fromEntries(
        Array.from({ length: 501 }, (_, index) => [`session-${index}`, index + 1]),
    );

    const settings = await updateSettings({ sessionDeletionGenerations: tombstones });

    assert.equal(Object.keys(settings.sessionDeletionGenerations).length, 501);
    assert.equal(settings.sessionDeletionGenerations["session-0"], 1);
});

function registryAt(persistedAt, historyGeneration, sessionId, retentionDays = 7) {
    return {
        schemaVersion: 2,
        sessionId,
        historyGeneration,
        persistedAt,
        expiresAt: persistedAt + retentionDays * 24 * 60 * 60 * 1000,
        inlineDocs: [],
        touchedFiles: [],
        lastSelection: null,
        lastRoot: null,
    };
}
