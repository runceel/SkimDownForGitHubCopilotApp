/* SkimDown canvas shell.
 *
 * Owns the chrome (source picker, file list, toolbar, find bar) and brokers
 * between three parties:
 *
 *   extension  <-- fetch / SSE -->  shell  <-- postMessage -->  renderer iframe
 *
 * The renderer follows SkimDown for Windows' WebView2 protocol, which bridge.js
 * maps onto postMessage. This port additionally enforces remote-content consent.
 * Theme tokens are only injected into this document, so we translate them into
 * SkimDown's --skim-* variables and hand them over as `themeVars`.
 */

(function () {
    "use strict";

    var ZOOM_MIN = 0.5;
    var ZOOM_MAX = 3.0;
    var ZOOM_STEP = 1.1;
    var CONTENT_WIDTHS = ["760px", "960px", "1200px", "none"];
    var CAPABILITY_TOKEN = new URLSearchParams(window.location.hash.slice(1)).get("token") || "";

    var el = {
        body: document.body,
        sourceSelect: document.getElementById("source-select"),
        filter: document.getElementById("filter"),
        tree: document.getElementById("tree"),
        count: document.getElementById("count"),
        sidebar: document.getElementById("sidebar"),
        resizer: document.getElementById("resizer"),
        viewModes: document.getElementById("view-modes"),
        btnViewTree: document.getElementById("btn-view-tree"),
        btnViewRecent: document.getElementById("btn-view-recent"),
        btnRefresh: document.getElementById("btn-refresh"),
        btnOpenPath: document.getElementById("btn-open-path"),
        btnSwapSidebar: document.getElementById("btn-swap-sidebar"),
        btnToggleSidebar: document.getElementById("btn-toggle-sidebar"),
        docTitle: document.getElementById("doc-title"),
        docSubtitle: document.getElementById("doc-subtitle"),
        btnOpenBrowser: document.getElementById("btn-open-browser"),
        btnFind: document.getElementById("btn-find"),
        btnZoomIn: document.getElementById("btn-zoom-in"),
        btnZoomOut: document.getElementById("btn-zoom-out"),
        btnZoomReset: document.getElementById("btn-zoom-reset"),
        btnWidth: document.getElementById("btn-width"),
        findbar: document.getElementById("findbar"),
        findInput: document.getElementById("find-input"),
        findCount: document.getElementById("find-count"),
        btnFindCase: document.getElementById("btn-find-case"),
        btnFindPrev: document.getElementById("btn-find-prev"),
        btnFindNext: document.getElementById("btn-find-next"),
        btnFindClose: document.getElementById("btn-find-close"),
        pathbar: document.getElementById("pathbar"),
        pathInput: document.getElementById("path-input"),
        btnPathOpen: document.getElementById("btn-path-open"),
        btnPathCancel: document.getElementById("btn-path-cancel"),
        linkbar: document.getElementById("linkbar"),
        remotebar: document.getElementById("remotebar"),
        remoteText: document.getElementById("remote-text"),
        btnRemoteLoad: document.getElementById("btn-remote-load"),
        deadbar: document.getElementById("deadbar"),
        deadbarText: document.getElementById("deadbar-text"),
        btnDeadReload: document.getElementById("btn-dead-reload"),
        linkText: document.getElementById("link-text"),
        btnLinkOpen: document.getElementById("btn-link-open"),
        btnLinkCancel: document.getElementById("btn-link-cancel"),
        preview: document.getElementById("preview"),
        emptyState: document.getElementById("empty-state"),
        toast: document.getElementById("toast"),
    };

    var state = {
        server: null,          // last `state` payload from the extension
        settings: null,
        doc: null,
        filter: "",
        expanded: new Set(),
        expandedRoot: null,
        search: { query: "", caseSensitive: false },
        pendingExternalHref: null,
        remoteContentFailures: 0,
        rendererOrigin: null,
        rendererReady: false,
        rendererQueue: [],
        visibleNodes: [],      // flat list of focusable sidebar buttons
    };

    // ---------- renderer messaging ----------

    var HANDSHAKE_GRACE_MS = 6000;
    var HANDSHAKE_POLL_MS = 250;
    var RENDERER_SHORTCUTS = new Set([
        "find",
        "find-next",
        "find-prev",
        "use-selection-for-find",
        "toggle-sidebar",
        "zoom-in",
        "zoom-out",
        "zoom-reset",
        "content-width-wider",
        "content-width-narrower",
        "select-all",
        "open-folder",
    ]);
    var handshakeTimer = 0;
    var handshakePoll = 0;
    var handshakeRetried = false;
    var rendererLogs = [];

    function ensureRendererFrame(baseUri) {
        var url;
        try {
            url = new URL("renderer.html", String(baseUri || ""));
            if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
                throw new Error("renderer origin must be loopback HTTP");
            }
            if (url.origin === window.location.origin) {
                throw new Error("renderer origin must differ from shell origin");
            }
        } catch (error) {
            showDeadBar(true, "プレビューの安全な接続先を初期化できませんでした。");
            reportDiag("renderer-origin-invalid");
            return false;
        }

        url.searchParams.set("parentOrigin", window.location.origin);
        if (state.rendererOrigin === url.origin && el.preview.src === url.href) return true;

        stopHandshakeWatch();
        state.rendererOrigin = url.origin;
        state.rendererReady = false;
        handshakeRetried = false;
        rendererLogs = [];
        el.preview.src = url.href;
        return true;
    }

    function deliverToRenderer(message) {
        var frame = el.preview.contentWindow;
        if (!frame || !state.rendererOrigin) return false;
        try {
            frame.postMessage({ __skim: true, payload: message }, state.rendererOrigin);
            return true;
        } catch (e) {
            return false;
        }
    }

    function postToRenderer(message) {
        if (!state.rendererReady) {
            state.rendererQueue.push(message);
            return;
        }
        deliverToRenderer(message);
    }

    function flushRendererQueue() {
        var queued = state.rendererQueue;
        state.rendererQueue = [];
        for (var i = 0; i < queued.length; i++) postToRenderer(queued[i]);
    }

    window.addEventListener("message", function (ev) {
        if (ev.source !== el.preview.contentWindow) return;
        if (!state.rendererOrigin || ev.origin !== state.rendererOrigin) return;
        if (!ev.data || ev.data.__skim !== true) return;
        if (!isRendererMessage(ev.data.payload)) return;
        handleRendererMessage(ev.data.payload);
    });

    function isRendererMessage(msg) {
        if (!msg || typeof msg !== "object") return false;
        switch (msg.type) {
            case "ready":
                return true;
            case "diagnostic":
                return !!msg.report && typeof msg.report === "object";
            case "log":
                return typeof msg.text === "string" && msg.text.length <= 256;
            case "link":
                return typeof msg.href === "string"
                    && msg.href.length <= 8192
                    && ["anchor", "external", "relative"].indexOf(msg.kind) >= 0;
            case "search/result":
                return Number.isFinite(msg.total) && Number.isFinite(msg.current);
            case "copy":
                return typeof msg.text === "string" && msg.text.length <= 2 * 1024 * 1024;
            case "shortcut":
                return RENDERER_SHORTCUTS.has(msg.id);
            case "zoomChanged":
                return Number.isFinite(msg.factor);
            case "remoteContent":
                return /^[a-f0-9]{64}$/.test(msg.documentId || "")
                    && Number.isInteger(msg.blocked) && msg.blocked >= 0 && msg.blocked <= 10000
                    && Number.isInteger(msg.proxied) && msg.proxied >= 0 && msg.proxied <= 10000
                    && Number.isInteger(msg.policyBlocked) && msg.policyBlocked >= 0 && msg.policyBlocked <= 10000
                    && Array.isArray(msg.hosts) && msg.hosts.length <= 8
                    && msg.hosts.every(function (host) {
                        return typeof host === "string" && host.length <= 255;
                    });
            case "remoteContent/error":
                return /^[a-f0-9]{64}$/.test(msg.documentId || "");
            default:
                return false;
        }
    }

    function describeRenderer() {
        return {
            retried: handshakeRetried,
            logs: rendererLogs.slice(0, 6)
        };
    }

    function rendererFailureHint() {
        if (rendererLogs.length) return rendererLogs[0];
        return "レンダラーの初期化が完了しませんでした";
    }

    function reportDiag(reason) {
        var payload = describeRenderer();
        payload.reason = reason;
        payload.from = "shell";
        payload.nested = window.parent !== window;
        // Best effort: diagnostics must never break the shell.
        api("/api/diag", payload).catch(noop);
    }

    function reportShellBoot() {
        api("/api/diag", {
            reason: "shell-boot",
            from: "shell",
            nested: window.parent !== window
        }).catch(noop);
    }

    function boundedText(value, length) {
        return typeof value === "string" ? value.slice(0, length) : "";
    }

    function reportRendererDiagnostic(report) {
        var errors = Array.isArray(report.errors)
            ? report.errors.slice(0, 8).map(function (value) { return boundedText(value, 256); })
            : [];
        for (var i = 0; i < errors.length; i++) recordRendererLog(errors[i], false);

        var install = report.install && typeof report.install === "object"
            ? {
                strategy: boundedText(report.install.strategy, 80),
                failures: Array.isArray(report.install.failures)
                    ? report.install.failures.slice(0, 8).map(function (value) {
                        return boundedText(value, 256);
                    })
                    : [],
            }
            : null;
        var vendors = report.vendors && typeof report.vendors === "object"
            ? {
                markdownit: boundedText(report.vendors.markdownit, 40),
                hljs: boundedText(report.vendors.hljs, 40),
                DOMPurify: boundedText(report.vendors.DOMPurify, 40),
                katex: boundedText(report.vendors.katex, 40),
                mermaid: boundedText(report.vendors.mermaid, 40),
            }
            : null;
        api("/api/diag", {
            reason: boundedText(report.reason, 80) || "renderer-diagnostic",
            from: "renderer",
            readySent: !!report.readySent,
            listeners: Number.isFinite(report.listeners) ? report.listeners : null,
            readyState: boundedText(report.readyState, 40),
            bodyChildren: Number.isFinite(report.bodyChildren) ? report.bodyChildren : null,
            contentChildren: Number.isFinite(report.contentChildren) ? report.contentChildren : null,
            vendors: vendors,
            install: install,
            errors: errors,
        }).catch(noop);
    }

    function stopHandshakeWatch() {
        if (handshakeTimer) {
            clearTimeout(handshakeTimer);
            handshakeTimer = 0;
        }
        if (handshakePoll) {
            clearInterval(handshakePoll);
            handshakePoll = 0;
        }
    }

    function watchHandshake() {
        stopHandshakeWatch();
        handshakePoll = setInterval(function () {
            postDirect({ type: "hello" });
        }, HANDSHAKE_POLL_MS);
        handshakeTimer = setTimeout(function () {
            if (state.rendererReady) return;
            if (!handshakeRetried) {
                handshakeRetried = true;
                reportDiag("handshake-timeout-retrying");
                el.preview.src = el.preview.src;
                watchHandshake();
                return;
            }
            stopHandshakeWatch();
            reportDiag("handshake-failed");
            var hint = rendererFailureHint();
            showDeadBar(true, hint
                ? "プレビューを初期化できませんでした: " + hint
                : "プレビューを初期化できませんでした。");
        }, HANDSHAKE_GRACE_MS);
    }

    el.preview.addEventListener("load", function () {
        if (!state.rendererOrigin || state.rendererReady) return;
        postDirect({ type: "hello" });
        watchHandshake();
    });

    function postDirect(message) {
        deliverToRenderer(message);
    }

    function recordRendererLog(text, persist) {
        var line = String(text == null ? "" : text).slice(0, 256);
        if (!line) return;
        if (rendererLogs.indexOf(line) < 0) rendererLogs.push(line);
        if (rendererLogs.length > 12) rendererLogs.shift();
        if (persist !== false) reportDiag("renderer-log");
    }

    function handleRendererMessage(msg) {
        switch (msg.type) {
            case "ready":
                state.rendererReady = true;
                stopHandshakeWatch();
                showDeadBar(false);
                pushThemeToRenderer();
                pushSettingsToRenderer();
                flushRendererQueue();
                if (state.doc) pushDocToRenderer(state.doc);
                break;
            case "diagnostic":
                reportRendererDiagnostic(msg.report);
                break;
            case "log":
                recordRendererLog(msg.text);
                break;
            case "link":
                handleLinkMessage(msg);
                break;
            case "search/result":
                renderFindCount(msg.total, msg.current);
                break;
            case "copy":
                copyText(msg.text);
                break;
            case "shortcut":
                handleShortcut(msg.id);
                break;
            case "zoomChanged":
                applyZoom(msg.factor, { fromRenderer: true });
                break;
            case "remoteContent":
                handleRemoteContentMessage(msg);
                break;
            case "remoteContent/error":
                handleRemoteContentError(msg);
                break;
            default:
                break;
        }
    }

    function pushDocToRenderer(doc) {
        var theme = buildThemeMessage();
        syncShellColorScheme(theme.themeIsDark);
        postToRenderer({
            type: "render",
            markdown: doc.markdown || "",
            sourcePath: doc.sourcePath || "",
            contentBaseUri: doc.contentBaseUri || "",
            remoteContentId: doc.remoteContentId || "",
            remoteContentToken: doc.remoteContentToken || "",
            theme: theme.theme,
            themeType: theme.themeType,
            themeIsDark: theme.themeIsDark,
            themeVars: theme.themeVars,
        });
        if (state.search.query) {
            postToRenderer({
                type: "search",
                query: state.search.query,
                caseSensitive: state.search.caseSensitive,
            });
        }
    }

    // ---------- theme ----------

    var colorProbe = document.createElement("span");
    colorProbe.setAttribute("aria-hidden", "true");
    colorProbe.style.cssText = "position:absolute;width:0;height:0;visibility:hidden";
    document.body.appendChild(colorProbe);

    var SENTINEL = "rgb(1, 2, 3)";

    // Colors are normalised through a 1x1 canvas rather than a regex. The app
    // theme is free to use any CSS color syntax (`oklch()`, `color-mix()`,
    // `lab()`, …), and `getComputedStyle` preserves those spaces instead of
    // converting to `rgb()`. Parsing the text therefore fails for perfectly
    // valid colors — and because CSS itself resolves them, the shell chrome
    // looks right while the renderer silently falls back to a wrong theme.
    var normCanvas = document.createElement("canvas");
    normCanvas.width = 1;
    normCanvas.height = 1;
    var normCtx = normCanvas.getContext("2d", { willReadFrequently: true });

    function toRgb(cssText) {
        if (typeof cssText !== "string" || cssText.trim().length === 0) return null;
        if (!normCtx) return parseColor(cssText);
        try {
            normCtx.globalCompositeOperation = "copy";
            // Two probes: an invalid value leaves `fillStyle` untouched, so a
            // color that matches both sentinels cannot be trusted.
            normCtx.fillStyle = "#000000";
            normCtx.fillStyle = cssText;
            var first = normCtx.fillStyle;
            normCtx.fillStyle = "#ffffff";
            normCtx.fillStyle = cssText;
            if (normCtx.fillStyle !== first) return null;

            normCtx.fillRect(0, 0, 1, 1);
            var d = normCtx.getImageData(0, 0, 1, 1).data;
            return { r: d[0], g: d[1], b: d[2], a: d[3] / 255 };
        } catch (e) {
            return parseColor(cssText);
        }
    }

    /**
     * Resolve an app theme token to concrete RGB. The `var()` indirection is
     * evaluated by CSS (so a missing token falls back automatically) and the
     * result is normalised through the canvas, which understands every color
     * syntax the browser does.
     */
    function readResolved(name, fallbackCss) {
        colorProbe.style.color = SENTINEL;
        colorProbe.style.color = "var(" + name + ", " + fallbackCss + ")";
        var computed = window.getComputedStyle(colorProbe).color;
        if (!computed || computed === SENTINEL) return toRgb(fallbackCss);
        return toRgb(computed) || toRgb(fallbackCss);
    }

    function parseColor(text) {
        var match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i.exec(text);
        if (!match) return null;
        var alpha = 1;
        if (match[4] !== undefined) {
            alpha = match[4].indexOf("%") >= 0
                ? parseFloat(match[4]) / 100
                : parseFloat(match[4]);
        }
        return {
            r: parseFloat(match[1]),
            g: parseFloat(match[2]),
            b: parseFloat(match[3]),
            a: isFinite(alpha) ? alpha : 1,
        };
    }

    function hexColor(hex) {
        var clean = hex.replace("#", "");
        return {
            r: parseInt(clean.slice(0, 2), 16),
            g: parseInt(clean.slice(2, 4), 16),
            b: parseInt(clean.slice(4, 6), 16),
            a: 1,
        };
    }

    /** Composite a possibly translucent color over an opaque backdrop. */
    function flatten(color, backdrop) {
        if (!color) return backdrop;
        if (color.a >= 1) return { r: color.r, g: color.g, b: color.b, a: 1 };
        var a = color.a;
        return {
            r: color.r * a + backdrop.r * (1 - a),
            g: color.g * a + backdrop.g * (1 - a),
            b: color.b * a + backdrop.b * (1 - a),
            a: 1,
        };
    }

    function mix(front, back, ratio) {
        return {
            r: front.r * ratio + back.r * (1 - ratio),
            g: front.g * ratio + back.g * (1 - ratio),
            b: front.b * ratio + back.b * (1 - ratio),
            a: 1,
        };
    }

    function toCss(color) {
        return "rgb(" + Math.round(color.r) + ", " + Math.round(color.g) + ", " + Math.round(color.b) + ")";
    }

    function readAttr(name) {
        var root = document.documentElement;
        var body = document.body;
        return (
            (root && root.getAttribute(name)) ||
            (body && body.getAttribute(name)) ||
            ""
        );
    }

    function luminance(color) {
        return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
    }

    function isDarkTone() {
        // The host may set these on either the root element or the body.
        var tone = readAttr("data-theme-tone") || readAttr("data-color-mode");
        if (tone.indexOf("dark") >= 0) return true;
        if (tone.indexOf("light") >= 0) return false;
        // No usable attribute: fall back to the luminance of what the shell is
        // actually painted with, which the browser has already resolved.
        var painted = toRgb(window.getComputedStyle(document.body).backgroundColor);
        var bg = painted && painted.a > 0 ? painted : readResolved("--background-color-default", "#ffffff");
        return luminance(bg) < 128;
    }

    function buildThemeMessage() {
        var dark = isDarkTone();
        var defaults = dark
            ? { bg: "#0d1117", fg: "#e6edf3", link: "#4493f8" }
            : { bg: "#ffffff", fg: "#1f2328", link: "#0969da" };

        // `readResolved` lets CSS apply the fallback when a token is missing and
        // normalises whatever color syntax the theme uses, so every value below
        // is guaranteed usable — no null handling, and no silent collapse onto
        // the background that would render the text invisible.
        var bg = flatten(readResolved("--background-color-default", defaults.bg), hexColor(defaults.bg));
        var fg = flatten(readResolved("--text-color-default", defaults.fg), bg);
        var muted = flatten(readResolved("--text-color-muted", toCss(mix(fg, bg, 0.65))), bg);
        var border = flatten(readResolved("--border-color-default", toCss(mix(fg, bg, 0.2))), bg);
        var link = flatten(readResolved("--true-color-blue", defaults.link), bg);

        // A theme that resolves foreground and background to the same color
        // would render the document invisible; prefer the known-good defaults.
        if (Math.abs(luminance(fg) - luminance(bg)) < 24) {
            bg = hexColor(defaults.bg);
            fg = hexColor(defaults.fg);
            muted = mix(fg, bg, 0.65);
            border = mix(fg, bg, 0.2);
            link = hexColor(defaults.link);
        }

        return {
            theme: "custom",
            themeType: dark ? "dark" : "light",
            themeIsDark: dark,
            themeVars: {
                "--skim-bg": toCss(bg),
                "--skim-fg": toCss(fg),
                "--skim-muted": toCss(muted),
                "--skim-blockquote": toCss(muted),
                "--skim-border": toCss(border),
                "--skim-soft": toCss(mix(fg, bg, 0.04)),
                "--skim-soft-strong": toCss(mix(fg, bg, 0.1)),
                "--skim-code-bg": toCss(mix(fg, bg, 0.06)),
                "--skim-table-stripe": toCss(mix(fg, bg, 0.035)),
                "--skim-link": toCss(link),
                "--skim-mark-bg": dark ? "rgba(255, 212, 59, 0.4)" : "#fff5b1",
                "--skim-mark-current-bg": dark ? "rgba(255, 212, 59, 0.8)" : "#ffd33d",
                // The canvas panel is much narrower than a desktop window, so
                // the reading gutter is tightened relative to SkimDown's.
                "--skim-pad": "clamp(12px, 3.5vw, 40px)",
            },
        };
    }

    /**
     * Native widgets (the source `<select>`, the filter field, scrollbars) only
     * follow the app theme when `color-scheme` matches, and the host does not
     * set it for us. Guarded so it never re-triggers the theme observer.
     */
    var appliedColorScheme = "";

    function syncShellColorScheme(dark) {
        var scheme = dark ? "dark" : "light";
        if (scheme === appliedColorScheme) return;
        appliedColorScheme = scheme;
        document.documentElement.style.colorScheme = scheme;
    }

    function pushThemeToRenderer() {
        var theme = buildThemeMessage();
        syncShellColorScheme(theme.themeIsDark);
        postToRenderer({
            type: "theme",
            theme: theme.theme,
            themeType: theme.themeType,
            themeIsDark: theme.themeIsDark,
            themeVars: theme.themeVars,
        });
    }

    var themeObserver = new MutationObserver(function () {
        pushThemeToRenderer();
    });
    themeObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["data-color-mode", "data-theme-tone", "data-dark-theme", "data-light-theme", "style", "class"],
    });

    // ---------- server transport ----------

    function api(path, body) {
        var headers = { "X-SkimDown-Capability": CAPABILITY_TOKEN };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        return fetch(path, {
            method: body === undefined ? "GET" : "POST",
            headers: headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        }).then(function (res) {
            return res.json().catch(function () {
                return {};
            }).then(function (json) {
                if (!res.ok) throw new Error(json && json.error ? json.error : "リクエストに失敗しました");
                return json;
            });
        });
    }

    function connectEvents() {
        var events = new EventSource("/events?token=" + encodeURIComponent(CAPABILITY_TOKEN));
        var failures = 0;

        events.addEventListener("open", function () {
            failures = 0;
            showDeadBar(false);
        });
        // The browser retries an SSE stream forever. When the extension has been
        // reloaded the old port is gone for good — the host reloads this iframe
        // against the new URL — so give up after a few tries instead of
        // hammering a dead socket, and say so plainly.
        events.addEventListener("error", function () {
            if (events.readyState === EventSource.CLOSED) {
                showDeadBar(true);
                return;
            }
            failures += 1;
            if (failures >= 5) {
                events.close();
                showDeadBar(true);
            }
        });
        events.addEventListener("state", function (ev) {
            applyServerState(JSON.parse(ev.data));
        });
        events.addEventListener("doc", function (ev) {
            var doc = JSON.parse(ev.data);
            state.doc = doc;
            resetRemoteContentUi();
            renderDocHeader(doc);
            el.emptyState.hidden = true;
            pushDocToRenderer(doc);
        });
        events.addEventListener("empty", function () {
            state.doc = null;
            resetRemoteContentUi();
            renderDocHeader(null);
            el.emptyState.hidden = false;
            postToRenderer({ type: "empty" });
        });
        events.addEventListener("settings", function (ev) {
            state.settings = JSON.parse(ev.data);
            applySettings(state.settings);
        });
    }

    function applyServerState(payload) {
        state.server = payload;
        if (!ensureRendererFrame(payload.rendererBaseUri)) return;
        if (payload.settings) {
            var settingsChanged = !state.settings;
            state.settings = payload.settings;
            applySettings(payload.settings, settingsChanged);
        }
        syncExpandedRoot(payload);
        renderSources(payload);
        renderSidebar();
    }

    function syncExpandedRoot(payload) {
        var root = payload.listing && payload.listing.root ? payload.listing.root : null;
        if (root === state.expandedRoot) return;
        state.expandedRoot = root;
        var stored = root && state.settings && state.settings.expanded
            ? state.settings.expanded[root]
            : null;
        state.expanded = new Set(Array.isArray(stored) ? stored : []);
    }

    function persistExpanded() {
        if (!state.expandedRoot) return;
        api("/api/expanded", { root: state.expandedRoot, expanded: Array.from(state.expanded) }).catch(noop);
    }

    // ---------- settings ----------

    function applySettings(settings, initial) {
        el.body.dataset.sidebar = settings.sidebarVisible ? "visible" : "hidden";
        el.body.dataset.sidebarPosition = settings.sidebarPosition;
        el.sidebar.style.width = settings.sidebarWidth + "px";
        el.btnViewTree.setAttribute("aria-pressed", String(settings.viewMode === "tree"));
        el.btnViewRecent.setAttribute("aria-pressed", String(settings.viewMode === "recent"));
        el.btnZoomReset.textContent = Math.round(settings.zoomFactor * 100) + "%";
        if (initial !== false) pushSettingsToRenderer();
    }

    function pushSettingsToRenderer() {
        if (!state.settings) return;
        postToRenderer({ type: "zoom", factor: state.settings.zoomFactor });
        postToRenderer({ type: "contentMaxWidth", value: state.settings.contentMaxWidth });
    }

    var settingsTimer = 0;
    var pendingSettings = null;

    function saveSettings(patch, immediate) {
        state.settings = Object.assign({}, state.settings, patch);
        applySettings(state.settings, false);
        pendingSettings = Object.assign({}, pendingSettings, patch);
        if (settingsTimer) clearTimeout(settingsTimer);
        var send = function () {
            settingsTimer = 0;
            var body = pendingSettings;
            pendingSettings = null;
            if (body) api("/api/settings", body).catch(noop);
        };
        if (immediate) send();
        else settingsTimer = setTimeout(send, 250);
    }

    // ---------- sources ----------

    function renderSources(payload) {
        var current = payload.source;
        var options = (payload.sources || []).map(function (source) {
            var option = document.createElement("option");
            option.value = source.id;
            option.textContent = source.label;
            option.disabled = !source.available;
            option.title = source.detail || "";
            return option;
        });
        el.sourceSelect.replaceChildren.apply(el.sourceSelect, options);
        el.sourceSelect.value = current;

        var isFolder = payload.listing && payload.listing.mode === "folder";
        el.btnViewTree.hidden = !isFolder;
        el.btnViewRecent.hidden = !isFolder;
    }

    // ---------- sidebar ----------

    function renderSidebar() {
        var payload = state.server;
        if (!payload || !payload.listing) return;
        var listing = payload.listing;
        var container = document.createDocumentFragment();
        state.visibleNodes = [];

        if (listing.mode === "session") {
            renderSessionGroups(listing, container);
        } else if (state.settings && state.settings.viewMode === "recent") {
            renderFlatList(filterEntries(listing.recent || []), container, { showFolder: true });
        } else {
            renderTree(filterTree(listing.tree || []), container, 0);
        }

        if (state.visibleNodes.length === 0) {
            var note = document.createElement("div");
            note.className = "empty-note";
            note.textContent = state.filter
                ? "条件に一致する Markdown はありません。"
                : listing.mode === "session"
                  ? "このセッションで生成された Markdown はまだありません。"
                  : "Markdown ファイルが見つかりません。";
            container.appendChild(note);
        }

        el.tree.replaceChildren(container);
        el.count.textContent = listing.count > 0 ? listing.count + " 件" : "";
        markSelection();
    }

    function renderSessionGroups(listing, container) {
        (listing.groups || []).forEach(function (group) {
            var entries = filterEntries(group.entries);
            if (entries.length === 0) return;
            var label = document.createElement("div");
            label.className = "group-label";
            label.textContent = group.label;
            container.appendChild(label);
            renderFlatList(entries, container, { showFolder: true, showTime: true });
        });
    }

    function renderFlatList(entries, container, options) {
        entries.forEach(function (entry) {
            var button = document.createElement("button");
            button.type = "button";
            button.className = "node file";
            button.setAttribute("role", "treeitem");
            button.style.paddingLeft = "10px";

            var label = document.createElement("span");
            label.className = "label";
            label.textContent = entry.name;
            button.appendChild(label);

            var sub = [];
            if (options && options.showFolder && entry.folder) sub.push(entry.folder);
            if (options && options.showTime && entry.mtimeMs) sub.push(formatTime(entry.mtimeMs));
            if (sub.length > 0) {
                var subEl = document.createElement("span");
                subEl.className = "meta";
                subEl.textContent = sub.join(" · ");
                button.appendChild(subEl);
            }

            button.title = entry.type === "inline" ? entry.name : entry.path || entry.relPath;
            bindNodeActivation(button, entry);
            container.appendChild(button);
            state.visibleNodes.push(button);
        });
    }

    function renderTree(nodes, container, depth) {
        nodes.forEach(function (node) {
            if (node.type === "dir") {
                var expanded = state.filter ? true : state.expanded.has(node.relPath);
                var dirButton = document.createElement("button");
                dirButton.type = "button";
                dirButton.className = "node dir";
                dirButton.setAttribute("role", "treeitem");
                dirButton.setAttribute("aria-expanded", String(expanded));
                dirButton.style.paddingLeft = 4 + depth * 12 + "px";

                var twisty = document.createElement("span");
                twisty.className = "twisty";
                twisty.textContent = expanded ? "\u25BE" : "\u25B8";
                dirButton.appendChild(twisty);

                var dirLabel = document.createElement("span");
                dirLabel.className = "label";
                dirLabel.textContent = node.name;
                dirButton.appendChild(dirLabel);

                dirButton.title = node.relPath;
                dirButton.addEventListener("click", function () {
                    toggleDir(node.relPath);
                });
                container.appendChild(dirButton);
                state.visibleNodes.push(dirButton);

                if (expanded) renderTree(node.children, container, depth + 1);
                return;
            }

            var fileButton = document.createElement("button");
            fileButton.type = "button";
            fileButton.className = "node file";
            fileButton.setAttribute("role", "treeitem");
            fileButton.style.paddingLeft = 4 + depth * 12 + 18 + "px";

            var label = document.createElement("span");
            label.className = "label";
            label.textContent = node.name;
            fileButton.appendChild(label);

            fileButton.title = node.path;
            bindNodeActivation(fileButton, node);
            container.appendChild(fileButton);
            state.visibleNodes.push(fileButton);
        });
    }

    function bindNodeActivation(button, entry) {
        button.dataset.entryKind = entry.type === "inline" ? "inline" : "file";
        button.dataset.entryId = entry.type === "inline" ? entry.id : entry.path;
        button.addEventListener("click", function () {
            if (entry.type === "inline") {
                api("/api/select", { kind: "inline", id: entry.id }).catch(showError);
            } else {
                api("/api/select", { kind: "file", path: entry.path }).catch(showError);
            }
        });
    }

    function toggleDir(relPath) {
        if (state.expanded.has(relPath)) state.expanded.delete(relPath);
        else state.expanded.add(relPath);
        persistExpanded();
        renderSidebar();
    }

    function markSelection() {
        var selection = state.server && state.server.selection;
        state.visibleNodes.forEach(function (button) {
            var isCurrent = false;
            if (selection && button.dataset.entryKind === "file" && selection.kind === "file") {
                isCurrent = samePath(button.dataset.entryId, selection.path);
            } else if (selection && button.dataset.entryKind === "inline" && selection.kind === "inline") {
                isCurrent = button.dataset.entryId === selection.id;
            }
            if (isCurrent) button.setAttribute("aria-current", "true");
            else button.removeAttribute("aria-current");
        });
    }

    function samePath(a, b) {
        if (!a || !b) return false;
        return a.replace(/\\/g, "/").toLowerCase() === b.replace(/\\/g, "/").toLowerCase();
    }

    function filterEntries(entries) {
        if (!state.filter) return entries;
        var needle = state.filter;
        return entries.filter(function (entry) {
            return matchesFilter(entry.name, needle) || matchesFilter(entry.relPath || "", needle);
        });
    }

    function filterTree(nodes) {
        if (!state.filter) return nodes;
        var needle = state.filter;
        var out = [];
        nodes.forEach(function (node) {
            if (node.type === "file") {
                if (matchesFilter(node.name, needle) || matchesFilter(node.relPath, needle)) out.push(node);
                return;
            }
            var children = filterTree(node.children);
            if (children.length > 0) out.push(Object.assign({}, node, { children: children }));
        });
        return out;
    }

    function matchesFilter(value, needle) {
        return String(value).toLowerCase().indexOf(needle) >= 0;
    }

    function formatTime(ms) {
        try {
            return new Date(ms).toLocaleString(undefined, {
                month: "numeric",
                day: "numeric",
                hour: "2-digit",
                minute: "2-digit",
            });
        } catch (e) {
            return "";
        }
    }

    // ---------- document header ----------

    function renderDocHeader(doc) {
        if (!doc) {
            el.docTitle.textContent = "SkimDown";
            el.docSubtitle.textContent = "";
            el.docSubtitle.title = "";
            return;
        }
        el.docTitle.textContent = doc.title || "";
        el.docTitle.title = doc.title || "";
        var subtitle = doc.subtitle || "";
        el.docSubtitle.textContent = shortenPath(subtitle);
        el.docSubtitle.title = subtitle;
    }

    function shortenPath(value) {
        if (!value) return "";
        var parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
        if (parts.length <= 3) return value;
        return "…/" + parts.slice(-3).join("/");
    }

    // ---------- find ----------

    function openFind(initialQuery) {
        el.findbar.hidden = false;
        if (typeof initialQuery === "string" && initialQuery.length > 0) {
            el.findInput.value = initialQuery;
            runSearch(true);
        }
        el.findInput.focus();
        el.findInput.select();
    }

    function closeFind() {
        el.findbar.hidden = true;
        el.findInput.value = "";
        state.search.query = "";
        el.findCount.textContent = "";
        postToRenderer({ type: "search/clear" });
    }

    function runSearch(resetIndex) {
        state.search.query = el.findInput.value;
        if (!state.search.query) {
            el.findCount.textContent = "";
            postToRenderer({ type: "search/clear" });
            return;
        }
        postToRenderer({
            type: "search",
            query: state.search.query,
            caseSensitive: state.search.caseSensitive,
            resetIndex: resetIndex !== false,
        });
    }

    function renderFindCount(total, current) {
        if (!total) {
            el.findCount.textContent = state.search.query ? "0 件" : "";
            return;
        }
        el.findCount.textContent = (current + 1) + " / " + total;
    }

    // ---------- links ----------

    function handleLinkMessage(msg) {
        if (msg.kind === "anchor") return; // Handled inside the renderer.
        if (msg.kind === "external") {
            promptExternal(msg.href);
            return;
        }
        api("/api/link", { href: msg.href })
            .then(function (result) {
                if (result.kind === "markdown") {
                    return api("/api/select", { kind: "file", path: result.path });
                }
                if (result.kind === "folder") {
                    return api("/api/open", { path: result.path });
                }
                if (result.kind === "external") {
                    promptExternal(result.href);
                    return null;
                }
                showToast("リンク先を開けません: " + (msg.href || ""));
                return null;
            })
            .catch(showError);
    }

    function promptExternal(href) {
        state.pendingExternalHref = href;
        el.linkText.textContent = href;
        el.linkText.title = href;
        el.linkbar.hidden = false;
    }

    function closeExternalPrompt() {
        state.pendingExternalHref = null;
        el.linkbar.hidden = true;
    }

    // ---------- remote content ----------

    function resetRemoteContentUi() {
        state.remoteContentFailures = 0;
        el.remotebar.hidden = true;
        el.remoteText.textContent = "";
        el.remoteText.title = "";
        el.btnRemoteLoad.hidden = false;
        el.btnRemoteLoad.disabled = false;
    }

    function handleRemoteContentMessage(msg) {
        if (!state.doc || msg.documentId !== state.doc.remoteContentId) return;

        var blocked = Number(msg.blocked) || 0;
        var proxied = Number(msg.proxied) || 0;
        var policyBlocked = Number(msg.policyBlocked) || 0;
        if (blocked > 0) {
            var hosts = Array.isArray(msg.hosts) && msg.hosts.length > 0
                ? " (" + msg.hosts.join(", ") + ")"
                : "";
            el.remoteText.textContent =
                "リモートコンテンツ " + blocked + " 件をブロックしました" + hosts +
                "。読み込むと公開ネットワーク上の画像・メディアへ接続します。";
            el.remoteText.title =
                "許可はこの文書の現在の内容だけに適用されます。内容が変わると再度確認します。";
            el.btnRemoteLoad.hidden = false;
            el.remotebar.hidden = false;
            return;
        }

        if (policyBlocked > 0) {
            el.remoteText.textContent =
                "リモートコンテンツ " + policyBlocked +
                " 件は、loopback、link-local、プライベートネットワーク宛てのため読み込みませんでした。";
            el.remoteText.title = "";
            el.btnRemoteLoad.hidden = true;
            el.remotebar.hidden = false;
            return;
        }

        if (proxied > 0 && state.remoteContentFailures > 0) {
            showRemoteContentFailure();
            return;
        }
        el.remotebar.hidden = true;
    }

    function handleRemoteContentError(msg) {
        if (!state.doc || msg.documentId !== state.doc.remoteContentId) return;
        state.remoteContentFailures += 1;
        showRemoteContentFailure();
    }

    function showRemoteContentFailure() {
        el.remoteText.textContent =
            "一部のリモートコンテンツを読み込めませんでした。プライベート IP、未対応形式、または通信エラーの可能性があります。";
        el.remoteText.title = "";
        el.btnRemoteLoad.hidden = true;
        el.remotebar.hidden = false;
    }

    function allowRemoteContent() {
        if (!state.doc || !state.doc.remoteContentId) return;
        el.btnRemoteLoad.disabled = true;
        api("/api/remote-content/allow", { documentId: state.doc.remoteContentId })
            .then(function (result) {
                if (!result.doc) return;
                state.doc = result.doc;
                resetRemoteContentUi();
                pushDocToRenderer(result.doc);
            })
            .catch(function (error) {
                el.btnRemoteLoad.disabled = false;
                showError(error);
            });
    }

    // ---------- clipboard ----------

    function copyText(text) {
        if (typeof text !== "string" || text.length === 0) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(
                function () {
                    showToast("コピーしました");
                },
                function () {
                    legacyCopy(text);
                },
            );
            return;
        }
        legacyCopy(text);
    }

    function legacyCopy(text) {
        var area = document.createElement("textarea");
        area.value = text;
        area.setAttribute("readonly", "");
        area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(area);
        area.select();
        var ok = false;
        try {
            ok = document.execCommand("copy");
        } catch (e) {
            ok = false;
        }
        document.body.removeChild(area);
        showToast(ok ? "コピーしました" : "コピーできませんでした");
    }

    // ---------- zoom / width ----------

    function applyZoom(factor, options) {
        var value = parseFloat(factor);
        if (!isFinite(value)) return;
        value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
        saveSettings({ zoomFactor: value });
        if (!options || !options.fromRenderer) postToRenderer({ type: "zoom", factor: value });
    }

    function stepZoom(direction) {
        var current = state.settings ? state.settings.zoomFactor : 1;
        applyZoom(direction > 0 ? current * ZOOM_STEP : current / ZOOM_STEP);
    }

    function stepWidth(direction) {
        var current = state.settings ? state.settings.contentMaxWidth : CONTENT_WIDTHS[0];
        var index = CONTENT_WIDTHS.indexOf(current);
        if (index < 0) index = 0;
        index = Math.min(CONTENT_WIDTHS.length - 1, Math.max(0, index + direction));
        var value = CONTENT_WIDTHS[index];
        saveSettings({ contentMaxWidth: value }, true);
        postToRenderer({ type: "contentMaxWidth", value: value });
        showToast("本文の最大幅: " + (value === "none" ? "制限なし" : value));
    }

    // ---------- shortcuts ----------

    function handleShortcut(id) {
        switch (id) {
            case "find":
                openFind();
                break;
            case "find-next":
                postToRenderer({ type: "search/next" });
                break;
            case "find-prev":
                postToRenderer({ type: "search/prev" });
                break;
            case "use-selection-for-find":
                postToRenderer({ type: "copySelection" });
                break;
            case "toggle-sidebar":
                saveSettings({ sidebarVisible: !state.settings.sidebarVisible }, true);
                break;
            case "zoom-in":
                stepZoom(1);
                break;
            case "zoom-out":
                stepZoom(-1);
                break;
            case "zoom-reset":
                applyZoom(1);
                break;
            case "content-width-wider":
                stepWidth(1);
                break;
            case "content-width-narrower":
                stepWidth(-1);
                break;
            case "select-all":
                postToRenderer({ type: "selectAll" });
                break;
            case "open-folder":
                openPathBar();
                break;
            default:
                break;
        }
    }

    function shortcutIdFromEvent(ev) {
        if (!ev.ctrlKey || ev.altKey || ev.metaKey) return null;
        var key = ev.key || "";
        if (key === "+" || key === "=" || key === ";") return "zoom-in";
        if (key === "-") return "zoom-out";
        if (key === "0" && !ev.shiftKey) return "zoom-reset";
        if (key === "]") return "content-width-wider";
        if (key === "[") return "content-width-narrower";

        var lower = key.toLowerCase();
        if (ev.shiftKey) return lower === "g" ? "find-prev" : null;
        switch (lower) {
            case "o": return "open-folder";
            case "f": return "find";
            case "g": return "find-next";
            case "b": return "toggle-sidebar";
            default: return null;
        }
    }

    function isEditable(target) {
        if (!target) return false;
        if (target.isContentEditable) return true;
        var tag = (target.tagName || "").toUpperCase();
        return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
    }

    window.addEventListener("keydown", function (ev) {
        if (ev.key === "Escape") {
            if (!el.linkbar.hidden) {
                closeExternalPrompt();
                return;
            }
            if (!el.pathbar.hidden) {
                closePathBar();
                return;
            }
            if (!el.findbar.hidden) {
                closeFind();
                return;
            }
        }

        // Ctrl+F must still work while the caret is in the filter box.
        var editable = isEditable(ev.target);
        var id = shortcutIdFromEvent(ev);
        if (!id) {
            if (!editable) handleTreeKeys(ev);
            return;
        }
        if (editable && id !== "find" && id !== "find-next" && id !== "find-prev") return;

        ev.preventDefault();
        handleShortcut(id);
    }, true);

    function handleTreeKeys(ev) {
        if (!el.tree.contains(document.activeElement)) return;
        var nodes = state.visibleNodes;
        var index = nodes.indexOf(document.activeElement);
        if (index < 0) return;

        if (ev.key === "ArrowDown") {
            ev.preventDefault();
            if (index + 1 < nodes.length) nodes[index + 1].focus();
        } else if (ev.key === "ArrowUp") {
            ev.preventDefault();
            if (index > 0) nodes[index - 1].focus();
        } else if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
            var node = nodes[index];
            if (node.getAttribute("aria-expanded") === null) return;
            var expanded = node.getAttribute("aria-expanded") === "true";
            if ((ev.key === "ArrowRight") !== expanded) {
                ev.preventDefault();
                node.click();
            }
        }
    }

    // ---------- path bar ----------

    function openPathBar() {
        el.pathbar.hidden = false;
        var listing = state.server && state.server.listing;
        el.pathInput.value = (listing && listing.root) || "";
        el.pathInput.focus();
        el.pathInput.select();
    }

    function closePathBar() {
        el.pathbar.hidden = true;
    }

    function submitPath() {
        var value = el.pathInput.value.trim();
        if (!value) return;
        api("/api/open", { path: value })
            .then(function () {
                closePathBar();
            })
            .catch(showError);
    }

    // ---------- sidebar resize ----------

    (function bindResizer() {
        var dragging = false;
        var startX = 0;
        var startWidth = 0;

        el.resizer.addEventListener("pointerdown", function (ev) {
            dragging = true;
            startX = ev.clientX;
            startWidth = el.sidebar.getBoundingClientRect().width;
            el.resizer.classList.add("dragging");
            el.resizer.setPointerCapture(ev.pointerId);
            ev.preventDefault();
        });

        el.resizer.addEventListener("pointermove", function (ev) {
            if (!dragging) return;
            var onRight = el.body.dataset.sidebarPosition === "right";
            var delta = ev.clientX - startX;
            var width = startWidth + (onRight ? -delta : delta);
            width = Math.min(520, Math.max(160, width));
            el.sidebar.style.width = width + "px";
        });

        function endDrag(ev) {
            if (!dragging) return;
            dragging = false;
            el.resizer.classList.remove("dragging");
            try {
                el.resizer.releasePointerCapture(ev.pointerId);
            } catch (e) {
                // Pointer already released.
            }
            saveSettings({ sidebarWidth: Math.round(el.sidebar.getBoundingClientRect().width) }, true);
        }

        el.resizer.addEventListener("pointerup", endDrag);
        el.resizer.addEventListener("pointercancel", endDrag);
    })();

    // ---------- wiring ----------

    el.sourceSelect.addEventListener("change", function () {
        var source = el.sourceSelect.value;
        if (source === "path") {
            openPathBar();
            el.sourceSelect.value = state.server ? state.server.source : "session";
            return;
        }
        api("/api/source", { source: source }).catch(showError);
    });

    el.filter.addEventListener("input", function () {
        state.filter = el.filter.value.trim().toLowerCase();
        renderSidebar();
    });

    el.btnViewTree.addEventListener("click", function () {
        saveSettings({ viewMode: "tree" }, true);
        renderSidebar();
    });

    el.btnViewRecent.addEventListener("click", function () {
        saveSettings({ viewMode: "recent" }, true);
        renderSidebar();
    });

    el.btnRefresh.addEventListener("click", function () {
        api("/api/refresh", {}).catch(showError);
    });

    el.btnOpenPath.addEventListener("click", openPathBar);
    el.btnPathOpen.addEventListener("click", submitPath);
    el.btnPathCancel.addEventListener("click", closePathBar);
    el.pathInput.addEventListener("keydown", function (ev) {
        if (ev.key === "Enter") {
            ev.preventDefault();
            submitPath();
        }
    });

    el.btnSwapSidebar.addEventListener("click", function () {
        saveSettings({
            sidebarPosition: state.settings.sidebarPosition === "right" ? "left" : "right",
        }, true);
    });

    el.btnToggleSidebar.addEventListener("click", function () {
        saveSettings({ sidebarVisible: !state.settings.sidebarVisible }, true);
    });

    el.btnOpenBrowser.addEventListener("click", function () {
        api("/api/open-browser", {})
            .then(function (result) {
                if (!result.ok) showToast(result.error || "ブラウザーで開けませんでした");
            })
            .catch(showError);
    });

    el.btnFind.addEventListener("click", function () {
        if (el.findbar.hidden) openFind();
        else closeFind();
    });

    el.findInput.addEventListener("input", function () {
        runSearch(true);
    });

    el.findInput.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        postToRenderer({ type: ev.shiftKey ? "search/prev" : "search/next" });
    });

    el.btnFindCase.addEventListener("click", function () {
        state.search.caseSensitive = !state.search.caseSensitive;
        el.btnFindCase.setAttribute("aria-pressed", String(state.search.caseSensitive));
        runSearch(true);
    });

    el.btnFindNext.addEventListener("click", function () {
        postToRenderer({ type: "search/next" });
    });

    el.btnFindPrev.addEventListener("click", function () {
        postToRenderer({ type: "search/prev" });
    });

    el.btnFindClose.addEventListener("click", closeFind);

    el.btnZoomIn.addEventListener("click", function () {
        stepZoom(1);
    });

    el.btnZoomOut.addEventListener("click", function () {
        stepZoom(-1);
    });

    el.btnZoomReset.addEventListener("click", function () {
        applyZoom(1);
    });

    el.btnWidth.addEventListener("click", function () {
        stepWidth(1);
    });

    el.btnLinkOpen.addEventListener("click", function () {
        var href = state.pendingExternalHref;
        closeExternalPrompt();
        if (!href) return;
        api("/api/open-external", { href: href })
            .then(function (result) {
                if (!result.ok) showToast(result.error || "リンクを開けませんでした");
            })
            .catch(showError);
    });

    el.btnLinkCancel.addEventListener("click", closeExternalPrompt);
    el.btnRemoteLoad.addEventListener("click", allowRemoteContent);

    el.btnDeadReload.addEventListener("click", function () {
        location.reload();
    });

    // ---------- misc ----------

    var toastTimer = 0;

    function showToast(message) {
        el.toast.textContent = message;
        el.toast.hidden = false;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            el.toast.hidden = true;
        }, 2600);
    }

    /** The bar is shared by the dead-server and dead-renderer paths, so the
     *  markup's own copy has to be restored whenever no message is supplied. */
    var deadbarDefaultText = el.deadbarText ? el.deadbarText.textContent : "";

    function showDeadBar(show, message) {
        if (show && el.deadbarText) {
            el.deadbarText.textContent = message || deadbarDefaultText;
        }
        el.deadbar.hidden = !show;
    }

    function showError(error) {
        showToast(error && error.message ? error.message : String(error));
    }

    function noop() {}

    syncShellColorScheme(isDarkTone());
    reportShellBoot();
    connectEvents();
    api("/api/state").then(applyServerState).catch(showError);
})();
