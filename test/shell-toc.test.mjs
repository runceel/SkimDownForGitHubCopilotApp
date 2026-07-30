import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../.github/extensions/skimdown/web");

function createShell(previewWidth = 500) {
    const html = fs.readFileSync(path.join(webRoot, "shell.html"), "utf8");
    const dom = new JSDOM(html, {
        url: "http://127.0.0.1:47000/shell.html#token=test-token",
        runScripts: "outside-only",
        pretendToBeVisual: true,
    });
    const { window } = dom;
    const listeners = new Map();
    let resize;

    class MockEventSource {
        addEventListener(type, listener) {
            const current = listeners.get(type) || [];
            current.push(listener);
            listeners.set(type, current);
        }
    }

    window.EventSource = MockEventSource;
    window.ResizeObserver = class {
        constructor(callback) {
            resize = callback;
        }

        observe() {}
    };
    window.matchMedia = () => ({
        matches: false,
        addEventListener() {},
    });
    window.fetch = async () => ({
        ok: true,
        async json() {
            return {};
        },
    });
    window.HTMLCanvasElement.prototype.getContext = () => null;

    const previewWrap = window.document.getElementById("preview-wrap");
    previewWrap.getBoundingClientRect = () => ({ width: previewWidth });

    window.eval(fs.readFileSync(path.join(webRoot, "shell.js"), "utf8"));

    function emit(type, payload) {
        for (const listener of listeners.get(type) || []) {
            listener({ data: JSON.stringify(payload) });
        }
    }

    emit("state", {
        rendererBaseUri: "http://127.0.0.1:47001/",
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
    emit("doc", {
        title: "Responsive ToC",
        subtitle: "",
        markdown: "# Intro",
        sourcePath: "docs/test.md",
    });

    return {
        window,
        setWidth(width) {
            previewWidth = width;
            resize();
        },
        close() {
            dom.window.close();
        },
    };
}

test("narrow previews keep a compact expandable table of contents", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    const compactButton = shell.window.document.getElementById("btn-expand-toc");
    const pane = shell.window.document.getElementById("toc-pane");
    const closeButton = shell.window.document.getElementById("btn-close-toc");
    const toolbarButton = shell.window.document.getElementById("btn-toggle-toc");

    assert.equal(compactButton.hidden, false);
    assert.equal(compactButton.getAttribute("aria-expanded"), "false");
    assert.equal(pane.hidden, true);

    compactButton.click();
    assert.equal(compactButton.hidden, true);
    assert.equal(compactButton.getAttribute("aria-expanded"), "true");
    assert.equal(pane.hidden, false);
    assert.equal(pane.dataset.layout, "compact");

    shell.window.dispatchEvent(new shell.window.KeyboardEvent("keydown", { key: "Escape" }));
    assert.equal(compactButton.hidden, false);
    assert.equal(pane.hidden, true);

    const heading = shell.window.document.createElement("button");
    heading.className = "toc-item";
    heading.dataset.headingId = "intro";
    shell.window.document.getElementById("toc-list").appendChild(heading);
    compactButton.click();
    heading.click();
    assert.equal(compactButton.hidden, false);
    assert.equal(pane.hidden, true);

    compactButton.click();
    closeButton.click();
    assert.equal(compactButton.hidden, false);
    assert.equal(pane.hidden, true);
    assert.equal(toolbarButton.getAttribute("aria-pressed"), "true");
});

test("resizing between compact and full ToC layouts does not change the saved preference", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    const compactButton = shell.window.document.getElementById("btn-expand-toc");
    const pane = shell.window.document.getElementById("toc-pane");
    const toolbarButton = shell.window.document.getElementById("btn-toggle-toc");

    shell.setWidth(800);
    assert.equal(compactButton.hidden, true);
    assert.equal(pane.hidden, false);
    assert.equal(pane.dataset.layout, "full");

    shell.setWidth(500);
    assert.equal(compactButton.hidden, false);
    assert.equal(pane.hidden, true);
    assert.equal(toolbarButton.getAttribute("aria-pressed"), "true");
});

test("Mermaid modal presentation hides responsive ToC controls", (t) => {
    const shell = createShell();
    t.after(() => shell.close());

    const preview = shell.window.document.getElementById("preview");
    const compactButton = shell.window.document.getElementById("btn-expand-toc");
    const toolbarButton = shell.window.document.getElementById("btn-toggle-toc");

    shell.window.dispatchEvent(new shell.window.MessageEvent("message", {
        origin: "http://127.0.0.1:47001",
        source: preview.contentWindow,
        data: { __skim: true, payload: { type: "modal", open: true } },
    }));

    assert.equal(compactButton.hidden, true);
    assert.equal(toolbarButton.disabled, true);

    shell.window.dispatchEvent(new shell.window.MessageEvent("message", {
        origin: "http://127.0.0.1:47001",
        source: preview.contentWindow,
        data: { __skim: true, payload: { type: "modal", open: false } },
    }));

    assert.equal(compactButton.hidden, false);
    assert.equal(toolbarButton.disabled, false);
});

test("ToC colors use theme-aware shell fallbacks", () => {
    const css = fs.readFileSync(path.join(webRoot, "shell.css"), "utf8");

    assert.match(css, /--toc-bg:\s*light-dark\(#f0f0f2,\s*#090b0d\)/);
    assert.match(css, /background:\s*var\(--background-color-default,\s*var\(--toc-bg\)\)/);
    assert.doesNotMatch(css, /var\(--background-color-default,\s*#ffffff\)/);
    assert.doesNotMatch(css, /var\(--text-color-default,\s*#1f2328\)/);
});
