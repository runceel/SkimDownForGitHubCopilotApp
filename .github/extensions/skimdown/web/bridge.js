/* SkimDown canvas bridge.
 *
 * `renderer.js` is based on SkimDown for Windows, where it talks to the WinUI
 * host through WebView2's `window.chrome.webview`. Inside a
 * GitHub Copilot app canvas that host is gone, so this shim provides the same
 * two-method surface backed by the parent shell document instead.
 *
 * Note that the app itself is *also* WebView2-based, so `chrome.webview`
 * already exists here and belongs to someone else — see the installer at the
 * bottom of this file, which is why taking that name is not a plain assignment.
 *
 * Transport: renderer assets live on a dedicated loopback origin and the frame
 * is sandboxed by the parent shell. Communication is therefore limited to a
 * source- and origin-checked `postMessage` envelope. The shell repeats an
 * idempotent hello probe, so readiness does not depend on a one-shot message.
 *
 * Calls are still dispatched asynchronously (`setTimeout(..., 0)`) so that
 * `renderer.js` observes exactly the ordering and re-entrancy it would get
 * from a real `postMessage`.
 *
 * Envelope: { __skim: true, payload: <renderer message> }
 *
 * This file must execute before `renderer.js`, which is why it is a plain
 * (non-deferred) script placed ahead of the deferred renderer in
 * renderer.html. Being first also lets it capture boot-time errors thrown by
 * the vendor bundles.
 */

