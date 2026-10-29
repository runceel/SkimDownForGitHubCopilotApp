import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, "../.github/extensions/skimdown/web");
const plain = (value) => JSON.parse(JSON.stringify(value));

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
    loadScript(window, "gitDiff.js");
    loadScript(window, "renderer.js");

    if (!listeners.length) {
        window.document.dispatchEvent(new window.Event("DOMContentLoaded"));
    }
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    assert.ok(messages.some((message) => message?.type === "ready"), "renderer did not become ready");

    return {
        window,
        messages,
        rawDivAssignments,
        async send(message) {
            for (const listener of listeners) listener({ data: message });
            await new Promise((resolve) => window.setTimeout(resolve, 20));
        },
        async render(markdown, {
            remoteContentId = "a".repeat(64),
            remoteContentToken = "",
            gitDiff = null,
        } = {}) {
            for (const listener of listeners) {
                listener({
                    data: {
                        type: "render",
                        markdown,
                        sourcePath: "docs/test.md",
                        contentBaseUri: "https://skimdown-content.example/",
                        remoteContentId,
                        remoteContentToken,
                        gitDiff,
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

test("renderer publishes a hierarchical table of contents with stable duplicate IDs", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());

    await renderer.render("# Intro\n\n## Details\n\n## Details\n\n### Deep dive");

    const tocMessage = renderer.messages.findLast((message) => message?.type === "toc");
    assert.deepEqual(plain(tocMessage), {
        type: "toc",
        headings: [
            { level: 1, title: "Intro", id: "intro" },
            { level: 2, title: "Details", id: "details" },
            { level: 2, title: "Details", id: "details-1" },
            { level: 3, title: "Deep dive", id: "deep-dive" },
        ],
    });
});

test("renderer displays leading YAML front matter as a metadata table", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());

    const content = await renderer.render([
        "---",
        "title: SkimDown",
        "tags:",
        "  - markdown",
        "  - preview",
        "draft: false",
        "---",
        "",
        "# Body",
        "",
        "---",
    ].join("\n"));

    assert.deepEqual(
        [...content.querySelectorAll(".skimdown-frontmatter tr")].map((row) => [
            row.querySelector("th").textContent,
            row.querySelector("td").textContent,
        ]),
        [
            ["title", "SkimDown"],
            ["tags", "markdown\npreview"],
            ["draft", "false"],
        ],
    );
    assert.equal(content.firstElementChild.className, "skimdown-frontmatter");
    assert.equal(content.querySelector("h1").textContent, "Body");
    assert.equal(content.querySelectorAll("hr").length, 1);
});

test("Git blocks reuse upstream grouping, safe previous-text markers, and search exclusion", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    const markdown = "# Same\n\nNew paragraph.\n\n- changed item\n  - added nested\n\n| A |\n| - |\n| row |\n";
    const content = await renderer.render(markdown, { gitDiff: { hunks: [
        { newStart: 2, newCount: 1, oldLines: [] },
        { newStart: 4, newCount: 1, oldLines: ["<script>previousOnly</script>"] },
        { newStart: 5, newCount: 1, oldLines: [] },
        { newStart: 9, newCount: 1, oldLines: ["| old row |"] },
        { newStart: 10, newCount: 0, oldLines: ["# deletedOnly"] },
    ] } });
    assert.ok(content.querySelector("p.skimdown-git-added"));
    assert.ok(content.querySelector("li.skimdown-git-modified"));
    assert.ok(content.querySelector("li li.skimdown-git-added"));
    assert.ok(content.querySelector("tr.skimdown-git-modified"));
    assert.ok(content.querySelector("li.skimdown-git-marker-item > details"));
    assert.ok(content.querySelector("tr.skimdown-git-marker-row > td > details"));
    assert.ok(content.querySelector(".skimdown-git-marker-deleted"));
    assert.match(content.querySelector(".skimdown-git-previous").textContent, /<script>previousOnly<\/script>/);
    assert.equal(content.querySelector(".skimdown-git-previous script"), null);
    assert.equal(content.querySelector(".skimdown-git-previous h1"), null);
    assert.equal(content.querySelectorAll(".skimdown-git-gutter").length, 1);
    const toc = renderer.messages.findLast((message) => message.type === "toc");
    assert.deepEqual(plain(toc.headings.map((heading) => heading.title)), ["Same"]);
    await renderer.send({ type: "search", query: "previousOnly", caseSensitive: false });
    assert.equal(renderer.messages.findLast((message) => message.type === "search/result").total, 0);
    await renderer.render(markdown);
    assert.equal(content.querySelector("[class*='skimdown-git-']"), null);
    assert.equal(content.classList.contains("skimdown-git-diff"), false);
});

test("Git highlights front matter, fenced diagrams/math, code, HTML, and rules", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    const markdown = "---\ntitle: New\n---\n\n```mermaid\ngraph TD; A-->B\n```\n\n```math\nx=1\n```\n\n```js\nlet x=1\n```\n\n<div>HTML</div>\n\n---\n";
    const content = await renderer.render(markdown, { gitDiff: { hunks: [
        { newStart: 0, newCount: 20, oldLines: [] },
    ] } });
    for (const selector of [
        ".skimdown-frontmatter", ".skim-mermaid-wrap", ".skim-math-block",
        ".skim-code pre", "div.skimdown-git-added", "hr",
    ]) {
        assert.ok(content.querySelector(selector)?.classList.contains("skimdown-git-added"), selector);
    }
});

