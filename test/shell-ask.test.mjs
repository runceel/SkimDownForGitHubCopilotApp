import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../.github/extensions/skimdown/web");
const RENDERER_ORIGIN = "http://127.0.0.1:47001";

function createShell({ doc } = {}) {
    const html = fs.readFileSync(path.join(webRoot, "shell.html"), "utf8");
    const dom = new JSDOM(html, {
        url: "http://127.0.0.1:47000/shell.html#token=test-token",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const listeners = new Map();
    const requests = [];
    const toRenderer = [];

    window.EventSource = class {
        addEventListener(type, listener) {
            const current = listeners.get(type) || [];
            current.push(listener);
            listeners.set(type, current);
        }
    };
    window.ResizeObserver = class {
        observe() {}
    };
    window.matchMedia = () => ({ matches: false, addEventListener() {} });
    window.fetch = async (url, init) => {
        requests.push({ url: String(url), init });
        return { ok: true, async json() { return { ok: true }; } };
    };
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.document.getElementById("preview-wrap").getBoundingClientRect = () => ({ width: 1200 });

    window.eval(fs.readFileSync(path.join(webRoot, "shell.js"), "utf8"));

    function emit(type, payload) {
        for (const listener of listeners.get(type) || []) listener({ data: JSON.stringify(payload) });
    }

    emit("state", {
        rendererBaseUri: `${RENDERER_ORIGIN}/`,
        settings: {
            sidebarVisible: true,
            sidebarPosition: "left",
            sidebarWidth: 260,
            viewMode: "tree",
            zoomFactor: 1,
            contentMaxWidth: "960px",
            persistSessionHistory: false,
            sessionRetentionDays: 7,
            tocVisible: true,
        },
        sources: [],
        listing: null,
    });
    emit("doc", doc || {
        title: "Guide.md",
        subtitle: "docs/Guide.md",
        markdown: "# Guide",
        sourcePath: "docs/Guide.md",
    });

    const preview = window.document.getElementById("preview");
    // The shell only accepts renderer traffic through the frame it created, so
    // messages have to arrive with that frame as their source.
    const frame = preview.contentWindow;
    frame.postMessage = (message) => toRenderer.push(message.payload);

    function fromRenderer(payload) {
        window.dispatchEvent(new window.MessageEvent("message", {
            data: { __skim: true, payload },
            origin: RENDERER_ORIGIN,
            source: frame,
        }));
    }

    fromRenderer({ type: "ready" });

    return {
        window,
        document: window.document,
        emit,
        fromRenderer,
        requests,
        toRenderer,
        askRequests() {
            return requests.filter((entry) => entry.url === "/api/ask");
        },
        close() {
            dom.window.close();
        },
    };
}

function flush() {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

test("the ask bar opens only on request and names what a question will carry", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    const askbar = shell.document.getElementById("askbar");
    const scope = shell.document.getElementById("ask-scope");

    // Nothing about arriving at a document opens the bar.
    assert.equal(askbar.hidden, true);

    shell.fromRenderer({ type: "shortcut", id: "ask" });
    assert.equal(askbar.hidden, false);
    assert.equal(scope.textContent, "Whole document · Guide.md");

    shell.fromRenderer({ type: "selection", empty: false, length: 42 });
    assert.equal(scope.textContent, "Selection · 42 characters");

    shell.fromRenderer({ type: "selection", empty: true, length: 0 });
    assert.equal(scope.textContent, "Whole document · Guide.md");
});

test("the ask bar refuses to send an empty question", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    const send = shell.document.getElementById("btn-ask-send");
    const input = shell.document.getElementById("ask-input");

    shell.document.getElementById("btn-ask").click();
    assert.equal(send.disabled, true);

    send.click();
    assert.equal(shell.askRequests().length, 0);

    input.value = "  ";
    input.dispatchEvent(new shell.window.Event("input"));
    assert.equal(send.disabled, true);

    input.value = "What does this mean?";
    input.dispatchEvent(new shell.window.Event("input"));
    assert.equal(send.disabled, false);
});

test("sending a question fetches the highlighted text once and names no file", async (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.document.getElementById("btn-ask").click();
    shell.fromRenderer({ type: "selection", empty: false, length: 9 });

    const input = shell.document.getElementById("ask-input");
    input.value = "Why this order?";
    input.dispatchEvent(new shell.window.Event("input"));
    shell.document.getElementById("btn-ask-send").click();

    // The body of a selection is only fetched at send time.
    await flush();
    assert.equal(shell.toRenderer.filter((m) => m.type === "selection/request").length, 1);
    assert.equal(shell.askRequests().length, 0);

    shell.fromRenderer({ type: "selection/value", text: "Read this." });
    await flush();

    const sent = shell.askRequests();
    assert.equal(sent.length, 1);
    const body = JSON.parse(sent[0].init.body);
    assert.deepEqual(body, {
        question: "Why this order?",
        scope: "selection",
        sectionTitle: "",
        quote: { text: "Read this." },
    });
    assert.equal(sent[0].init.headers["X-SkimDown-Capability"], "test-token");
    assert.doesNotMatch(sent[0].init.body, /Guide\.md/);

    // A delivered question closes the bar and clears the box.
    assert.equal(shell.document.getElementById("askbar").hidden, true);
    assert.equal(input.value, "");
});

test("a question about the whole document does not ask the renderer for text", async (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.document.getElementById("btn-ask").click();
    const input = shell.document.getElementById("ask-input");
    input.value = "Summarize this.";
    input.dispatchEvent(new shell.window.Event("input"));
    shell.document.getElementById("btn-ask-send").click();
    await flush();

    assert.equal(shell.toRenderer.filter((m) => m.type === "selection/request").length, 0);
    const body = JSON.parse(shell.askRequests()[0].init.body);
    assert.equal(body.scope, "document");
    assert.equal(body.quote, undefined);
});

test("selection messages outside the declared bounds are dropped", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.document.getElementById("btn-ask").click();
    const scope = shell.document.getElementById("ask-scope");

    shell.fromRenderer({ type: "selection", empty: false, length: 32769 });
    shell.fromRenderer({ type: "selection", empty: "no", length: 5 });
    shell.fromRenderer({ type: "selection", empty: false, length: Number.NaN });
    assert.equal(scope.textContent, "Whole document · Guide.md");

    shell.fromRenderer({ type: "selection", empty: false, length: 5 });
    assert.equal(scope.textContent, "Selection · 5 characters");
});

