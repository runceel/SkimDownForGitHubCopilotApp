import assert from "node:assert/strict";
import test from "node:test";

import { LOG_LEVELS, createLogger, normalizeLogLevel } from "../lib/log.mjs";

/** Fails the test if the block leaves an unhandled rejection behind, which is
 *  what terminated the extension process before logging absorbed its own
 *  failures. */
async function assertNoUnhandledRejection(t, run) {
    const seen = [];
    const onUnhandled = (reason) => seen.push(reason);

    // Node's default handler terminates the process, so it is removed for the
    // duration of the check and restored afterwards.
    const existing = process.listeners("unhandledRejection");
    for (const listener of existing) process.off("unhandledRejection", listener);
    process.on("unhandledRejection", onUnhandled);

    t.after(() => {
        process.off("unhandledRejection", onUnhandled);
        for (const listener of existing) process.on("unhandledRejection", listener);
    });

    await run();
    // Rejections are delivered on a later turn than the one that created them.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(seen, [], "logging must not leave an unhandled rejection");
}

test("normalizeLogLevel keeps the severities the host accepts", () => {
    for (const level of LOG_LEVELS) {
        assert.equal(normalizeLogLevel(level), level);
    }
    assert.equal(normalizeLogLevel("WARNING"), "warning");
    assert.equal(normalizeLogLevel(" error "), "error");
});

test("normalizeLogLevel maps unsupported severities onto info", () => {
    // "debug" is the level that made the host reject the request.
    assert.equal(normalizeLogLevel("debug"), "info");
    assert.equal(normalizeLogLevel("trace"), "info");
    assert.equal(normalizeLogLevel(undefined), "info");
    assert.equal(normalizeLogLevel(null), "info");
    assert.equal(normalizeLogLevel(7), "info");
});

test("the logger never sends a severity the host rejects", () => {
    const calls = [];
    const log = createLogger(() => ({
        log(message, options) {
            calls.push({ message, options });
        },
    }));

    log("noisy", { level: "debug" });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].message, "noisy");
    assert.equal(calls[0].options.level, "info");
});

test("the logger forwards the severity chosen by the caller", () => {
    const calls = [];
    const log = createLogger(() => ({
        log(message, options) {
            calls.push({ message, options });
        },
    }));

    log("degraded", { level: "warning" });
    log("broken", { level: "error" });
    log("routine");

    assert.deepEqual(
        calls.map((call) => call.options.level),
        ["warning", "error", "info"],
    );
    // Log lines stay out of the transcript unless a caller opts in.
    assert.deepEqual(
        calls.map((call) => call.options.ephemeral),
        [true, true, true],
    );
});

test("a rejected log request does not reach the caller", async (t) => {
    await assertNoUnhandledRejection(t, async () => {
        const log = createLogger(() => ({
            log() {
                return Promise.reject(new Error("unsupported session log level: debug"));
            },
        }));

        assert.doesNotThrow(() => log("anything", { level: "warning" }));
    });
});

test("a log request that throws does not reach the caller", async (t) => {
    await assertNoUnhandledRejection(t, async () => {
        const log = createLogger(() => ({
            log() {
                throw new Error("transport closed");
            },
        }));

        assert.doesNotThrow(() => log("anything"));
    });
});

test("a host that rejects the options shape still receives the message", () => {
    const calls = [];
    const log = createLogger(() => ({
        log(message, options) {
            if (options !== undefined) throw new Error("options not supported");
            calls.push(message);
        },
    }));

    log("plain", { level: "error" });

    assert.deepEqual(calls, ["plain"]);
});

test("a retry that also fails does not reach the caller", async (t) => {
    await assertNoUnhandledRejection(t, async () => {
        const log = createLogger(() => ({
            log(message, options) {
                if (options !== undefined) throw new Error("options not supported");
                return Promise.reject(new Error("transport closed"));
            },
        }));

        assert.doesNotThrow(() => log("plain"));
    });
});

test("logging before the session exists is a no-op", () => {
    assert.doesNotThrow(() => createLogger(() => undefined)("early"));
    assert.doesNotThrow(() => createLogger(() => ({}))("no log method"));
    assert.doesNotThrow(() =>
        createLogger(() => {
            throw new Error("not joined yet");
        })("still starting"),
    );
});

test("non-string messages are sent as text", () => {
    const calls = [];
    const log = createLogger(() => ({
        log(message) {
            calls.push(message);
        },
    }));

    log(new Error("boom"));

    assert.equal(typeof calls[0], "string");
    assert.match(calls[0], /boom/);
});
