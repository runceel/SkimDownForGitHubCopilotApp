import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createInstance } from "../lib/server.mjs";

test("browser handoff opens the panel without exposing the capability", { concurrency: false }, async (t) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skimdown-handoff-"));
    const previousCopilotHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(tempRoot, "copilot");

    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "# Workspace\n", "utf8");

    const launched = [];
    let launchResult = { ok: true };
    const instance = await createInstance({
        instanceId: "handoff-test",
        sessionId: "handoff-test-session",
        workspacePath: workspace,
        log() {},
        launchExternal(href) {
            launched.push(href);
            return launchResult;
        },
    });

    const panelUrl = new URL(instance.url);
    const port = Number(panelUrl.port);
    const token = new URLSearchParams(panelUrl.hash.slice(1)).get("token");
    const browserHeaders = {
        Host: `127.0.0.1:${port}`,
        Origin: panelUrl.origin,
        "Sec-Fetch-Site": "same-origin",
        "X-SkimDown-Capability": token,
    };

    t.after(async () => {
        await instance.dispose();
        if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousCopilotHome;
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    await t.test("hands this instance's panel URL to the default browser", () => {
        launched.length = 0;
        launchResult = { ok: true };

        const result = instance.openInBrowser();

        assert.deepEqual(result, { ok: true });
        assert.deepEqual(launched, [instance.url]);
    });

    await t.test("keeps the capability out of a failed handoff", () => {
        launched.length = 0;
        launchResult = { ok: false, error: `spawn failed for ${instance.url}` };

        const result = instance.openInBrowser();

        assert.equal(result.ok, false);
        assert.doesNotMatch(result.error, new RegExp(token, "i"));
        assert.ok(!result.error.includes(instance.url));
        assert.equal(Object.hasOwn(result, "url"), false);
    });

    await t.test("ignores a caller-supplied target and never echoes the URL", async () => {
        launched.length = 0;
        launchResult = { ok: true };

        const response = await jsonPost(port, "/api/open-browser", browserHeaders, {
            href: "https://attacker.example/",
        });

        assert.equal(response.status, 200);
        assert.deepEqual(launched, [instance.url]);
        assert.equal(response.body.includes(token), false);
        assert.deepEqual(JSON.parse(response.body), { ok: true });
    });

    await t.test("still requires the instance capability", async () => {
        launched.length = 0;
        const { ["X-SkimDown-Capability"]: _token, ...headers } = browserHeaders;

        const response = await jsonPost(port, "/api/open-browser", headers, {});

        assert.equal(response.status, 401);
        assert.deepEqual(launched, []);
    });
});

function jsonPost(port, requestPath, headers, body) {
    return request(port, requestPath, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}

function request(port, requestPath, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: "127.0.0.1", port, path: requestPath, method, headers },
            (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    resolve({
                        status: res.statusCode,
                        body: Buffer.concat(chunks).toString("utf8"),
                    });
                });
            },
        );
        req.on("error", reject);
        if (body !== undefined) req.write(body);
        req.end();
    });
}
