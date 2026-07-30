import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { JSDOM } from "jsdom";

const DOMPURIFY_VERSION = "3.4.12";
const DOMPURIFY_SHA256 = "c45ba939765574f96cbf35ee9b6d89f73756a17921814425e74b82f7c54603ce";
const dompurifyPath = fileURLToPath(
  new URL("../.github/extensions/skimdown/web/vendor/dompurify.min.js", import.meta.url),
);
const markdownItPath = fileURLToPath(
  new URL("../.github/extensions/skimdown/web/vendor/markdown-it.min.js", import.meta.url),
);

const katexTags = [
  "math", "annotation", "semantics", "mtext", "mn", "mo", "mi", "mspace",
  "mover", "munder", "munderover", "msup", "msub", "msubsup", "mfrac",
  "mroot", "msqrt", "mtable", "mtr", "mtd", "mlabeledtr", "mrow", "menclose",
  "mstyle", "mpadded", "mphantom", "mglyph", "mfenced", "merror",
];

const katexAttrs = [
  "accent", "accentunder", "align", "bevelled", "close", "columnsalign",
  "columnlines", "columnspan", "denomalign", "depth", "dir", "display",
  "displaystyle", "encoding", "fence", "frame", "height", "linethickness",
  "lspace", "lquote", "mathbackground", "mathcolor", "mathsize", "mathvariant",
  "maxsize", "minsize", "movablelimits", "notation", "numalign", "open",
  "rowalign", "rowlines", "rowspacing", "rowspan", "rspace", "rquote",
  "scriptlevel", "scriptminsize", "scriptsizemultiplier", "selection",
  "separator", "separators", "stretchy", "subscriptshift", "supscriptshift",
  "symmetric", "voffset", "width", "xmlns", "aria-hidden",
];

const sanitizeOptions = {
  USE_PROFILES: { html: true, mathMl: true },
  ADD_TAGS: katexTags.concat(["button"]),
  ADD_ATTR: katexAttrs.concat([
    "target", "rel", "id", "type", "aria-label", "data-source",
    "width", "height", "checked", "disabled",
  ]),
  ALLOW_DATA_ATTR: true,
  FORBID_TAGS: ["style", "script", "iframe", "object", "embed", "form"],
  FORBID_ATTR: ["onerror", "onload", "onclick"],
};

async function createRendererRuntime() {
  const dom = new JSDOM("", { runScripts: "outside-only" });
  const [dompurifyBundle, markdownItBundle] = await Promise.all([
    readFile(dompurifyPath, "utf8"),
    readFile(markdownItPath, "utf8"),
  ]);

  dom.window.eval(dompurifyBundle);
  dom.window.eval(markdownItBundle);

  dom.window.DOMPurify.addHook("uponSanitizeAttribute", (node, data) => {
    if (data.attrName !== "style") {
      return;
    }

    let element = node;
    while (element) {
      if (
        element.classList
        && ["katex", "katex-display", "katex-mathml", "katex-html"]
          .some((className) => element.classList.contains(className))
      ) {
        return;
      }
      element = element.parentNode;
    }

    data.keepAttr = false;
  });

  return dom;
}

function assertNoExecutableMarkup(window, html) {
  const container = window.document.createElement("div");
  container.innerHTML = html;

  assert.equal(
    container.querySelector("script, iframe, object, embed, form, selectedcontent"),
    null,
  );
  for (const element of container.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      assert.doesNotMatch(attribute.name, /^on/i);
      if (["href", "src", "xlink:href"].includes(attribute.name.toLowerCase())) {
        assert.doesNotMatch(attribute.value.replaceAll(/\s/g, ""), /^javascript:/i);
      }
    }
  }
}

test("vendored DOMPurify matches the reviewed upstream release", async () => {
  const bundle = await readFile(dompurifyPath);
  const source = bundle.toString("utf8");

  assert.match(source, new RegExp(`DOMPurify ${DOMPURIFY_VERSION.replaceAll(".", "\\.")}`));
  assert.equal(createHash("sha256").update(bundle).digest("hex"), DOMPURIFY_SHA256);

  const dom = await createRendererRuntime();
  assert.equal(dom.window.DOMPurify.version, DOMPURIFY_VERSION);
  dom.window.close();
});

test("representative Markdown still renders through the sanitizer", async () => {
  const dom = await createRendererRuntime();
  const markdown = [
    "# Release notes",
    "",
    "- Safe **formatting**",
    "- [Project](https://github.com/runceel/SkimDownForGitHubCopilotApp)",
    "",
    "```js",
    "const answer = 42;",
    "```",
  ].join("\n");

  const rendered = dom.window.markdownit().render(markdown);
  const clean = dom.window.DOMPurify.sanitize(rendered, sanitizeOptions);

  assert.match(clean, /<h1>Release notes<\/h1>/);
  assert.match(clean, /<strong>formatting<\/strong>/);
  assert.match(clean, /href="https:\/\/github\.com\/runceel\/SkimDownForGitHubCopilotApp"/);
  assert.match(clean, /<code class="language-js">const answer = 42;\n<\/code>/);
  assertNoExecutableMarkup(dom.window, clean);
  dom.window.close();
});

test("known mutation-XSS and URI payloads remain inert after reinsertion", async () => {
  const dom = await createRendererRuntime();
  const payloads = [
    "<form><math><mtext></form><form><mglyph><style></math><img src=x onerror=alert(1)>",
    "<select><button><selectedcontent></selectedcontent></button><option selected=javascript:1><img src=x onerror=alert(1)>x</option></select>",
    "<a href=\"\u2028javascript:alert(1)\">unsafe link</a>",
    "<img src=x onerror=alert(1)><script>alert(1)</script>",
  ];

  for (const payload of payloads) {
    const clean = dom.window.DOMPurify.sanitize(payload, sanitizeOptions);
    assertNoExecutableMarkup(dom.window, clean);
  }

  dom.window.close();
});
