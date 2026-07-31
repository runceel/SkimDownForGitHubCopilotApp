import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createInstance } from "../lib/server.mjs";

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("serves chunked vendored assets as the assembled upstream bytes", async (t) => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "skimdown-chunks-"));
    const previousCopilotHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(tempRoot, "copilot-home");

    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    await writeFile(path.join(workspace, "README.md"), "# Chunks\n", "utf8");

    const instance = await createInstance({
        instanceId: "chunk-test",
        sessionId: "chunk-test-session",
        workspacePath: workspace,
        log() {},
    });

    t.after(async () => {
        await instance.dispose();
        if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousCopilotHome;
        await rm(tempRoot, { recursive: true, force: true });
    });

    const manifest = JSON.parse(await readFile(path.join(extensionRoot, "vendor-lock.json"), "utf8"));
    const chunked = manifest.files.filter((file) => file.chunks);
    assert.ok(chunked.length > 0, "at least one vendored asset must be stored as chunks");

    const state = await instance.buildState();
    const rendererBaseUri = state.rendererBaseUri;

    for (const file of chunked) {
        const response = await fetch(new URL(`/vendor/${file.path}`, rendererBaseUri));
        assert.equal(response.status, 200, `${file.path} must be served`);
        assert.match(response.headers.get("content-type"), /^text\/javascript/);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");

        const bytes = Buffer.from(await response.arrayBuffer());
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);

        // Chunks are storage detail: they must not be reachable on their own.
        for (let index = 0; index < file.chunks.sha256.length; index += 1) {
            const chunkUrl = new URL(
                `/vendor/${file.path}.${String(index).padStart(3, "0")}`,
                rendererBaseUri,
            );
            assert.equal((await fetch(chunkUrl)).status, 404);
        }

        assert.equal((await fetch(new URL(`/vendor/${file.path}`, instance.url))).status, 404);
    }
});
