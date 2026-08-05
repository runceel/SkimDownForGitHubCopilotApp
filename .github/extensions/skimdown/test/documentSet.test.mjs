import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Imported without a cache-buster on purpose: `server.mjs` resolves the same
// specifier, so the session registry has to be the same instance.
import * as sessionDocs from "../lib/sessionDocs.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverModule = path.join(extensionRoot, "lib", "server.mjs");

function moduleUrl(absolutePath) {
    return `${new URL(`file:///${absolutePath.replaceAll("\\", "/")}`)}?test=${Date.now()}-${Math.random()}`;
}

/**
 * Boot one canvas instance against a throwaway workspace and COPILOT_HOME so
 * every test starts from an empty session registry.
 */
async function withInstance(run) {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "skimdown-set-"));
    const previousCopilotHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(tempRoot, "copilot-home");

    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    const write = async (relative, body) => {
        const target = path.join(workspace, relative);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, body, "utf8");
        return target;
    };

    const { createInstance } = await import(moduleUrl(serverModule));
    const sessionId = `set-test-${Math.random().toString(36).slice(2)}`;
    const instance = await createInstance({
        instanceId: sessionId,
        sessionId,
        workspacePath: workspace,
        log() {},
    });

    const token = new URLSearchParams(new URL(instance.url).hash.slice(1)).get("token");
    const shellOrigin = new URL(instance.url).origin;
    const stepRequest = (body, { capability = token } = {}) => fetch(new URL("/api/set/step", instance.url), {
        method: "POST",
        headers: {
            "Sec-Fetch-Site": "same-origin",
            "Origin": shellOrigin,
            "Content-Type": "application/json",
            ...(capability === null ? {} : { "X-SkimDown-Capability": capability }),
        },
        body: JSON.stringify(body),
    });

    try {
        return await run({ instance, sessionId, stepRequest, workspace, write });
    } finally {
        await instance.dispose();
        if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousCopilotHome;
        await rm(tempRoot, { recursive: true, force: true });
    }
}

/** Sidebar entries of the document set group, in reading order. */
function setGroup(state) {
    return (state.listing.groups || []).find((group) => group.id === "set") || null;
}

test("a document set leads the session sidebar in the order it was supplied", async () => {
    await withInstance(async ({ instance, write }) => {
        const guide = await write("docs/guide.md", "# Guide\n");

        const result = await instance.presentDocumentSet({
            title: "Review these",
            documents: [
                { markdown: "# Overview\n", title: "Overview", description: "Start here" },
                { path: guide, title: "Guide" },
                { markdown: "# Next steps\n", title: "Next steps" },
            ],
        });

        assert.equal(result.title, "Review these");
        assert.equal(result.count, 3);
        assert.deepEqual(result.skipped, []);
        assert.deepEqual(result.documents.map((doc) => doc.title), ["Overview", "Guide", "Next steps"]);

        const state = await instance.buildState();
        assert.equal(state.source, "session");
        assert.equal(state.listing.groups[0].id, "set");

        const group = setGroup(state);
        assert.equal(group.label, "Review these");
        // Timestamps would imply a recency order the reading order does not have.
        assert.equal(group.showTime, false);
        assert.deepEqual(group.entries.map((entry) => entry.name), ["Overview", "Guide", "Next steps"]);
        assert.deepEqual(group.entries.map((entry) => entry.type), ["inline", "file", "inline"]);
        assert.equal(group.entries[0].folder, "Start here");

        // Presenting a set opens its first document.
        assert.equal(state.selection.kind, "inline");
        assert.deepEqual(state.selection.set, { title: "Review these", index: 0, count: 3 });
    });
});

test("a new set replaces the previous one instead of stacking", async () => {
    await withInstance(async ({ instance, sessionId }) => {
        await instance.presentDocumentSet({
            title: "First round",
            documents: [
                { markdown: "# Old one\n", title: "Old one" },
                { markdown: "# Old two\n", title: "Old two" },
            ],
        });
        const firstIds = (await sessionDocs.getDocumentSet(sessionId)).items.map((item) => item.id);
        assert.equal(firstIds.length, 2);

        await instance.presentDocumentSet({
            title: "Second round",
            documents: [{ markdown: "# New\n", title: "New" }],
        });

        const docSet = await sessionDocs.getDocumentSet(sessionId);
        assert.equal(docSet.title, "Second round");
        assert.equal(docSet.items.length, 1);

        // Superseded bodies are gone, not merely unlisted: the reused slot holds
        // the new text and the surplus slot no longer resolves at all.
        assert.equal((await sessionDocs.getInlineDoc(sessionId, docSet.items[0].id)).markdown, "# New\n");
        for (const id of firstIds.filter((candidate) => candidate !== docSet.items[0].id)) {
            assert.equal(await sessionDocs.getInlineDoc(sessionId, id), null);
        }

        const state = await instance.buildState();
        const group = setGroup(state);
        assert.deepEqual(group.entries.map((entry) => entry.name), ["New"]);
        assert.equal(state.listing.groups.some((item) => item.id === "inline"), false);
    });
});

