/* SkimDown canvas bridge.
 *
 * `renderer.js` is copied byte-for-byte from SkimDown for Windows, where it
 * talks to the WinUI host through WebView2's `window.chrome.webview`. Inside a
 * GitHub Copilot app canvas there is no WebView2 host, so this shim provides
 * the same two-method surface backed by `postMessage` against the parent shell
 * document.
 *
 * The shell (`shell.html`) and this renderer are both served from the asset
 * origin, so `window.location.origin` is the correct target for every post and
 * we can reject anything that does not come from the parent frame.
 *
 * Envelope: { __skim: true, payload: <the message renderer.js expects> }
 *
 * This file must execute before `renderer.js`, which is why it is a plain
 * (non-deferred) script placed ahead of the deferred renderer in renderer.html.
 */

(function () {
    "use strict";

    var listeners = [];
    var SHELL_ORIGIN = window.location.origin;

    window.addEventListener("message", function (ev) {
        if (ev.source !== window.parent) return;
        if (ev.origin !== SHELL_ORIGIN) return;
        var envelope = ev.data;
        if (!envelope || typeof envelope !== "object" || envelope.__skim !== true) return;

        var payload = envelope.payload;
        // Deliver a WebView2-shaped event object. renderer.js only reads `.data`.
        var synthetic = { data: payload };
        for (var i = 0; i < listeners.length; i++) {
            try {
                listeners[i](synthetic);
            } catch (e) {
                // One bad listener must not stop the others.
                console.warn("skimdown bridge listener failed", e);
            }
        }
    });

    window.chrome = window.chrome || {};
    window.chrome.webview = {
        postMessage: function (payload) {
            try {
                window.parent.postMessage({ __skim: true, payload: payload }, SHELL_ORIGIN);
            } catch (e) {
                console.warn("skimdown bridge post failed", e);
            }
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
})();