test("an oversized quote never reaches the question", async (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.document.getElementById("btn-ask").click();
    shell.fromRenderer({ type: "selection", empty: false, length: 9 });
    const input = shell.document.getElementById("ask-input");
    input.value = "What is this?";
    input.dispatchEvent(new shell.window.Event("input"));
    shell.document.getElementById("btn-ask-send").click();
    await flush();

    // Rejected by the allowlist, so the pending request is left to time out
    // rather than carrying an unbounded body.
    shell.fromRenderer({ type: "selection/value", text: "x".repeat(32769) });
    await flush();
    assert.equal(shell.askRequests().length, 0);

    shell.fromRenderer({ type: "selection/value", text: "x".repeat(32768) });
    await flush();
    const body = JSON.parse(shell.askRequests()[0].init.body);
    assert.equal(body.quote.text.length, 32768);
});

test("Escape closes the ask bar and a new document resets it", (t) => {    const shell = createShell();
    t.after(() => shell.close());

    const askbar = shell.document.getElementById("askbar");
    const input = shell.document.getElementById("ask-input");

    shell.document.getElementById("btn-ask").click();
    input.value = "Draft question";
    shell.window.dispatchEvent(new shell.window.KeyboardEvent("keydown", { key: "Escape" }));
    assert.equal(askbar.hidden, true);
    assert.equal(input.value, "");

    shell.document.getElementById("btn-ask").click();
    shell.fromRenderer({ type: "selection", empty: false, length: 12 });
    shell.emit("doc", {
        title: "Other.md",
        subtitle: "docs/Other.md",
        markdown: "# Other",
        sourcePath: "docs/Other.md",
    });
    assert.equal(askbar.hidden, true);

    shell.document.getElementById("btn-ask").click();
    assert.equal(shell.document.getElementById("ask-scope").textContent, "Whole document · Other.md");
});

test("a question is abandoned if the reader moves to another document first", async (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.document.getElementById("btn-ask").click();
    shell.fromRenderer({ type: "selection", empty: false, length: 9 });
    const input = shell.document.getElementById("ask-input");
    input.value = "What is this?";
    input.dispatchEvent(new shell.window.Event("input"));
    shell.document.getElementById("btn-ask-send").click();
    await flush();

    shell.emit("doc", {
        title: "Other.md",
        subtitle: "docs/Other.md",
        markdown: "# Other",
        sourcePath: "docs/Other.md",
    });
    shell.fromRenderer({ type: "selection/value", text: "Read this." });
    await flush();

    assert.equal(shell.askRequests().length, 0);
    // The bar has to become usable again rather than staying stuck mid-send.
    shell.document.getElementById("btn-ask").click();
    input.value = "Ask again";
    input.dispatchEvent(new shell.window.Event("input"));
    assert.equal(shell.document.getElementById("btn-ask-send").disabled, false);
});
