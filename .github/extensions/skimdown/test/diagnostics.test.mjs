import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    DIAG_RATE_LIMIT,
    DIAG_SCHEMA_VERSION,
    DIAG_SEGMENT_MAX_BYTES,
    DiagnosticValidationError,
    createDiagnosticRateLimiter,
    validateDiagnostic,
} from "../lib/diagnostics.mjs";
import { appendDiag, diagArchiveFile, diagFile } from "../lib/paths.mjs";
import { createInstance } from "../lib/server.mjs";

test("diagnostic schema accepts known fields and rejects arbitrary data", () => {
    const diagnostic = validateDiagnostic({
        from: "shell",
        reason: "handshake-failed",
        nested: true,
        retried: false,
        logs: ["renderer did not answer"],
        readyState: "complete",
        bodyChildren: 2,
        hasBridge: true,
        bridge: {
            version: 3,
            isReady: false,
            install: {
                strategy: "define-on-chrome",
                failures: [],
                hadChrome: true,
                hadWebview: true,
            },
        },
    });
    assert.equal(diagnostic.reason, "handshake-failed");
    assert.equal("logs" in diagnostic, false);
    assert.equal("failures" in diagnostic.bridge.install, false);
    assert.equal(diagnostic.bridge.install.failureCount, 0);

    assert.throws(
        () => validateDiagnostic({
            from: "shell",
            reason: "shell-boot",
            userAgent: "not retained",
        }),
        DiagnosticValidationError,
    );
    assert.throws(
        () => validateDiagnostic({
            from: "renderer",
            reason: "renderer-never-ready",
            errors: ["x".repeat(257)],
        }),
        DiagnosticValidationError,
    );
});

test("diagnostic rate limiter returns a retry delay after the configured burst", () => {
    let now = 1000;
    const limiter = createDiagnosticRateLimiter({ limit: 2, windowMs: 100, now: () => now });

    assert.equal(limiter.take().allowed, true);
    assert.equal(limiter.take().allowed, true);
    const limited = limiter.take();
    assert.equal(limited.allowed, false);
    assert.equal(limited.retryAfterMs, 100);

    now += 100;
    assert.equal(limiter.take().allowed, true);
});

test("diagnostic persistence rotates within the aggregate byte cap", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "skimdown-diag-"));
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    try {
        await mkdir(path.dirname(diagFile()), { recursive: true });
        await writeFile(diagFile(), JSON.stringify({
            href: "https://example.test/private.md",
            userAgent: "legacy",
        }) + "\n");

        for (let index = 0; index < 24; index += 1) {
            assert.equal(await appendDiag({
                schemaVersion: DIAG_SCHEMA_VERSION,
                at: new Date(index * 1000).toISOString(),
                index,
                payload: "x".repeat(4000),
            }), true);
        }

        const currentSize = (await stat(diagFile())).size;
        const archiveSize = (await stat(diagArchiveFile())).size;
        assert.ok(currentSize <= DIAG_SEGMENT_MAX_BYTES);
        assert.ok(archiveSize <= DIAG_SEGMENT_MAX_BYTES);
        assert.ok(currentSize + archiveSize <= DIAG_SEGMENT_MAX_BYTES * 2);

        for (const file of [diagFile(), diagArchiveFile()]) {
            const lines = (await readFile(file, "utf8")).trim().split("\n");
            for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
        }
        const combined = await Promise.all(
            [diagFile(), diagArchiveFile()].map((file) => readFile(file, "utf8")),
        );
        assert.equal(combined.join("").includes("example.test"), false);
    } finally {
        if (previousHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});

