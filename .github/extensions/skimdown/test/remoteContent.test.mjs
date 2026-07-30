import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
    isPublicAddress,
    resolvePublicTarget,
    validateRemoteUrl,
} from "../lib/remoteContent.mjs";
import { createInstance } from "../lib/server.mjs";

test("public address policy blocks local and non-routable ranges", () => {
    for (const address of [
        "0.0.0.0",
        "10.0.0.1",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.168.1.1",
        "198.18.0.1",
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "::ffff:127.0.0.1",
    ]) {
        assert.equal(isPublicAddress(address), false, address);
    }

    assert.equal(isPublicAddress("8.8.8.8"), true);
    assert.equal(isPublicAddress("2606:4700:4700::1111"), true);
});

test("URL validation rejects intranet names, credentials, and unsupported schemes", () => {
    for (const url of [
        "http://localhost/pixel.png",
        "http://service/pixel.png",
        "http://printer.local/pixel.png",
        "http://user:secret@example.com/pixel.png",
        "file:///etc/passwd",
    ]) {
        assert.throws(() => validateRemoteUrl(url), undefined, url);
    }

    assert.equal(validateRemoteUrl("https://example.com/image.png#fragment").hash, "");
});

test("DNS answers are rejected when any address is private", async () => {
    const url = validateRemoteUrl("https://example.com/image.png");
    await assert.rejects(
        resolvePublicTarget(url, async () => [
            { address: "93.184.216.34", family: 4 },
            { address: "127.0.0.1", family: 4 },
        ]),
        /private IP/,
    );
});

test("instance requires document consent and still rejects a private target", async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "skimdown-privacy-"));
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = path.join(temp, "copilot");

    let instance;
    try {
        await fs.mkdir(path.join(temp, ".git"));
        const markdownPath = path.join(temp, "privacy.md");
        await fs.writeFile(markdownPath, "![remote](https://example.com/pixel.png)\n", "utf8");

        instance = await createInstance({
            instanceId: "privacy-test",
            sessionId: "privacy-test",
            workspacePath: temp,
            log() {},
        });
        await instance.openTarget(markdownPath);

        const shellResponse = await fetch(instance.url);
        assert.equal(shellResponse.status, 200);
        assert.match(shellResponse.headers.get("content-security-policy") || "", /connect-src 'self'/);

        const panelUrl = new URL(instance.url);
        const origin = panelUrl.origin;
        const capabilityToken = new URLSearchParams(panelUrl.hash.slice(1)).get("token");
        const browserHeaders = {
            Origin: origin,
            "Sec-Fetch-Site": "same-origin",
            "X-SkimDown-Capability": capabilityToken,
        };
        const stateResponse = await fetch(new URL("/api/state", instance.url), {
            headers: browserHeaders,
        });
        const state = await stateResponse.json();
        const rendererBaseUri = state.rendererBaseUri;
        const rendererResponse = await fetch(new URL("/renderer.html", rendererBaseUri));
        const rendererCsp = rendererResponse.headers.get("content-security-policy") || "";
        assert.match(rendererCsp, /img-src 'self' data: blob:/);
        assert.match(rendererCsp, /media-src 'self' blob:/);
        assert.match(rendererCsp, /connect-src 'none'/);

        const denied = await fetch(new URL(
            `/remote-content?url=${encodeURIComponent("https://example.com/pixel.png")}`,
            rendererBaseUri,
        ));
        assert.equal(denied.status, 403);

        const grantResponse = await fetch(new URL("/api/remote-content/allow", instance.url), {
            method: "POST",
            headers: {
                ...browserHeaders,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ documentId: instance.state.doc.remoteContentId }),
        });
        assert.equal(grantResponse.status, 200);
        const grant = await grantResponse.json();
        assert.ok(grant.doc.remoteContentToken);

        const privateResponse = await fetch(new URL(
            `/remote-content?token=${encodeURIComponent(grant.doc.remoteContentToken)}` +
                `&url=${encodeURIComponent("http://127.0.0.1/private.png")}`,
            rendererBaseUri,
        ));
        assert.equal(privateResponse.status, 403);

        const secondMarkdownPath = path.join(temp, "second.md");
        await fs.writeFile(secondMarkdownPath, "![other](https://example.com/other.png)\n", "utf8");
        await instance.openTarget(secondMarkdownPath);
        const staleGrantResponse = await fetch(new URL(
            `/remote-content?token=${encodeURIComponent(grant.doc.remoteContentToken)}` +
                `&url=${encodeURIComponent("https://example.com/pixel.png")}`,
            rendererBaseUri,
        ));
        assert.equal(staleGrantResponse.status, 403);

        const crossOriginGrant = await fetch(new URL("/api/remote-content/allow", instance.url), {
            method: "POST",
            headers: {
                ...browserHeaders,
                "Content-Type": "application/json",
                Origin: "https://attacker.example",
            },
            body: JSON.stringify({ documentId: instance.state.doc.remoteContentId }),
        });
        assert.equal(crossOriginGrant.status, 403);
    } finally {
        await instance?.dispose();
        if (previousHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousHome;
        await fs.rm(temp, { recursive: true, force: true });
    }
});
