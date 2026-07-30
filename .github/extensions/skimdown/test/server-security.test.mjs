import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createInstance } from "../lib/server.mjs";

test("loopback API enforces instance and browser request boundaries", { concurrency: false }, async (t) => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skimdown-security-"));
    const previousCopilotHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(tempRoot, "copilot");

    const workspace = path.join(tempRoot, "workspace");
    const external = path.join(tempRoot, "external");
    await fs.mkdir(path.join(workspace, ".git"), { recursive: true });
    await fs.mkdir(external, { recursive: true });
    await fs.writeFile(path.join(workspace, "README.md"), "# Workspace\n", "utf8");
    const externalFile = path.join(external, "secret.md");
    await fs.writeFile(externalFile, "# External\n", "utf8");

    const instance = await createInstance({
        instanceId: "security-test",
        sessionId: "security-test-session",
        workspacePath: workspace,
        log() {},
    });

    const panelUrl = new URL(instance.url);
    const origin = panelUrl.origin;
    const port = Number(panelUrl.port);
    const token = new URLSearchParams(panelUrl.hash.slice(1)).get("token");
    const browserHeaders = {
        Host: `127.0.0.1:${port}`,
        Origin: origin,
        "Sec-Fetch-Site": "same-origin",
        "X-SkimDown-Capability": token,
    };

    t.after(async () => {
        await instance.dispose();
        if (previousCopilotHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousCopilotHome;
        await fs.rm(tempRoot, { recursive: true, force: true });
    });

    await t.test("accepts an authenticated API request", async () => {
        const response = await request(port, "/api/state", { headers: browserHeaders });
        assert.equal(response.status, 200);
        assert.equal(JSON.parse(response.body).instanceId, "security-test");
    });

    // Real browsers do not send `Origin` on the same-origin `EventSource` GET,
    // so the accepted case has to be exercised without one.
    await t.test("accepts an authenticated SSE connection without an Origin", async () => {
        const response = await readEventStream(
            port,
            `/events?token=${encodeURIComponent(token)}`,
            {
                Host: `127.0.0.1:${port}`,
                "Sec-Fetch-Site": "same-origin",
            },
        );
        assert.equal(response.status, 200);
        assert.match(response.body, /event: state/);
    });

    await t.test("rejects an SSE connection from a foreign Origin", async () => {
        const response = await readEventStream(
            port,
            `/events?token=${encodeURIComponent(token)}`,
            {
                Host: `127.0.0.1:${port}`,
                Origin: "https://attacker.example",
                "Sec-Fetch-Site": "same-origin",
            },
        );
        assert.equal(response.status, 403);
    });

    await t.test("rejects an SSE connection without a capability", async () => {
        const response = await readEventStream(port, "/events", {
            Host: `127.0.0.1:${port}`,
            "Sec-Fetch-Site": "same-origin",
        });
        assert.equal(response.status, 401);
    });

    await t.test("rejects a missing capability", async () => {
        const { ["X-SkimDown-Capability"]: _, ...headers } = browserHeaders;
        const response = await request(port, "/api/state", { headers });
        assert.equal(response.status, 401);
    });

    await t.test("rejects a foreign Origin", async () => {
        const response = await request(port, "/api/state", {
            headers: { ...browserHeaders, Origin: "https://attacker.example" },
        });
        assert.equal(response.status, 403);
    });

    await t.test("rejects cross-site Fetch Metadata", async () => {
        const response = await request(port, "/api/state", {
            headers: { ...browserHeaders, "Sec-Fetch-Site": "cross-site" },
        });
        assert.equal(response.status, 403);
    });

    await t.test("rejects a DNS rebinding Host", async () => {
        const response = await request(port, "/api/state", {
            headers: { ...browserHeaders, Host: `attacker.example:${port}` },
        });
        assert.equal(response.status, 403);
    });

    await t.test("rejects a simple-request content type", async () => {
        const response = await request(port, "/api/refresh", {
            method: "POST",
            headers: { ...browserHeaders, "Content-Type": "text/plain" },
            body: "{}",
        });
        assert.equal(response.status, 415);
    });

    await t.test("rejects unapproved files until the root is explicitly opened", async () => {
        const denied = await jsonPost(port, "/api/select", browserHeaders, {
            kind: "file",
            path: externalFile,
        });
        assert.equal(denied.status, 403);

        const approved = await jsonPost(port, "/api/open", browserHeaders, { path: externalFile });
        assert.equal(approved.status, 200);

        const selected = await jsonPost(port, "/api/select", browserHeaders, {
            kind: "file",
            path: externalFile,
        });
        assert.equal(selected.status, 200);
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

function readEventStream(port, requestPath, headers) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: "127.0.0.1", port, path: requestPath, method: "GET", headers },
            (res) => {
                let body = "";
                let settled = false;
                const settle = () => {
                    if (settled) return;
                    settled = true;
                    resolve({ status: res.statusCode, body });
                    res.destroy();
                };
                res.on("data", (chunk) => {
                    body += chunk.toString("utf8");
                    // A rejected stream never emits an event, so also settle on
                    // `end` rather than waiting for one that will not arrive.
                    if (body.includes("event: state")) settle();
                });
                res.on("end", settle);
            },
        );
        req.on("error", reject);
        req.end();
    });
}
