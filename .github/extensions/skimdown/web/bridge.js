/* SkimDown canvas bridge.
 *
 * `renderer.js` is copied byte-for-byte from SkimDown for Windows, where it
 * talks to the WinUI host through WebView2's `window.chrome.webview`. Inside a
 * GitHub Copilot app canvas there is no WebView2 host, so this shim provides
 * the same two-method surface backed by the parent shell document.
 *
 * Transport: `renderer.html` is loaded from a *relative* URL, so this frame is
 * always same-origin with the shell. That means the two documents can call
 * each other's functions directly, which is strictly more reliable than
 * `postMessage`: nothing depends on a listener already being attached, on
 * `targetOrigin` matching, or on the message surviving a frame swap. A lost
 * handshake here leaves the preview permanently blank, so `postMessage` is
 * kept only as a fallback for the case where the direct handle is missing.
 *
 * Calls are still dispatched asynchronously (`setTimeout(..., 0)`) so that
 * `renderer.js` observes exactly the ordering and re-entrancy it would get
 * from a real `postMessage`.
 *
 * Envelope (fallback path only): { __skim: true, payload: <renderer message> }
 *
 * This file must execute before `renderer.js`, which is why it is a plain
 * (non-deferred) script placed ahead of the deferred renderer in
 * renderer.html. Being first also lets it capture boot-time errors thrown by
 * the vendor bundles.
 */

(function () {
    "use strict";

    var listeners = [];
    var SHELL_ORIGIN = window.location.origin;
    // renderer.js announces itself exactly once. Remember it so the shell can
    // ask after the fact ("was it ready?") instead of relying on catching a
    // one-shot notification at the right moment.
    var lastReady = null;
    var errors = [];

    // ---------- diagnostics ----------

    function recordError(text) {
        if (errors.length >= 12) return;
        errors.push(String(text).slice(0, 400));
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
            href: location.href,
            origin: SHELL_ORIGIN,
            readySent: !!lastReady,
            listeners: listeners.length,
            directHandle: directShellReceiver() ? "function" : "missing",
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
            fetch("/api/diag", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(snapshot(reason)),
            }).catch(function () {
                // Diagnostics must never break the renderer.
            });
        } catch (e) {
            // Ditto.
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
        if (ev.origin !== SHELL_ORIGIN) return;
        var envelope = ev.data;
        if (!envelope || typeof envelope !== "object" || envelope.__skim !== true) return;
        deliver(envelope.payload);
    });

    // ---------- outbound (renderer -> shell) ----------

    function directShellReceiver() {
        try {
            var parentWindow = window.parent;
            if (!parentWindow || parentWindow === window) return null;
            var receive = parentWindow.__skimShellReceive;
            return typeof receive === "function" ? receive : null;
        } catch (e) {
            // Cross-origin or detached parent: fall back to postMessage.
            return null;
        }
    }

    function post(payload) {
        var receive = directShellReceiver();
        if (receive) {
            setTimeout(function () {
                try {
                    receive(payload);
                } catch (e) {
                    recordError("direct post failed: " + (e && e.message ? e.message : e));
                }
            }, 0);
            return;
        }
        try {
            window.parent.postMessage({ __skim: true, payload: payload }, SHELL_ORIGIN);
        } catch (e) {
            recordError("postMessage failed: " + (e && e.message ? e.message : e));
            console.warn("skimdown bridge post failed", e);
        }
    }

    // ---------- WebView2-compatible surface ----------

    window.chrome = window.chrome || {};
    window.chrome.webview = {
        postMessage: function (payload) {
            if (payload && payload.type === "ready") lastReady = payload;
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

    // The shell reads this directly (same-origin) to drive the renderer and to
    // interrogate a failed boot without needing any message to get through.
    window.__skimBridge = {
        version: 2,
        deliver: deliver,
        isReady: function () {
            return !!lastReady;
        },
        errors: errors,
        snapshot: snapshot,
        beacon: beacon,
    };
})();