test("set members are not repeated in the other session groups", async () => {
    await withInstance(async ({ instance, sessionId, write }) => {
        const shared = await write("docs/shared.md", "# Shared\n");
        const other = await write("docs/other.md", "# Other\n");
        await sessionDocs.recordTouchedFile(sessionId, shared);
        await sessionDocs.recordTouchedFile(sessionId, other);
        await sessionDocs.addInlineDoc(sessionId, { id: "standalone", markdown: "# Standalone\n", title: "Standalone" });

        await instance.presentDocumentSet({
            documents: [{ path: shared }, { markdown: "# In set\n", title: "In set" }],
        });

        const state = await instance.buildState();
        const named = new Map(state.listing.groups.map((group) => [group.id, group.entries]));
        assert.deepEqual(named.get("set").map((entry) => entry.name), ["shared.md", "In set"]);
        // `shared.md` belongs to the set now, so only `other.md` stays behind.
        assert.deepEqual(named.get("touched").map((entry) => entry.name), ["other.md"]);
        assert.deepEqual(named.get("inline").map((entry) => entry.name), ["Standalone"]);
    });
});

test("unreadable members are reported without discarding the rest of the set", async () => {
    await withInstance(async ({ instance, workspace, write }) => {
        const good = await write("docs/good.md", "# Good\n");
        const notMarkdown = await write("docs/notes.txt", "plain text\n");
        const missing = path.join(workspace, "docs", "missing.md");

        const result = await instance.presentDocumentSet({
            documents: [{ path: missing }, { path: good }, { path: notMarkdown }],
        });

        assert.equal(result.count, 1);
        assert.deepEqual(result.documents.map((doc) => doc.title), ["good.md"]);
        assert.deepEqual(result.skipped.map((entry) => entry.reason), ["missing", "unsupported"]);

        const state = await instance.buildState();
        assert.deepEqual(setGroup(state).entries.map((entry) => entry.name), ["good.md"]);
    });
});

test("a set with nothing readable is refused rather than shown empty", async () => {
    await withInstance(async ({ instance, workspace }) => {
        await assert.rejects(
            instance.presentDocumentSet({ documents: [{ path: path.join(workspace, "nope.md") }] }),
            (error) => error.code === "invalid_request",
        );
        const state = await instance.buildState();
        assert.equal(setGroup(state), null);
    });
});

test("stepping walks the set from the extension's own listing and never wraps", async () => {
    await withInstance(async ({ instance, write }) => {
        const guide = await write("docs/guide.md", "# Guide\n");
        await instance.presentDocumentSet({
            title: "Three documents",
            documents: [
                { markdown: "# One\n", title: "One" },
                { path: guide, title: "Two" },
                { markdown: "# Three\n", title: "Three" },
            ],
        });

        assert.deepEqual(await instance.stepDocumentSet(-1), { moved: false });

        assert.deepEqual(await instance.stepDocumentSet(1), { moved: true, index: 1, count: 3 });
        let state = await instance.buildState();
        assert.equal(state.selection.kind, "file");
        assert.deepEqual(state.selection.set, { title: "Three documents", index: 1, count: 3 });

        assert.deepEqual(await instance.stepDocumentSet(1), { moved: true, index: 2, count: 3 });
        assert.deepEqual(await instance.stepDocumentSet(1), { moved: false });

        state = await instance.buildState();
        assert.equal(state.selection.set.index, 2);
    });
});

test("stepping outside the set re-enters it from the matching end", async () => {
    await withInstance(async ({ instance, sessionId }) => {
        await instance.presentDocumentSet({
            documents: [
                { markdown: "# One\n", title: "One" },
                { markdown: "# Two\n", title: "Two" },
            ],
        });
        await sessionDocs.addInlineDoc(sessionId, { id: "aside", markdown: "# Aside\n", title: "Aside" });
        await instance.showInline("aside");

        let state = await instance.buildState();
        assert.equal(state.selection.set.index, -1);

        assert.deepEqual(await instance.stepDocumentSet(-1), { moved: true, index: 1, count: 2 });
        state = await instance.buildState();
        assert.equal(state.selection.title, "Two");
    });
});

test("the step endpoint needs the instance capability", async () => {
    await withInstance(async ({ instance, stepRequest }) => {
        await instance.presentDocumentSet({
            documents: [
                { markdown: "# One\n", title: "One" },
                { markdown: "# Two\n", title: "Two" },
            ],
        });

        assert.equal((await stepRequest({ delta: 1 }, { capability: null })).status, 401);
        assert.equal((await stepRequest({ delta: 1 }, { capability: "not-the-token" })).status, 401);

        const moved = await (await stepRequest({ delta: 1 })).json();
        assert.deepEqual(moved, { ok: true, moved: true, index: 1, count: 2 });

        // Anything that is not a backwards step is a forward step.
        const clamped = await (await stepRequest({ delta: "nonsense" })).json();
        assert.equal(clamped.moved, false);
    });
});

test("clearing the session history removes the set as well", async () => {
    await withInstance(async ({ instance, sessionId, write }) => {
        await instance.presentDocumentSet({
            documents: [{ path: await write("docs/guide.md", "# Guide\n") }, { markdown: "# Inline\n" }],
        });

        await sessionDocs.clearSessionHistory(sessionId);
        assert.equal(await sessionDocs.getDocumentSet(sessionId), null);

        await instance.refreshListing();
        const state = await instance.buildState();
        assert.equal(setGroup(state), null);
        assert.equal(state.selection?.set, undefined);
    });
});
