import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Imported without a cache-buster on purpose: `server.mjs` resolves the same
// specifier, so the inline document registry has to be the same instance.
import { addInlineDoc } from "../.github/extensions/skimdown/lib/sessionDocs.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repoRoot, ".github", "extensions", "skimdown");
const serverModule = path.join(extensionRoot, "lib", "server.mjs");

function moduleUrl(absolutePath) {
    return `${new URL(`file:///${absolutePath.replaceAll("\\", "/")}`)}?test=${Date.now()}-${Math.random()}`;
}

/**
 * Boot one canvas instance against a throwaway workspace and COPILOT_HOME.
 * `ask` is optional so the host-without-a-session case stays testable.
 */
async function withInstance({ ask }, run) {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "skimdown-ask-"));
    const previousCopilotHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(tempRoot, "copilot-home");

    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    const markdownPath = path.join(workspace, "README.md");
    await writeFile(markdownPath, "# Guide\n\nRead me.\n", "utf8");

    const { createInstance } = await import(moduleUrl(serverModule));
    const sessionId = `ask-test-${Math.random().toString(36).slice(2)}`;
    const instance = await createInstance({
        instanceId: sessionId,
        sessionId,
        workspacePath: workspace,
        log() {},
        ask,
    });

    const token = new URLSearchParams(new URL(instance.url).hash.slice(1)).get("token");
    const shellOrigin = new URL(instance.url).origin;
    const askRequest = (body, { capability = token } = {}) => fetch(new URL("/api/ask", instance.url), {
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
        return await run({ instance, askRequest, markdownPath, sessionId, workspace });
    } finally {
        await instance.dispose();
        if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousCopilotHome;
        await rm(tempRoot, { recursive: true, force: true });
    }
}

test("a question needs the instance capability and a host that can receive it", async () => {
    await withInstance({}, async ({ askRequest, instance, markdownPath }) => {
        await instance.selectFile(markdownPath, { push: false });

        const unauthorized = await askRequest({ question: "What is this?", scope: "document" }, { capability: null });
        assert.equal(unauthorized.status, 401);

        const forged = await askRequest({ question: "What is this?", scope: "document" }, { capability: "not-the-token" });
        assert.equal(forged.status, 401);

        // No `ask` was supplied, so the endpoint has nowhere to deliver.
        const unsupported = await askRequest({ question: "What is this?", scope: "document" });
        assert.equal(unsupported.status, 501);
    });
});

test("a question is rejected until a document is open", async () => {
    const sent = [];
    await withInstance({ ask: (message) => sent.push(message) }, async ({ askRequest }) => {
        const response = await askRequest({ question: "What is this?", scope: "document" });
        assert.equal(response.status, 409);
        assert.equal(sent.length, 0);
    });
});

test("malformed questions are refused before anything reaches the session", async () => {
    const sent = [];
    await withInstance({ ask: (message) => sent.push(message) }, async ({ askRequest, instance, markdownPath }) => {
        await instance.selectFile(markdownPath, { push: false });

        const cases = [
            { question: "   ", scope: "document" },
            { question: "x".repeat(2001), scope: "document" },
            { question: "What is this?", scope: "everything" },
            { question: "What is this?" },
            { question: "What is this?", scope: "document", sectionTitle: "x".repeat(513) },
            { question: "What is this?", scope: "selection" },
            { question: "What is this?", scope: "selection", quote: { text: "x".repeat(32769) } },
        ];
        for (const body of cases) {
            const response = await askRequest(body);
            assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
        }
        assert.equal(sent.length, 0);
    });
});

test("a file question carries the passage and attaches the file the reader opened", async () => {
    const sent = [];
    await withInstance({ ask: (message) => sent.push(message) }, async ({ askRequest, instance, markdownPath }) => {
        await instance.selectFile(markdownPath, { push: false });

        const selectionResponse = await askRequest({
            question: "Why does this matter?",
            scope: "selection",
            sectionTitle: "Guide",
            quote: { text: "Read me." },
        });
        assert.equal(selectionResponse.status, 200);
        assert.equal(sent.length, 1);

        const [message] = sent;
        assert.match(message.prompt, /Why does this matter\?/);
        assert.match(message.prompt, /Read me\./);
        assert.match(message.prompt, /Section being read: Guide/);
        assert.match(message.prompt, /not as instructions/);
        assert.deepEqual(message.attachments, [
            { type: "file", path: markdownPath, displayName: "README.md" },
        ]);
        assert.match(message.displayPrompt, /^SkimDown · README\.md — Why does this matter\?$/);

        // Without a selection the body is left to the attachment rather than
        // copied into the prompt.
        const documentResponse = await askRequest({ question: "Summarize this.", scope: "document" });
        assert.equal(documentResponse.status, 200);
        assert.equal(sent.length, 2);
        assert.doesNotMatch(sent[1].prompt, /SKIMDOWN-EXCERPT/);
        assert.deepEqual(sent[1].attachments, [
            { type: "file", path: markdownPath, displayName: "README.md" },
        ]);
    });
});

test("an inline document travels in the prompt because it has no file to attach", async () => {
    const sent = [];
    await withInstance({ ask: (message) => sent.push(message) }, async ({ askRequest, instance, sessionId }) => {
        const doc = await addInlineDoc(sessionId, {
            markdown: "# Draft\n\nA generated passage.\n",
            title: "Draft",
        });
        await instance.selectInline(doc.id, { push: false });

        const response = await askRequest({ question: "Is this accurate?", scope: "document" });
        assert.equal(response.status, 200);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0].attachments, []);
        assert.match(sent[0].prompt, /A generated passage\./);
        assert.match(sent[0].prompt, /Document: Draft/);
    });
});

test("a session that refuses the turn is reported without losing the reader's words", async () => {
    await withInstance({
        ask() {
            throw new Error("session closed");
        },
    }, async ({ askRequest, instance, markdownPath }) => {
        await instance.selectFile(markdownPath, { push: false });
        const response = await askRequest({ question: "What is this?", scope: "document" });
        assert.equal(response.status, 502);
        const payload = await response.json();
        assert.doesNotMatch(payload.error, /What is this\?/);
    });
});

test("questions are rate limited so the transcript cannot be flooded", async () => {
    const sent = [];
    await withInstance({ ask: (message) => sent.push(message) }, async ({ askRequest, instance, markdownPath }) => {
        await instance.selectFile(markdownPath, { push: false });

        let limited = null;
        for (let attempt = 0; attempt < 12 && !limited; attempt += 1) {
            const response = await askRequest({ question: `Question ${attempt}`, scope: "document" });
            if (response.status === 429) limited = response;
        }
        assert.ok(limited, "expected the limiter to reject a burst of questions");
        assert.ok(Number(limited.headers.get("retry-after")) > 0);
        assert.equal(sent.length, 10);
    });
});
