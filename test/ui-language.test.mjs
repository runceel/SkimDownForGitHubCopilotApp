import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const userFacingSources = [
    ".github/extensions/skimdown/extension.mjs",
    ".github/extensions/skimdown/lib/remoteContent.mjs",
    ".github/extensions/skimdown/lib/server.mjs",
    ".github/extensions/skimdown/lib/sources.mjs",
    ".github/extensions/skimdown/web/shell.html",
    ".github/extensions/skimdown/web/shell.js",
];
const japaneseText = /[ぁ-んァ-ヶ一-龠々ー]/;

test("user-facing SkimDown sources contain no Japanese text", () => {
    for (const relativePath of userFacingSources) {
        const content = fs.readFileSync(path.join(root, relativePath), "utf8");
        assert.doesNotMatch(content, japaneseText, relativePath);
    }
});
