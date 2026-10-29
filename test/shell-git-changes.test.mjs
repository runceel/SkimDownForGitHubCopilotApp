import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.github/extensions/skimdown/web");

test("Git toolbar and shortcut persist the preference and decorate tree/recent entries", (t) => {
    const dom = new JSDOM(fs.readFileSync(path.join(web, "shell.html"), "utf8"), {
        url: "http://127.0.0.1:47000/#token=test", runScripts: "outside-only", pretendToBeVisual: true,
    });
    t.after(() => dom.window.close());
    const { window } = dom;
    const listeners = new Map();
    const calls = [];
    window.EventSource = class {
        addEventListener(type, fn) { listeners.set(type, fn); }
    };
    window.ResizeObserver = class { observe() {} };
    window.matchMedia = () => ({ matches: false, addEventListener() {} });
    window.HTMLCanvasElement.prototype.getContext = () => null;
    window.fetch = async (url, init) => {
        calls.push({ url, body: init?.body ? JSON.parse(init.body) : null });
        return { ok: true, json: async () => ({}) };
    };
    window.eval(fs.readFileSync(path.join(web, "shell.js"), "utf8"));
    const settings = {
        sidebarVisible: true, sidebarPosition: "left", sidebarWidth: 260, viewMode: "tree",
        zoomFactor: 1, contentMaxWidth: "960px", tocVisible: true, showGitChanges: false,
        expanded: { "C:\\repo": ["docs"] },
    };
    const files = [
        { type: "file", name: "modified.md", relPath: "docs/modified.md", path: "C:\\repo\\docs\\modified.md" },
        { type: "file", name: "untracked.md", relPath: "untracked.md", path: "C:\\repo\\untracked.md" },
        { type: "file", name: "added.md", relPath: "added.md", path: "C:\\repo\\added.md" },
        { type: "file", name: "same.md", relPath: "same.md", path: "C:\\repo\\same.md" },
    ];
    const server = {
        rendererBaseUri: "http://127.0.0.1:47001/", sources: [], settings,
        listing: {
            root: "C:\\repo", rootLabel: "repo", count: 4, mode: "folder", recent: files,
            tree: [{ type: "dir", name: "docs", relPath: "docs", children: [files[0]] }, ...files.slice(1)],
        },
        git: { statuses: { [files[0].path]: "M", [files[1].path]: "U", [files[2].path]: "A" }, error: null },
    };
    const emit = () => listeners.get("state")({ data: JSON.stringify(server) });
    emit();
    const button = window.document.getElementById("btn-git-changes");
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(window.document.querySelectorAll(".git-badge").length, 0);
    button.click();
    assert.deepEqual(calls.findLast((call) => call.url === "/api/settings").body, { showGitChanges: true });
    assert.equal(button.getAttribute("aria-pressed"), "true");
    assert.deepEqual([...window.document.querySelectorAll(".git-badge")].map((badge) => badge.textContent), ["●", "M", "U", "A"]);
    assert.equal(window.document.querySelector(".node.dir").classList.contains("git-modified"), true);
    window.dispatchEvent(new window.KeyboardEvent("keydown", {
        key: "D", ctrlKey: true, shiftKey: true, cancelable: true,
    }));
    assert.equal(button.getAttribute("aria-pressed"), "false");
    assert.equal(window.document.querySelectorAll(".git-badge").length, 0);
    settings.showGitChanges = true;
    settings.viewMode = "recent";
    emit();
    assert.deepEqual([...window.document.querySelectorAll(".git-badge")].map((badge) => badge.textContent), ["M", "U", "A"]);
});
