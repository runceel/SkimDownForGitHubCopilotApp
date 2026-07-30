import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverModule = path.join(repoRoot, ".github", "extensions", "skimdown", "lib", "server.mjs");

test("serves shell, renderer, and content with isolated capabilities", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "skimdown-security-"));
    const previousCopilotHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(tempRoot, "copilot-home");

    const workspace = path.join(tempRoot, "workspace");
    await mkdir(path.join(workspace, ".git"), { recursive: true });
    const markdownPath = path.join(workspace, "README.md");
    await writeFile(markdownPath, "# Test\n\n![pixel](pixel.png)\n", "utf8");
    await writeFile(path.join(workspace, "pixel.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const { createInstance } = await import(`${new URL(`file:///${serverModule.replaceAll("\\", "/")}`)}?test=${Date.now()}`);
    const instance = await createInstance({
        instanceId: "security-test",
        sessionId: "security-test",
        workspacePath: workspace,
        log() {},
    });

    try {
        const shellResponse = await fetch(instance.url);
        const shellHtml = await shellResponse.text();
        const stateResponse = await fetch(new URL("/api/state", instance.url));
        const state = await stateResponse.json();
        const shellOrigin = new URL(instance.url).origin;
        const rendererOrigin = new URL(state.rendererBaseUri).origin;
        const contentOrigin = new URL(state.contentBaseUri).origin;

        assert.equal(shellResponse.status, 200);
        assert.notEqual(shellOrigin, rendererOrigin);
        assert.notEqual(rendererOrigin, contentOrigin);
        assert.match(shellResponse.headers.get("content-security-policy"), /default-src 'none'/);
        assert.match(shellResponse.headers.get("content-security-policy"), /script-src 'self'/);
        assert.match(shellResponse.headers.get("content-security-policy"), new RegExp(`frame-src ${escapeRegex(rendererOrigin)}`));
        assert.doesNotMatch(shellResponse.headers.get("content-security-policy"), /unsafe-inline|unsafe-eval/);
        assert.equal(shellResponse.headers.get("x-content-type-options"), "nosniff");
        assert.equal(shellResponse.headers.get("cross-origin-resource-policy"), "same-origin");
        assert.match(shellHtml, /sandbox="allow-scripts allow-same-origin"/);
        assert.doesNotMatch(shellHtml, /\son[a-z]+\s*=|\sstyle\s*=/i);

        const rendererResponse = await fetch(new URL("/renderer.html", state.rendererBaseUri));
        const rendererCsp = rendererResponse.headers.get("content-security-policy");
        assert.equal(rendererResponse.status, 200);
        assert.match(rendererCsp, /default-src 'none'/);
        assert.match(rendererCsp, /script-src 'self'/);
        assert.doesNotMatch(rendererCsp, /script-src[^;]*unsafe-inline|unsafe-eval/);
        assert.match(rendererCsp, /connect-src 'none'/);
        assert.match(rendererCsp, new RegExp(`img-src[^;]*${escapeRegex(contentOrigin)}`));
        assert.match(rendererCsp, new RegExp(`frame-ancestors ${escapeRegex(shellOrigin)}`));
        assert.equal(rendererResponse.headers.get("x-content-type-options"), "nosniff");
        assert.equal(rendererResponse.headers.get("cross-origin-resource-policy"), "same-site");

        assert.equal((await fetch(new URL("/renderer.html", instance.url))).status, 404);
        assert.equal((await fetch(new URL("/shell.html", state.rendererBaseUri))).status, 404);
        assert.equal((await fetch(new URL("/api/state", state.rendererBaseUri))).status, 404);
        assert.equal((await fetch(new URL("/renderer.js", state.rendererBaseUri))).status, 200);

        const doc = await instance.selectFile(markdownPath, { push: false });
        const imageResponse = await fetch(new URL("pixel.png", new URL(doc.sourcePath, doc.contentBaseUri)));
        assert.equal(imageResponse.status, 200);
        assert.equal(imageResponse.headers.get("x-content-type-options"), "nosniff");
        assert.equal(imageResponse.headers.get("cross-origin-resource-policy"), "same-site");
        assert.match(imageResponse.headers.get("content-security-policy"), /script-src 'none'/);

        const shellScript = await readFile(path.join(repoRoot, ".github", "extensions", "skimdown", "web", "shell.js"), "utf8");
        const bridgeScript = await readFile(path.join(repoRoot, ".github", "extensions", "skimdown", "web", "bridge.js"), "utf8");
        assert.doesNotMatch(shellScript, /contentWindow\.__skimBridge|__skimShellReceive/);
        assert.doesNotMatch(bridgeScript, /parentWindow\.__skimShellReceive|fetch\(["']\/api\//);
    } finally {
        await instance.dispose();
        if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousCopilotHome;
        await rm(tempRoot, { recursive: true, force: true });
    }
});

function escapeRegex(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
