import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../.github/extensions/skimdown/web");
const SHELL_ORIGIN = "http://127.0.0.1:47000";

/**
 * Boot bridge.js the way renderer.html does. jsdom has no nested browsing
 * context, so `window.parent` is the window itself — which is enough, because
 * the bridge only ever reads `parent.postMessage` and compares `ev.source`
 * against it.
 */
function createBridge(markdownText = "Read this passage.") {
    const dom = new JSDOM(
        `<!doctype html><html><body><div id="content"><p id="para">${markdownText}</p></div></body></html>`,
        {
            url: `http://127.0.0.1:47001/renderer.html?parentOrigin=${encodeURIComponent(SHELL_ORIGIN)}`,
            runScripts: "outside-only",
            pretendToBeVisual: true,
        },
    );
    const { window } = dom;
    const posted = [];
    const delivered = [];

    window.postMessage = (message) => posted.push(message);
    window.eval(fs.readFileSync(path.join(webRoot, "bridge.js"), "utf8"));
    window.chrome.webview.addEventListener("message", (event) => delivered.push(event.data));

    return {
        window,
        posted,
        delivered,
        payloads(type) {
            const matches = posted.filter((message) => message && message.__skim && message.payload.type === type);
            // The messages are built inside the jsdom realm, so compare them by
            // value rather than by prototype.
            return JSON.parse(JSON.stringify(matches.map((message) => message.payload)));
        },
        fromShell(payload) {
            window.dispatchEvent(new window.MessageEvent("message", {
                data: { __skim: true, payload },
                origin: SHELL_ORIGIN,
                source: window,
            }));
        },
        select(text) {
            const node = window.document.getElementById("para").firstChild;
            const range = window.document.createRange();
            range.setStart(node, 0);
            range.setEnd(node, text.length);
            const selection = window.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        },
        close() {
            dom.window.close();
        },
    };
}

test("the bridge answers a selection request without forwarding it to the renderer", (t) => {
    const bridge = createBridge();
    t.after(() => bridge.close());

    bridge.select("Read this");
    bridge.fromShell({ type: "selection/request" });

    assert.deepEqual(bridge.payloads("selection/value"), [{ type: "selection/value", text: "Read this" }]);
    // renderer.js has no idea this message type exists.
    assert.equal(bridge.delivered.length, 0);
});

test("an empty selection answers with an empty body rather than silence", (t) => {
    const bridge = createBridge();
    t.after(() => bridge.close());

    bridge.fromShell({ type: "selection/request" });
    assert.deepEqual(bridge.payloads("selection/value"), [{ type: "selection/value", text: "" }]);
});

test("a selection body is capped before it leaves the frame", (t) => {
    const bridge = createBridge("x".repeat(40000));
    t.after(() => bridge.close());

    bridge.select("x".repeat(40000));
    bridge.fromShell({ type: "selection/request" });

    assert.equal(bridge.payloads("selection/value")[0].text.length, 32768);
});

test("selection changes report size only, never the passage", async (t) => {
    const bridge = createBridge();
    t.after(() => bridge.close());

    bridge.select("Read this");
    bridge.window.document.dispatchEvent(new bridge.window.Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 250));

    assert.deepEqual(bridge.payloads("selection"), [{ type: "selection", empty: false, length: 9 }]);
    assert.doesNotMatch(JSON.stringify(bridge.posted), /Read this/);
});

test("Ctrl+I is raised as an ask shortcut the upstream renderer does not know", (t) => {
    const bridge = createBridge();
    t.after(() => bridge.close());

    const event = new bridge.window.KeyboardEvent("keydown", { key: "i", ctrlKey: true, cancelable: true });
    bridge.window.dispatchEvent(event);

    assert.deepEqual(bridge.payloads("shortcut"), [{ type: "shortcut", id: "ask" }]);
    assert.equal(event.defaultPrevented, true);

    for (const init of [
        { key: "i" },
        { key: "i", ctrlKey: true, shiftKey: true },
        { key: "i", ctrlKey: true, altKey: true },
        { key: "f", ctrlKey: true },
    ]) {
        bridge.window.dispatchEvent(new bridge.window.KeyboardEvent("keydown", { ...init, cancelable: true }));
    }
    assert.equal(bridge.payloads("shortcut").length, 1);
});
