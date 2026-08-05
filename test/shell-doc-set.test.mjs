import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../.github/extensions/skimdown/web");

const SETTINGS = {
    sidebarVisible: true,
    sidebarPosition: "left",
    sidebarWidth: 260,
    viewMode: "tree",
    zoomFactor: 1,
    contentMaxWidth: "960px",
    persistSessionHistory: false,
    sessionRetentionDays: 7,
    tocVisible: true,
};

/** Boot the shell against a mocked transport and record every API call. */
function createShell() {
    const html = fs.readFileSync(path.join(webRoot, "shell.html"), "utf8");
    const dom = new JSDOM(html, {
        url: "http://127.0.0.1:47000/shell.html#token=test-token",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const listeners = new Map();
    const calls = [];

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
        calls.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
        return { ok: true, async json() { return { ok: true }; } };
    };
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.document.getElementById("preview-wrap").getBoundingClientRect = () => ({ width: 900 });

    window.eval(fs.readFileSync(path.join(webRoot, "shell.js"), "utf8"));

    const emit = (type, payload) => {
        for (const listener of listeners.get(type) || []) listener({ data: JSON.stringify(payload) });
    };

    return {
        window,
        calls,
        stepCalls: () => calls.filter((call) => call.url === "/api/set/step"),
        /** Push a server state with an optional document set position. */
        showSet(set, listing) {
            emit("state", {
                rendererBaseUri: "http://127.0.0.1:47001/",
                settings: SETTINGS,
                sources: [],
                listing: listing || null,
                selection: set ? { kind: "inline", id: "set-1", title: "One", set } : null,
            });
        },
        keydown(key) {
            const event = new window.KeyboardEvent("keydown", { key, ctrlKey: true, bubbles: true, cancelable: true });
            window.document.body.dispatchEvent(event);
            return event;
        },
        close() {
            dom.window.close();
        },
    };
}

test("set navigation appears only while a document set is present", (t) => {
    const shell = createShell();
    t.after(() => shell.close());
    const nav = shell.window.document.getElementById("set-nav");

    shell.showSet(null);
    assert.equal(nav.hidden, true);

    shell.showSet({ title: "Review these", index: 0, count: 3 });
    assert.equal(nav.hidden, false);
    assert.equal(nav.title, "Review these");
    assert.equal(shell.window.document.getElementById("set-position").textContent, "1/3");

    shell.showSet(null);
    assert.equal(nav.hidden, true);
});

test("the counter and buttons follow the reading position without wrapping", (t) => {
    const shell = createShell();
    t.after(() => shell.close());
    const position = shell.window.document.getElementById("set-position");
    const prev = shell.window.document.getElementById("btn-set-prev");
    const next = shell.window.document.getElementById("btn-set-next");

    shell.showSet({ title: "Set", index: 0, count: 3 });
    assert.equal(position.textContent, "1/3");
    assert.equal(prev.disabled, true);
    assert.equal(next.disabled, false);

    shell.showSet({ title: "Set", index: 1, count: 3 });
    assert.equal(position.textContent, "2/3");
    assert.equal(prev.disabled, false);
    assert.equal(next.disabled, false);

    shell.showSet({ title: "Set", index: 2, count: 3 });
    assert.equal(position.textContent, "3/3");
    assert.equal(prev.disabled, false);
    assert.equal(next.disabled, true);
});

test("reading something outside the set keeps both directions available", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.showSet({ title: "Set", index: -1, count: 3 });

    assert.equal(shell.window.document.getElementById("set-position").textContent, "-/3");
    assert.equal(shell.window.document.getElementById("btn-set-prev").disabled, false);
    assert.equal(shell.window.document.getElementById("btn-set-next").disabled, false);
});

test("stepping asks the extension for a direction, never for a document", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.showSet({ title: "Set", index: 1, count: 3 });
    shell.window.document.getElementById("btn-set-next").click();
    shell.window.document.getElementById("btn-set-prev").click();

    assert.deepEqual(shell.stepCalls().map((call) => call.body), [{ delta: 1 }, { delta: -1 }]);
});

test("Ctrl+PageDown and Ctrl+PageUp move through the set", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.showSet({ title: "Set", index: 1, count: 3 });
    assert.equal(shell.keydown("PageDown").defaultPrevented, true);
    shell.keydown("PageUp");

    assert.deepEqual(shell.stepCalls().map((call) => call.body), [{ delta: 1 }, { delta: -1 }]);
});

test("the shortcuts respect the ends of the set", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.showSet({ title: "Set", index: 0, count: 2 });
    shell.keydown("PageUp");
    assert.deepEqual(shell.stepCalls(), []);

    shell.showSet({ title: "Set", index: 1, count: 2 });
    shell.keydown("PageDown");
    assert.deepEqual(shell.stepCalls(), []);
});

test("the set is listed first and without the timestamps other groups carry", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    shell.showSet({ title: "Review these", index: 0, count: 2 }, {
        source: "session",
        root: null,
        rootLabel: "This session",
        mode: "session",
        count: 3,
        groups: [
            {
                id: "set",
                label: "Review these",
                showTime: false,
                entries: [
                    { type: "inline", kind: "set", id: "set-1", name: "Overview", relPath: "set-1", folder: "Start here", mtimeMs: 1700000000000 },
                    { type: "file", kind: "set", name: "guide.md", path: "/w/docs/guide.md", relPath: "docs/guide.md", folder: "docs", mtimeMs: 1700000000000 },
                ],
            },
            {
                id: "inline",
                label: "Markdown displayed by the agent",
                entries: [
                    { type: "inline", kind: "inline", id: "aside", name: "Aside", relPath: "aside", folder: "", mtimeMs: 1700000000000 },
                ],
            },
        ],
    });

    const labels = Array.from(shell.window.document.querySelectorAll("#tree .group-label"));
    assert.deepEqual(labels.map((node) => node.textContent), ["Review these", "Markdown displayed by the agent"]);

    const nodes = Array.from(shell.window.document.querySelectorAll("#tree .node"));
    const meta = nodes.map((node) => {
        const label = node.querySelector(".label").textContent;
        const sub = node.querySelector(".meta");
        return [label, sub ? sub.textContent : null];
    });
    assert.deepEqual(meta.slice(0, 3).map((entry) => entry[0]), ["Overview", "guide.md", "Aside"]);
    // The set reads in the order the agent gave, so a time would imply an
    // ordering it does not have.
    assert.deepEqual(meta[0][1], "Start here");
    assert.deepEqual(meta[1][1], "docs");
    // Groups that do order by recency keep showing when each item changed.
    assert.match(meta[2][1], /\d/);
});
