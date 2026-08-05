import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { resolveWorkspaceRoot } from "../lib/paths.mjs";

/* execFile is callback-based, so awaiting it directly resolves on the
 * ChildProcess rather than on exit. The repository would then still be
 * uninitialised when the assertion runs, and resolveWorkspaceRoot would fall
 * back to this checkout instead of the fixture. */
const execFileAsync = promisify(execFile);

async function removeWithRetry(targetPath) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
            await fs.rm(targetPath, { recursive: true, force: true });
            return;
        } catch (error) {
            if (error?.code !== "EBUSY") {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }
    await fs.rm(targetPath, { recursive: true, force: true });
}

test("resolveWorkspaceRoot prefers the git repository root for nested directories", async (t) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skimdown-paths-"));
    const repoDir = path.join(tempRoot, "repo");
    const nestedDir = path.join(repoDir, "src", "nested");

    await fs.mkdir(nestedDir, { recursive: true });
    await execFileAsync("git", ["-C", repoDir, "init", "--initial-branch=main"]);

    const previousCwd = process.cwd();
    process.chdir(nestedDir);
    try {
        const resolved = await resolveWorkspaceRoot(nestedDir);
        assert.equal(path.resolve(repoDir), resolved);
    } finally {
        process.chdir(previousCwd);
        await removeWithRetry(tempRoot);
    }
});
