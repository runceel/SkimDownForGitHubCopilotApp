import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../.github/extensions/skimdown/web");

function loadScript(window, relativePath) {
    window.eval(fs.readFileSync(path.join(webRoot, relativePath), "utf8"));
}

async function createRenderer({ loadPurify = true } = {}) {
    const dom = new JSDOM(
        "<!doctype html><html><body><div id=\"skim-zoom-root\"><main id=\"content\"></main></div><div id=\"search-status\" hidden></div></body></html>",
        {
            url: "https://skimdown-app.example/renderer.html",
            runScripts: "outside-only",
            pretendToBeVisual: true,
        },
    );
    const { window } = dom;
    const messages = [];
    const listeners = [];
    const rawDivAssignments = [];
    const innerHtml = Object.getOwnPropertyDescriptor(window.Element.prototype, "innerHTML");

    Object.defineProperty(window.Element.prototype, "innerHTML", {
        configurable: innerHtml.configurable,
        enumerable: innerHtml.enumerable,
        get: innerHtml.get,
        set(value) {
            if (this.tagName === "DIV" && String(value).includes("SKIM_SECURITY_MARKER")) {
                rawDivAssignments.push(String(value));
            }
            innerHtml.set.call(this, value);
        },
    });

    window.chrome = {
        webview: {
            postMessage(message) {
                messages.push(message);
            },
            addEventListener(type, listener) {
                if (type === "message") listeners.push(listener);
            },
        },
    };
    window.scrollTo = () => {};

    loadScript(window, "vendor/markdown-it.min.js");
    if (loadPurify) loadScript(window, "vendor/dompurify.min.js");
    loadScript(window, "renderer.js");

    if (!listeners.length) {
        window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    }
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.ok(messages.some((message) => message?.type === "ready"), "renderer did not become ready");

    return {
        window,
        rawDivAssignments,
        async render(markdown) {
            for (const listener of listeners) {
                listener({
                    data: {
                        type: "render",
                        markdown,
                        sourcePath: "docs/test.md",
                        contentBaseUri: "https://skimdown-content.example/",
                        theme: "light",
                    },
                });
            }
            await new Promise((resolve) => window.setTimeout(resolve, 0));
            return window.document.getElementById("content");
        },
        close() {
            dom.window.close();
        },
    };
}

test("raw HTML is sanitized before URL rewriting or live DOM insertion", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    renderer.window.__securityEvents = 0;

    const content = await renderer.render(
        '<img data-test="SKIM_SECURITY_MARKER" src="image.png" onerror="window.__securityEvents += 1">',
    );
    const image = content.querySelector("img");

    assert.ok(image);
    assert.equal(image.getAttribute("src"), "https://skimdown-content.example/docs/image.png");
    assert.equal(image.hasAttribute("onerror"), false);
    image.dispatchEvent(new renderer.window.Event("error"));
    assert.equal(renderer.window.__securityEvents, 0);
    assert.deepEqual(renderer.rawDivAssignments, []);
});

test("SVG and mutation-XSS payloads cannot retain executable markup", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    renderer.window.__securityEvents = 0;

    let content = await renderer.render(
        '<svg data-test="SKIM_SECURITY_MARKER"><script>window.__securityEvents += 1</script><g onload="window.__securityEvents += 1"></g></svg><p>safe</p>',
    );
    assert.equal(content.querySelector("svg, script, [onload], [onerror]"), null);
    assert.match(content.textContent, /safe/);

    content = await renderer.render(
        '<math data-test="SKIM_SECURITY_MARKER"><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=window.__securityEvents += 1>"></table></mtext></math>',
    );
    assert.equal(content.querySelector("script, style, [onload], [onerror], [onclick]"), null);
    for (const image of content.querySelectorAll("img")) {
        image.dispatchEvent(new renderer.window.Event("error"));
    }
    assert.equal(renderer.window.__securityEvents, 0);
    assert.deepEqual(renderer.rawDivAssignments, []);
});

test("renderer fails closed when DOMPurify is unavailable", async (t) => {
    const renderer = await createRenderer({ loadPurify: false });
    t.after(() => renderer.close());
    renderer.window.__securityEvents = 0;

    const content = await renderer.render(
        '<img data-test="SKIM_SECURITY_MARKER" src=x onerror="window.__securityEvents += 1"><script>window.__securityEvents += 1</script>',
    );

    assert.equal(content.querySelector("img, script, [onerror]"), null);
    assert.match(content.textContent, /sanitizer failed to load/i);
    assert.equal(renderer.window.__securityEvents, 0);
    assert.deepEqual(renderer.rawDivAssignments, []);
});