test("Git run IDs join consecutive equal states and split at unchanged blocks and deletions", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    const content = await renderer.render("# First\n\nSecond.\n\nSame.\n\nThird.\n", { gitDiff: { hunks: [
        { newStart: 0, newCount: 3, oldLines: [] },
        { newStart: 6, newCount: 1, oldLines: [] },
        { newStart: 6, newCount: 0, oldLines: ["deleted"] },
    ] } });
    const run = (element) => [...element.classList].find((name) => name.startsWith("skimdown-git-run-"));
    const [second, same, third] = content.querySelectorAll(":scope > p");
    assert.equal(run(content.querySelector("h1")), run(second));
    assert.equal(run(same), undefined);
    assert.notEqual(run(third), run(second));
    assert.equal(run(content.querySelector(".skimdown-git-marker-deleted")), undefined);
});

test("Git-only refresh preserves reading position but changing the document resets it", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    const scrolls = [];
    renderer.window.scrollTo = (_x, y) => {
        scrolls.push(y);
        Object.defineProperty(renderer.window, "scrollY", { configurable: true, value: y });
    };
    await renderer.render("# Same\n");
    Object.defineProperty(renderer.window, "scrollY", { configurable: true, value: 240 });
    await renderer.render("# Same\n", { gitDiff: { hunks: [{ newStart: 0, newCount: 1, oldLines: [] }] } });
    assert.equal(scrolls.at(-1), 240);
    await renderer.render("# Other\n");
    assert.equal(scrolls.at(-1), 0);
    await renderer.render("# Other\n", { remoteContentId: "b".repeat(64) });
    assert.equal(scrolls.at(-1), 0);
});

test("renderer scrolls to a selected ToC heading and reports it as active", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    const content = await renderer.render("# Intro\n\n## Details");
    const details = content.querySelector("#details");
    let scrollOptions = null;
    details.scrollIntoView = (options) => {
        scrollOptions = options;
    };

    await renderer.send({ type: "toc/scroll", id: "details" });

    assert.deepEqual(plain(scrollOptions), { behavior: "smooth", block: "start" });
    assert.deepEqual(
        plain(renderer.messages.findLast((message) => message?.type === "toc/active")),
        { type: "toc/active", id: "details" },
    );
});

test("renderer caps long heading IDs consistently across the DOM and ToC protocol", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    const content = await renderer.render(`# ${"a".repeat(300)}`);
    const heading = content.querySelector("h1");
    const tocMessage = renderer.messages.findLast((message) => message?.type === "toc");
    let scrolled = false;
    heading.scrollIntoView = () => {
        scrolled = true;
    };

    assert.equal(heading.id.length, 256);
    assert.equal(tocMessage.headings[0].id, heading.id);

    await renderer.send({ type: "toc/scroll", id: heading.id });
    assert.equal(scrolled, true);
});

test("renderer tracks the active ToC heading as the document scrolls", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());
    const content = await renderer.render("# Intro\n\n## Details\n\n## Finish");
    const [intro, details, finish] = content.querySelectorAll("h1, h2");
    intro.getBoundingClientRect = () => ({ top: -300 });
    details.getBoundingClientRect = () => ({ top: 20 });
    finish.getBoundingClientRect = () => ({ top: 300 });

    renderer.window.dispatchEvent(new renderer.window.Event("scroll"));
    await new Promise((resolve) => renderer.window.setTimeout(resolve, 20));

    assert.deepEqual(
        plain(renderer.messages.findLast((message) => message?.type === "toc/active")),
        { type: "toc/active", id: "details" },
    );
});

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

test("remote resources require document consent and use the renderer proxy", async (t) => {
    const renderer = await createRenderer();
    t.after(() => renderer.close());

    let content = await renderer.render(
        '<img src="https://images.example/pixel.png">' +
            '<video poster="https://media.example/poster.jpg"></video>' +
            '<input type="image" src="https://forms.example/submit.png">',
    );
    let image = content.querySelector("img");
    let video = content.querySelector("video");
    const imageInput = content.querySelector('input[type="image"]');
    assert.equal(image.hasAttribute("src"), false);
    assert.equal(image.getAttribute("data-remote-blocked"), "true");
    assert.equal(video.hasAttribute("poster"), false);
    assert.equal(imageInput.hasAttribute("src"), false);

    content = await renderer.render(
        '<img src="https://images.example/pixel.png"><audio src="http://127.0.0.1/private.mp3"></audio>',
        { remoteContentToken: "document-grant" },
    );
    image = content.querySelector("img");
    const audio = content.querySelector("audio");
    assert.match(image.getAttribute("src"), /^\/remote-content\?token=document-grant&url=/);
    assert.equal(image.getAttribute("referrerpolicy"), "no-referrer");
    assert.equal(audio.hasAttribute("src"), false);
    assert.equal(audio.getAttribute("data-remote-policy-blocked"), "true");
});