test("diagnostic API enforces capability, content, size, schema, and rate limits", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "skimdown-api-"));
    const previousHome = process.env.COPILOT_HOME;
    process.env.COPILOT_HOME = home;
    let instance;
    try {
        instance = await createInstance({
            instanceId: "diagnostic-test",
            sessionId: "diagnostic-test-session",
            workspacePath: home,
            log() {},
        });
        const canvasUrl = new URL(instance.url);
        const token = new URLSearchParams(canvasUrl.hash.slice(1)).get("capability");
        assert.equal(canvasUrl.search, "");
        const endpoint = new URL("/api/diag", canvasUrl);
        const validBody = { from: "shell", reason: "shell-boot", nested: false };

        const unauthorized = await postDiagnostic(endpoint, validBody);
        assert.equal(unauthorized.status, 401);

        const wrongType = await fetch(endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "text/plain",
                "X-SkimDown-Capability": token,
            },
            body: JSON.stringify(validBody),
        });
        assert.equal(wrongType.status, 415);

        const invalid = await postDiagnostic(endpoint, { ...validBody, userAgent: "blocked" }, token);
        assert.equal(invalid.status, 400);

        const oversized = await postDiagnostic(
            endpoint,
            { ...validBody, logs: ["x".repeat(13 * 1024)] },
            token,
        );
        assert.equal(oversized.status, 413);

        const accepted = await postDiagnostic(endpoint, {
            ...validBody,
            logs: ["https://example.test/private/document.md"],
        }, token);
        assert.equal(accepted.status, 200);
        assert.deepEqual(await accepted.json(), { ok: true });

        const persisted = (await readFile(diagFile(), "utf8")).trim().split("\n").map(JSON.parse);
        assert.equal(persisted.at(-1).reason, "shell-boot");
        assert.equal(persisted.at(-1).schemaVersion, DIAG_SCHEMA_VERSION);
        assert.equal("userAgent" in persisted.at(-1), false);
        assert.equal("logs" in persisted.at(-1), false);
        assert.equal(JSON.stringify(persisted.at(-1)).includes("example.test"), false);

        let limited;
        for (let index = 0; index < DIAG_RATE_LIMIT; index += 1) {
            const response = await postDiagnostic(endpoint, validBody, token);
            if (response.status === 429) {
                limited = response;
                break;
            }
        }
        assert.ok(limited);
        assert.ok(Number(limited.headers.get("retry-after")) >= 1);
    } finally {
        await instance?.dispose();
        if (previousHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});

test("diagnostic persistence stays bounded across concurrent processes", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "skimdown-concurrent-"));
    const pathsUrl = pathToFileURL(
        path.resolve(".github/extensions/skimdown/lib/paths.mjs"),
    ).href;
    const diagnosticsUrl = pathToFileURL(
        path.resolve(".github/extensions/skimdown/lib/diagnostics.mjs"),
    ).href;
    const script = `
        import { appendDiag } from ${JSON.stringify(pathsUrl)};
        import { DIAG_SCHEMA_VERSION } from ${JSON.stringify(diagnosticsUrl)};
        for (let index = 0; index < 16; index += 1) {
            const ok = await appendDiag({
                schemaVersion: DIAG_SCHEMA_VERSION,
                at: new Date().toISOString(),
                process: process.pid,
                index,
                payload: "x".repeat(4000),
            });
            if (!ok) process.exitCode = 1;
        }
    `;

    try {
        await Promise.all([
            runNodeModule(script, home),
            runNodeModule(script, home),
            runNodeModule(script, home),
        ]);

        const currentSize = (await stat(path.join(
            home,
            "extensions",
            "skimdown",
            "artifacts",
            "diag.jsonl",
        ))).size;
        const archiveSize = (await stat(path.join(
            home,
            "extensions",
            "skimdown",
            "artifacts",
            "diag.1.jsonl",
        ))).size;
        assert.ok(currentSize <= DIAG_SEGMENT_MAX_BYTES);
        assert.ok(archiveSize <= DIAG_SEGMENT_MAX_BYTES);
        assert.ok(currentSize + archiveSize <= DIAG_SEGMENT_MAX_BYTES * 2);
    } finally {
        await rm(home, { recursive: true, force: true });
    }
});

function postDiagnostic(endpoint, body, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers["X-SkimDown-Capability"] = token;
    return fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
}

function runNodeModule(script, copilotHome) {
    return new Promise((resolve, reject) => {
        const child = spawn(
            process.execPath,
            ["--input-type=module", "--eval", script],
            {
                env: { ...process.env, COPILOT_HOME: copilotHome },
                stdio: ["ignore", "ignore", "pipe"],
            },
        );
        let stderr = "";
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", (chunk) => {
            stderr += chunk;
        });
        child.once("error", reject);
        child.once("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`child process exited with ${code}: ${stderr}`));
        });
    });
}
