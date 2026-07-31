import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The Copilot app extension installer refuses any single file above this size.
const MAX_INSTALLABLE_FILE_BYTES = 1_000_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = path.join(repoRoot, ".github", "extensions", "skimdown");

async function listFiles(directory) {
    const files = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const absolutePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...(await listFiles(absolutePath)));
        } else if (entry.isFile()) {
            files.push(absolutePath);
        }
    }
    return files;
}

test("every packaged extension file stays under the installer size limit", async () => {
    const files = await listFiles(extensionRoot);
    assert.ok(files.length > 0, "the extension directory must contain files");

    const oversized = [];
    for (const absolutePath of files) {
        const { size } = await stat(absolutePath);
        if (size > MAX_INSTALLABLE_FILE_BYTES) {
            oversized.push(`${path.relative(repoRoot, absolutePath).replaceAll("\\", "/")} (${size} bytes)`);
        }
    }

    assert.deepEqual(
        oversized,
        [],
        `these files exceed the ${MAX_INSTALLABLE_FILE_BYTES} byte installer limit and must be stored as chunks`,
    );
});