(function () {
    "use strict";

    var listeners = [];
    var RENDERER_ORIGIN = window.location.origin;
    var SHELL_ORIGIN = readShellOrigin();
    // renderer.js announces itself exactly once. Remember it so the shell can
    // ask after the fact ("was it ready?") instead of relying on catching a
    // one-shot notification at the right moment.
    var lastReady = null;
    var errors = [];

    function readShellOrigin() {
        try {
            var value = new URLSearchParams(window.location.search).get("parentOrigin");
            var parsed = new URL(value);
            if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") return "";
            if (parsed.origin === RENDERER_ORIGIN) return "";
            return parsed.origin;
        } catch (e) {
            return "";
        }
    }

    // ---------- diagnostics ----------

    function recordError(text) {
        if (errors.length >= 12) return;
        errors.push(String(text).slice(0, 256));
    }

    // Registered before every other script in the document, so this sees the
    // vendor bundles and renderer.js fail rather than losing the reason.
    window.addEventListener("error", function (ev) {
        if (ev && ev.target && ev.target !== window && ev.target.src) {
            recordError("asset failed: " + ev.target.src);
            return;
        }
        recordError("error: " + ((ev && ev.message) || "?") +
            " @" + ((ev && ev.filename) || "?") + ":" + ((ev && ev.lineno) || 0));
    }, true);

    window.addEventListener("unhandledrejection", function (ev) {
        var reason = ev && ev.reason;
        recordError("unhandledrejection: " + ((reason && reason.message) || reason));
    });

    function snapshot(reason) {
        var content = document.getElementById("content");
        return {
            from: "renderer",
            reason: reason,
            readySent: !!lastReady,
            listeners: listeners.length,
            install: installReport,
            readyState: document.readyState,
            bodyChildren: document.body ? document.body.children.length : -1,
            contentChildren: content ? content.children.length : -1,
            vendors: {
                markdownit: typeof window.markdownit,
                hljs: typeof window.hljs,
                DOMPurify: typeof window.DOMPurify,
                katex: typeof window.katex,
                mermaid: typeof window.mermaid,
            },
            errors: errors.slice(0, 8),
        };
    }

    function beacon(reason) {
        try {
            post({ type: "diagnostic", report: snapshot(reason) });
        } catch (e) {
            // Diagnostics must never break the renderer.
        }
    }

    // If the handshake never happened the shell shows a dead bar with no idea
    // why; this report is the only way the extension process can find out.
    setTimeout(function () {
        if (lastReady && errors.length === 0) return;
        beacon(lastReady ? "renderer-ready-with-errors" : "renderer-never-ready");
    }, 3500);

    // ---------- inbound (shell -> renderer) ----------

    function fanOut(payload) {
        var synthetic = { data: payload }; // WebView2 shape: renderer.js reads `.data`.
        for (var i = 0; i < listeners.length; i++) {
            try {
                listeners[i](synthetic);
            } catch (e) {
                // One bad listener must not stop the others.
                recordError("listener failed: " + (e && e.message ? e.message : e));
                console.warn("skimdown bridge listener failed", e);
            }
        }
    }

    function deliver(payload) {
        // `hello` is a shell-only handshake probe; renderer.js knows nothing
        // about it, so answer here instead of forwarding.
        if (payload && payload.type === "hello") {
            if (lastReady) post(lastReady);
            return;
        }
        setTimeout(function () {
            fanOut(payload);
        }, 0);
    }

    window.addEventListener("message", function (ev) {
        if (ev.source !== window.parent) return;
        if (!SHELL_ORIGIN) return;
        if (ev.origin !== SHELL_ORIGIN) return;
        var envelope = ev.data;
        if (!envelope || typeof envelope !== "object" || envelope.__skim !== true) return;
        deliver(envelope.payload);
    });

    // ---------- outbound (renderer -> shell) ----------

    function post(payload) {
        if (!SHELL_ORIGIN) return;
        try {
            window.parent.postMessage({ __skim: true, payload: payload }, SHELL_ORIGIN);
        } catch (e) {
            recordError("postMessage failed: " + (e && e.message ? e.message : e));
            console.warn("skimdown bridge post failed", e);
        }
    }

    // ---------- WebView2-compatible surface ----------

    /* renderer.js reaches its host through `window.chrome.webview`, so the shim
     * has to occupy that exact name.
     *
     * In a plain browser the name is free and `window.chrome.webview = {...}`
     * works. Inside the GitHub Copilot app it does not: the canvas is rendered
     * by a real WebView2, which has already installed the *app's* bridge there
     * as a getter-only accessor. Assigning to it throws a TypeError under
     * `"use strict"`, and that used to abort this entire module. renderer.js
     * then found the app's bridge instead of ours, and its `ready` was posted to
     * the app rather than to the shell. The preview stayed blank until the shell
     * gave up.
     *
     * So: define rather than assign, fall through progressively blunter
     * strategies, and never throw. `installReport` records what happened; the
     * shell surfaces it when a handshake fails. */

    var webviewShim = {
        postMessage: function (payload) {
            if (payload && payload.type === "ready") {
                lastReady = payload;
                post(payload);
                beacon("bridge-installed");
                return;
            }
            post(payload);
        },
        addEventListener: function (type, callback) {
            if (type !== "message" || typeof callback !== "function") return;
            listeners.push(callback);
        },
        removeEventListener: function (type, callback) {
            if (type !== "message") return;
            var idx = listeners.indexOf(callback);
            if (idx >= 0) listeners.splice(idx, 1);
        },
    };

    function defineValue(target, name, value) {
        Object.defineProperty(target, name, {
            value: value,
            writable: true,
            enumerable: true,
            configurable: true,
        });
    }

    /** True once `window.chrome.webview` is the object renderer.js should use. */
    function shimInstalled() {
        try {
            var webview = window.chrome && window.chrome.webview;
            return !!webview && webview.postMessage === webviewShim.postMessage;
        } catch (e) {
            return false;
        }
    }

    function describeProperty(target, name) {
        try {
            if (!target) return "no-target";
            var desc = Object.getOwnPropertyDescriptor(target, name);
            if (!desc) return "absent";
            return (desc.get ? "getter" : "value")
                + (desc.set ? "+setter" : "")
                + (desc.writable ? " writable" : "")
                + (desc.configurable ? " configurable" : " non-configurable");
        } catch (e) {
            return "descriptor-error:" + (e && e.name);
        }
    }

    function installWebviewShim() {
        var report = { strategy: null, failures: [] };
        try {
            report.hadChrome = !!window.chrome;
            report.hadWebview = !!(window.chrome && window.chrome.webview);
            report.chromeProperty = describeProperty(window, "chrome");
            report.webviewProperty = describeProperty(window.chrome, "webview");
        } catch (e) {
            report.probeError = e && e.name;
        }

        function attempt(name, apply) {
            if (report.strategy) return;
            try {
                apply();
            } catch (e) {
                report.failures.push((name + ": " + ((e && e.message) || e)).slice(0, 256));
                return;
            }
            if (shimInstalled()) report.strategy = name;
            else report.failures.push((name + ": no effect").slice(0, 256));
        }

        // 1. The ordinary case: `webview` is absent, or present but replaceable.
        attempt("define-on-chrome", function () {
            if (!window.chrome) defineValue(window, "chrome", {});
            defineValue(window.chrome, "webview", webviewShim);
        });

        // 2. `webview` is locked down: swap the whole `chrome` object for a copy
        //    carrying our shim.
        attempt("replace-chrome", function () {
            var next = {};
            var current = window.chrome;
            for (var key in current) {
                if (key === "webview") continue;
                try {
                    next[key] = current[key];
                } catch (e) {
                    // A throwing accessor is not worth carrying over.
                }
            }
            next.webview = webviewShim;
            defineValue(window, "chrome", next);
        });

        // 3. `chrome` is locked down too: patch the three methods renderer.js
        //    actually calls onto whatever object occupies the name.
        attempt("patch-webview", function () {
            var webview = window.chrome && window.chrome.webview;
            if (!webview) throw new Error("no webview object to patch");
            defineValue(webview, "postMessage", webviewShim.postMessage);
            defineValue(webview, "addEventListener", webviewShim.addEventListener);
            defineValue(webview, "removeEventListener", webviewShim.removeEventListener);
        });

        if (!report.strategy) {
            report.strategy = "failed";
            recordError("bridge install failed: " + report.failures.join(" | "));
        }
        return report;
    }

    var installReport = installWebviewShim();
    if (!SHELL_ORIGIN) recordError("invalid or missing parent origin");
})();
