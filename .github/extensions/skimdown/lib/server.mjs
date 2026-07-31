/* Per-instance loopback servers for one open SkimDown canvas.
 *
 * Three servers keep privileged shell APIs, untrusted Markdown rendering, and
 * document media in separate origins.
 *
 *   asset origin    http://127.0.0.1:<a>/   shell + /api + SSE
 *   renderer origin http://127.0.0.1:<b>/   renderer + vendor assets only
 *   content origin  http://127.0.0.1:<c>/   images referenced from the open document
 *
 * Only loopback is bound, because the host embeds loopback URLs only.
 */

import { createServer } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import {
    SOURCE_SESSION,
    SOURCE_WORKSPACE,
    SOURCE_PATH,
    describeSources,
    listSource,
    readMarkdownFile,
    classifyPath,
} from "./sources.mjs";
import {
    loadSettings,
    updateSettings,
    updateSettingsWithPrevious,
    setExpanded,
} from "./settings.mjs";
import {
    loadRegistry,
    getInlineDoc,
    rememberSelection,
    clearSessionHistory,
    clearAllSessionHistory,
    updateSessionPrivacySettings,
    registryEvents,
} from "./sessionDocs.mjs";
import {
    sessionArtifactsDir,
    resolveWorkspaceRoot,
    appendDiag,
    withStateLock,
} from "./paths.mjs";
import {
    DIAG_ENTRY_MAX_BYTES,
    DIAG_REQUEST_MAX_BYTES,
    DIAG_SCHEMA_VERSION,
    DiagnosticValidationError,
    createDiagnosticRateLimiter,
    diagnosticByteLength,
    validateDiagnostic,
} from "./diagnostics.mjs";
import { createWatcher } from "./watcher.mjs";
import { isMarkdownFile } from "./scanner.mjs";
import { fetchRemoteResource, RemoteContentError } from "./remoteContent.mjs";

const EXTENSION_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const WEB_DIR = path.join(EXTENSION_DIR, "web");
const VENDOR_LOCK_PATH = path.join(EXTENSION_DIR, "vendor-lock.json");

const STATIC_TYPES = new Map(Object.entries({
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".map": "application/json; charset=utf-8",
}));

const CONTENT_TYPES = new Map(Object.entries({
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".bmp": "image/bmp",
    ".ico": "image/x-icon",
    ".svg": "image/svg+xml",
    ".apng": "image/apng",
}));

const SHELL_ASSETS = new Set(["shell.html", "shell.css", "shell.js"]);
const RENDERER_ASSETS = new Set(["renderer.html", "bridge.js", "renderer.js", "skimdown.css"]);
const SSE_KEEPALIVE_MS = 25000;
const MAX_REMOTE_GRANTS = 100;
const CAPABILITY_BYTES = 32;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

/* Vendored assets that exceed the extension installer's per-file limit are stored
 * as byte-identical chunks and reassembled here, so the renderer keeps requesting
 * the upstream file name and receives the upstream bytes. */

let chunkedAssetsCache;

function chunkedAssets() {
    if (chunkedAssetsCache) return chunkedAssetsCache;
    const byLogicalPath = new Map();
    const chunkPaths = new Set();
    try {
        const manifest = JSON.parse(fs.readFileSync(VENDOR_LOCK_PATH, "utf8"));
        for (const file of manifest?.files ?? []) {
            const count = file?.chunks?.sha256?.length;
            if (!Number.isInteger(count) || count < 1 || typeof file.path !== "string") continue;
            const parts = Array.from(
                { length: count },
                (_, index) => `vendor/${file.path}.${String(index).padStart(3, "0")}`,
            );
            byLogicalPath.set(`vendor/${file.path}`, parts);
            for (const part of parts) chunkPaths.add(part);
        }
    } catch {
        // A missing or malformed ledger leaves every vendored asset served as-is.
    }
    chunkedAssetsCache = { byLogicalPath, chunkPaths };
    return chunkedAssetsCache;
}

const assembledAssets = new Map();

function readAssembledAsset(relative, parts) {
    let pending = assembledAssets.get(relative);
    if (!pending) {
        pending = (async () => {
            const buffers = [];
            for (const part of parts) {
                const resolved = path.resolve(WEB_DIR, part);
                if (!isInside(WEB_DIR, resolved)) throw new Error("chunk outside the web directory");
                buffers.push(await fsp.readFile(resolved));
            }
            return Buffer.concat(buffers);
        })();
        pending.catch(() => assembledAssets.delete(relative));
        assembledAssets.set(relative, pending);
    }
    return pending;
}

/**
 * Create and start the servers plus all state for one canvas instance.
 * `ctx`: { instanceId, sessionId, workspacePath, log, launchExternal? }
 */
export async function createInstance(ctx) {
    const state = {
        instanceId: ctx.instanceId,
        sessionId: ctx.sessionId,
        workspacePath: await resolveWorkspaceRoot(ctx.workspacePath),
        source: SOURCE_SESSION,
        root: null,
        listing: null,
        selection: null,
        doc: null,
        historyMemoryGeneration: 0,
        notice: null,
    };

    const sseClients = new Set();
    const diagnosticRateLimiter = createDiagnosticRateLimiter();
    /** token -> absolute directory, backing the content origin. */
    const contentDirs = new Map();
    /** Content hash -> opaque grant token. Grants live only for this canvas instance. */
    const remoteContentGrants = new Map();
    const remoteGrantDocuments = new Map();
    const approvedRoots = new Set();
    const capabilityToken = randomBytes(CAPABILITY_BYTES).toString("base64url");
    // Tests substitute the launcher; production hands the URL to the OS handler.
    const launchExternal = typeof ctx.launchExternal === "function" ? ctx.launchExternal : openExternal;

    approveRoot(state.workspacePath);
    approveRoot(sessionArtifactsDir(ctx.sessionId));

    const watcher = createWatcher(() => {
        void handleFilesystemChange();
    });

    const onRegistryChanged = (sessionId, change) => {
        if (sessionId !== ctx.sessionId) return;
        void (async () => {
            if (change?.kind === "cleared") {
                await reconcileHistoryClear({ push: true });
            }
            if (state.source === SOURCE_SESSION) await refreshListing({ push: true });
        })();
    };
    registryEvents.on("changed", onRegistryChanged);

    const contentServer = createServer((req, res) => {
        void handleContentRequest(req, res).catch(() => endWithStatus(res, 500, "content error"));
    });
    await listen(contentServer);
    const contentPort = portOf(contentServer);
    const contentBaseUri = `http://127.0.0.1:${contentPort}/`;

    let assetBaseUri = "";
    const rendererServer = createServer((req, res) => {
        void handleRendererRequest(req, res).catch(() => endWithStatus(res, 500, "renderer error"));
    });
    await listen(rendererServer);
    const rendererPort = portOf(rendererServer);
    const rendererBaseUri = `http://127.0.0.1:${rendererPort}/`;

    const assetServer = createServer((req, res) => {
        void handleAssetRequest(req, res).catch((error) => {
            ctx.log?.(`skimdown request failed: ${error?.message || error}`);
            const status = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
            if ((req.url || "").startsWith("/api/")) {
                sendJson(res, status, { error: status === 500 ? "internal error" : error.message });
            } else {
                endWithStatus(res, status, status === 500 ? "internal error" : error.message);
            }
        });
    });
    await listen(assetServer);
    const assetPort = portOf(assetServer);
    assetBaseUri = `http://127.0.0.1:${assetPort}/`;
    const assetOrigin = originOf(assetBaseUri);
    const url = `${assetBaseUri}#token=${encodeURIComponent(capabilityToken)}`;

    // ---------- state helpers ----------

    function approveRoot(root) {
        if (typeof root !== "string" || root.length === 0) return;
        approvedRoots.add(canonicalPath(root));
    }

    function approveListing(listing) {
        if (listing?.root) approveRoot(listing.root);
        for (const group of listing?.groups || []) {
            for (const entry of group.entries || []) {
                if (entry.path) approveRoot(path.dirname(entry.path));
            }
        }
    }

    function isApprovedPath(candidate) {
        const resolved = canonicalPath(candidate);
        for (const root of approvedRoots) {
            if (isInside(root, resolved)) return true;
        }
        return false;
    }

    function requireApprovedPath(candidate) {
        if (isApprovedPath(candidate)) return;
        throw httpError(403, "path is outside the approved roots");
    }

    function approveTarget(classified) {
        if (classified.kind === "folder") approveRoot(classified.path);
        if (classified.kind === "file") approveRoot(path.dirname(classified.path));
    }

    function contentTokenFor(dir) {
        const resolved = canonicalPath(dir);
        const token = createHash("sha256").update(resolved).digest("hex").slice(0, 16);
        contentDirs.set(token, resolved);
        return token;
    }

    async function refreshListing({ push } = {}) {
        state.listing = await listSource(
            { sessionId: ctx.sessionId, workspacePath: state.workspacePath },
            state.source,
            state.root,
        );
        approveListing(state.listing);
        updateWatchTargets();
        if (push) broadcast("state", await buildState());
        return state.listing;
    }

    function updateWatchTargets() {
        const dirs = new Set();
        if (state.listing?.root) dirs.add(state.listing.root);
        if (state.source === SOURCE_SESSION) {
            const artifactsRoot = state.listing?.artifactsRoot || sessionArtifactsDir(ctx.sessionId);
            if (fs.existsSync(artifactsRoot)) dirs.add(artifactsRoot);
            for (const group of state.listing?.groups || []) {
                for (const entry of group.entries) {
                    if (entry.path) dirs.add(path.dirname(entry.path));
                }
            }
        }
        if (state.selection?.path) dirs.add(path.dirname(state.selection.path));
        watcher.setDirs([...dirs]);
    }

    async function buildState() {
        const settings = await loadSettings({ fresh: true });
        await reconcileHistoryClear({ settings });
        const sources = await describeSources({
            sessionId: ctx.sessionId,
            workspacePath: state.workspacePath,
        });
        return {
            instanceId: state.instanceId,
            sessionId: state.sessionId,
            workspacePath: state.workspacePath,
            source: state.source,
            root: state.root,
            listing: state.listing,
            selection: state.selection,
            settings,
            sources,
            notice: state.notice,
            contentBaseUri,
            rendererBaseUri,
        };
    }

    function historyMemoryGeneration(settings) {
        const sessionGeneration = settings.sessionDeletionGenerations?.[ctx.sessionId] || 0;
        return Math.max(settings.sessionMemoryClearGeneration || 0, sessionGeneration);
    }

    async function captureHistoryMemoryGeneration() {
        const settings = await loadSettings({ fresh: true });
        state.historyMemoryGeneration = historyMemoryGeneration(settings);
    }

    async function reconcileHistoryClear({ settings, push = false } = {}) {
        const currentSettings = settings || await loadSettings({ fresh: true });
        const generation = historyMemoryGeneration(currentSettings);
        if (state.historyMemoryGeneration >= generation) return false;

        state.historyMemoryGeneration = generation;
        if (!state.doc) return false;
        state.selection = null;
        state.doc = null;
        updateWatchTargets();
        if (push) {
            broadcast("empty", {});
            broadcast("state", await buildState());
        }
        return true;
    }

    function identifyRemoteContent(doc) {
        return createHash("sha256")
            .update(doc.kind)
            .update("\0")
            .update(doc.path || doc.id || "")
            .update("\0")
            .update(doc.markdown || "")
            .digest("hex");
    }

    function setRemoteContentIdentity(doc) {
        doc.remoteContentId = identifyRemoteContent(doc);
        return doc;
    }

    function publicDoc(doc = state.doc) {
        if (!doc) return null;
        const token = remoteContentGrants.get(doc.remoteContentId);
        return token ? { ...doc, remoteContentToken: token } : { ...doc };
    }

    function grantRemoteContent(documentId) {
        if (!state.doc || documentId !== state.doc.remoteContentId) {
            throw new RemoteContentError("The displayed document changed. Try again.", 409);
        }

        let token = remoteContentGrants.get(documentId);
        if (!token) {
            token = randomBytes(24).toString("base64url");
            remoteContentGrants.set(documentId, token);
            remoteGrantDocuments.set(token, documentId);
            while (remoteContentGrants.size > MAX_REMOTE_GRANTS) {
                const oldestDocumentId = remoteContentGrants.keys().next().value;
                const oldestToken = remoteContentGrants.get(oldestDocumentId);
                remoteContentGrants.delete(oldestDocumentId);
                remoteGrantDocuments.delete(oldestToken);
            }
        }
        return token;
    }

    async function selectFile(absPath, { push = true } = {}) {
        return withStateLock(async () => {
            const resolved = canonicalPath(absPath);
            requireApprovedPath(resolved);
            const file = await readMarkdownFile(resolved);
            const dir = path.dirname(resolved);
            const token = contentTokenFor(dir);

            state.selection = {
                kind: "file",
                path: resolved,
                title: path.basename(resolved),
                subtitle: displayPath(resolved),
                mtimeMs: file.mtimeMs,
            };
            state.doc = setRemoteContentIdentity({
                kind: "file",
                title: state.selection.title,
                subtitle: state.selection.subtitle,
                path: resolved,
                markdown: file.markdown,
                // `sourcePath` must contain a directory segment: renderer.js only
                // rewrites relative image URLs when it can derive a source dir.
                sourcePath: `d/${token}/${encodeURIComponent(path.basename(resolved))}`,
                contentBaseUri,
            });
            updateWatchTargets();
            await rememberSelection(ctx.sessionId, { kind: "file", path: resolved }, state.root);
            await captureHistoryMemoryGeneration();
            if (push) {
                broadcast("doc", publicDoc());
                broadcast("state", await buildState());
            }
            return state.doc;
        });
    }

    async function selectInline(id, { push = true } = {}) {
        return withStateLock(async () => {
            const doc = await getInlineDoc(ctx.sessionId, id);
            if (!doc) {
                const error = new Error(`Inline document not found: ${id}`);
                error.code = "not_found";
                throw error;
            }
            state.selection = {
                kind: "inline",
                id: doc.id,
                title: doc.title,
                subtitle: "Markdown displayed by the agent",
            };
            state.doc = setRemoteContentIdentity({
                kind: "inline",
                title: doc.title,
                subtitle: state.selection.subtitle,
                id: doc.id,
                markdown: doc.markdown,
                sourcePath: "",
                contentBaseUri: "",
            });
            await rememberSelection(ctx.sessionId, { kind: "inline", id: doc.id }, state.root);
            await captureHistoryMemoryGeneration();
            if (push) {
                broadcast("doc", publicDoc());
                broadcast("state", await buildState());
            }
            return state.doc;
        });
    }

    /** Pick a sensible first document when a source is opened with no selection. */
    async function autoSelect({ push = true } = {}) {
        const listing = state.listing;
        if (!listing) return null;

        if (listing.mode === "session") {
            for (const group of listing.groups || []) {
                const entry = group.entries[0];
                if (!entry) continue;
                if (entry.type === "inline") return selectInline(entry.id, { push });
                return selectFile(entry.path, { push });
            }
            state.selection = null;
            state.doc = null;
            if (push) {
                broadcast("empty", {});
                broadcast("state", await buildState());
            }
            return null;
        }

        const preferred = pickPreferredFile(listing.recent || []);
        if (preferred) return selectFile(preferred.path, { push });

        state.selection = null;
        state.doc = null;
        if (push) {
            broadcast("empty", {});
            broadcast("state", await buildState());
        }
        return null;
    }

    async function setSource(source, rootPath) {
        let nextRoot = state.root;
        if (source === SOURCE_WORKSPACE) {
            nextRoot = state.workspacePath;
        } else if (source === SOURCE_PATH && rootPath) {
            nextRoot = path.resolve(rootPath);
            requireApprovedPath(nextRoot);
        } else if (source !== SOURCE_PATH) {
            nextRoot = null;
        }

        state.source = source;
        state.root = nextRoot;
        state.notice = null;
        await updateSettings({ lastSource: source });
        await refreshListing();
        await autoSelect({ push: false });
        broadcast("state", await buildState());
        if (state.doc) broadcast("doc", publicDoc());
        else broadcast("empty", {});
    }

    async function openTarget(target, { approve = false } = {}) {
        const classified = await classifyPath(target, state.workspacePath);
        if (classified.kind === "folder" || classified.kind === "file") {
            if (approve) approveTarget(classified);
            else requireApprovedPath(classified.path);
        }
        if (classified.kind === "folder") {
            state.source = SOURCE_PATH;
            state.root = classified.path;
            state.notice = null;
            await updateSettings({ lastSource: SOURCE_PATH });
            await refreshListing();
            await autoSelect({ push: false });
            broadcast("state", await buildState());
            if (state.doc) broadcast("doc", publicDoc());
            else broadcast("empty", {});
            return { opened: "folder", path: classified.path, count: state.listing?.count ?? 0 };
        }

        if (classified.kind === "file") {
            state.source = SOURCE_PATH;
            state.root = path.dirname(classified.path);
            state.notice = null;
            await updateSettings({ lastSource: SOURCE_PATH });
            await refreshListing();
            await selectFile(classified.path, { push: false });
            broadcast("state", await buildState());
            broadcast("doc", publicDoc());
            return { opened: "file", path: classified.path };
        }

        const reason =
            classified.kind === "missing"
                ? `Path not found: ${classified.path}`
                : classified.kind === "unsupported"
                  ? `Not a Markdown file: ${classified.path}`
                  : classified.reason || "Invalid path";
        const error = new Error(reason);
        error.code = classified.kind === "missing" ? "not_found" : "invalid_path";
        throw error;
    }

    async function handleFilesystemChange() {
        await refreshListing();
        let docChanged = false;

        if (state.selection?.kind === "file") {
            try {
                const file = await readMarkdownFile(state.selection.path);
                if (file.markdown !== state.doc?.markdown) {
                    state.doc = setRemoteContentIdentity({ ...state.doc, markdown: file.markdown });
                    state.selection.mtimeMs = file.mtimeMs;
                    docChanged = true;
                }
            } catch {
                // The open file vanished — fall back to whatever is left.
                state.selection = null;
                state.doc = null;
                await autoSelect({ push: false });
                docChanged = true;
            }
        }

        broadcast("state", await buildState());
        if (docChanged) {
            if (state.doc) broadcast("doc", publicDoc());
            else broadcast("empty", {});
        }
    }

    // ---------- SSE ----------

    function broadcast(event, payload) {
        const frame = `event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`;
        for (const client of sseClients) {
            try {
                client.write(frame);
            } catch {
                sseClients.delete(client);
            }
        }
    }

    // ---------- HTTP: asset origin ----------

    async function handleAssetRequest(req, res) {
        applySecurityHeaders(res, {
            csp: shellCsp(rendererBaseUri),
            corp: "same-origin",
        });
        if (!hasExpectedHost(req, assetPort)) return endWithStatus(res, 403, "invalid host");

        let parsed;
        let pathname;
        try {
            parsed = new URL(req.url || "/", assetOrigin);
            pathname = decodeURIComponent(parsed.pathname);
        } catch {
            return endWithStatus(res, 400, "invalid request target");
        }

        if (pathname === "/events") {
            const rejection = validateProtectedRequest(req, parsed, assetOrigin, capabilityToken, true);
            if (rejection) return sendJson(res, rejection.status, { error: rejection.message });
            return handleSse(res);
        }
        if (pathname.startsWith("/api/")) return handleApi(req, res, pathname, parsed);
        if (req.method !== "GET" && req.method !== "HEAD") {
            return endWithStatus(res, 405, "method not allowed");
        }
        return handleStatic(req, res, pathname, "shell");
    }

    function handleSse(res) {
        res.writeHead(200, {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-cache, no-transform",
            Connection: "keep-alive",
        });
        res.write("retry: 2000\n\n");
        sseClients.add(res);

        const keepalive = setInterval(() => {
            try {
                res.write(": ping\n\n");
            } catch {
                clearInterval(keepalive);
            }
        }, SSE_KEEPALIVE_MS);

        res.on("close", () => {
            clearInterval(keepalive);
            sseClients.delete(res);
        });

        void (async () => {
            broadcastTo(res, "state", await buildState());
            if (state.doc) broadcastTo(res, "doc", publicDoc());
            else broadcastTo(res, "empty", {});
        })();
    }

    function broadcastTo(res, event, payload) {
        try {
            res.write(`event: ${event}\ndata: ${JSON.stringify(payload ?? null)}\n\n`);
        } catch {
            sseClients.delete(res);
        }
    }

    async function handleApi(req, res, pathname, parsed) {
        const rejection = validateProtectedRequest(req, parsed, assetOrigin, capabilityToken, false);
        if (rejection) return sendJson(res, rejection.status, { error: rejection.message });

        if (req.method === "GET" && pathname === "/api/state") {
            return sendJson(res, 200, await buildState());
        }

        if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
        if (!isJsonContentType(req.headers["content-type"])) {
            return sendJson(res, 415, { error: "application/json is required" });
        }

        if (pathname === "/api/diag") {
            const rate = diagnosticRateLimiter.take();
            if (!rate.allowed) {
                return sendJson(
                    res,
                    429,
                    { error: "rate limit exceeded" },
                    { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
                );
            }
        }

        const body = await readJsonBody(
            req,
            pathname === "/api/diag" ? DIAG_REQUEST_MAX_BYTES : MAX_REQUEST_BYTES,
        );

        switch (pathname) {
            case "/api/select": {
                if (body.kind === "inline") {
                    const doc = await selectInline(String(body.id || ""));
                    return sendJson(res, 200, { ok: true, doc: publicDoc(doc) });
                }
                const doc = await selectFile(String(body.path || ""));
                return sendJson(res, 200, { ok: true, doc: publicDoc(doc) });
            }
            case "/api/source": {
                const source = [SOURCE_SESSION, SOURCE_WORKSPACE, SOURCE_PATH].includes(body.source)
                    ? body.source
                    : SOURCE_SESSION;
                await setSource(source, body.path);
                return sendJson(res, 200, { ok: true });
            }
            case "/api/open": {
                const result = await openTarget(String(body.path || ""), { approve: true });
                return sendJson(res, 200, { ok: true, ...result });
            }
            case "/api/refresh": {
                await refreshListing({ push: true });
                return sendJson(res, 200, { ok: true, count: state.listing?.count ?? 0 });
            }
            case "/api/settings": {
                const privacyRequested =
                    Object.hasOwn(body || {}, "persistSessionHistory")
                    || Object.hasOwn(body || {}, "sessionRetentionDays");
                const settings = privacyRequested
                    ? await updateSessionPrivacySettings(ctx.sessionId, body || {})
                    : (await updateSettingsWithPrevious(body || {})).settings;
                broadcast("settings", settings);
                return sendJson(res, 200, { ok: true, settings });
            }
            case "/api/session-history": {
                const scope = body.scope === "all" ? "all" : "current";
                const deleted = scope === "all"
                    ? await clearAllSessionHistory()
                    : (await clearSessionHistory(ctx.sessionId), 1);
                state.selection = null;
                state.doc = null;
                await refreshListing({ push: true });
                broadcast("empty", {});
                return sendJson(res, 200, { ok: true, scope, deleted });
            }
            case "/api/remote-content/allow": {
                try {
                    grantRemoteContent(String(body.documentId || ""));
                } catch (error) {
                    const status = error instanceof RemoteContentError ? error.status : 400;
                    return sendJson(res, status, { error: error?.message || "Could not grant permission" });
                }
                const doc = publicDoc();
                return sendJson(res, 200, { ok: true, doc });
            }
            case "/api/expanded": {
                await setExpanded(String(body.root || ""), body.expanded);
                return sendJson(res, 200, { ok: true });
            }
            case "/api/link": {
                return sendJson(res, 200, await resolveLink(String(body.href || "")));
            }
            case "/api/diag": {
                // The renderer runs in a nested iframe the extension process
                // cannot inspect, so it reports here. Persisted as well as
                // logged: the log channel is ephemeral, and otherwise the
                // evidence is gone before anyone can read it. The file is
                // capped, so recording healthy boots too costs nothing and
                // makes "it worked, and how" observable.
                let diagnostic;
                try {
                    diagnostic = validateDiagnostic(body);
                } catch (error) {
                    if (error instanceof DiagnosticValidationError) {
                        return sendJson(res, 400, { error: error.message });
                    }
                    throw error;
                }
                const entry = {
                    schemaVersion: DIAG_SCHEMA_VERSION,
                    at: new Date().toISOString(),
                    instanceId: state.instanceId,
                    ...diagnostic,
                };
                if (diagnosticByteLength(entry) > DIAG_ENTRY_MAX_BYTES) {
                    return sendJson(res, 413, { error: "diagnostic entry too large" });
                }
                const healthy =
                    diagnostic.reason === "bridge-installed" || diagnostic.reason === "shell-boot";
                await appendDiag(entry);
                ctx.log?.(
                    `renderer diagnostic (${state.instanceId}): ${JSON.stringify(diagnostic).slice(0, 900)}`,
                    { level: healthy ? "info" : "warning" },
                );
                return sendJson(res, 200, { ok: true });
            }
            case "/api/open-browser": {
                const opened = openPanelInBrowser();
                return sendJson(res, opened.ok ? 200 : 500, opened);
            }
            case "/api/open-external": {
                const opened = launchExternal(String(body.href || ""));
                return sendJson(res, opened.ok ? 200 : 400, opened);
            }
            default:
                return endWithStatus(res, 404, "unknown endpoint");
        }
    }

    async function handleRemoteContent(res, parsed) {
        const token = parsed.searchParams.get("token") || "";
        const grantedDocumentId = remoteGrantDocuments.get(token);
        if (!grantedDocumentId || grantedDocumentId !== state.doc?.remoteContentId) {
            return endWithStatus(res, 403, "remote content permission required");
        }

        try {
            const resource = await fetchRemoteResource(parsed.searchParams.get("url") || "");
            res.writeHead(200, {
                "Content-Type": resource.contentType,
                "Content-Length": resource.body.length,
                "Cache-Control": "private, max-age=300",
                "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            });
            res.end(resource.body);
        } catch (error) {
            const status = error instanceof RemoteContentError ? error.status : 502;
            endWithStatus(res, status, error?.message || "remote content error");
        }
    }

    async function resolveLink(href) {
        if (!href) return { kind: "unknown" };
        if (/^https?:\/\//i.test(href)) return { kind: "external", href };
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^file:/i.test(href)) {
            return { kind: "unsupported", href };
        }

        const baseDir =
            state.selection?.kind === "file"
                ? path.dirname(state.selection.path)
                : state.root || state.workspacePath;
        if (!baseDir) return { kind: "unknown", href };

        const [rawPath] = href.split("#");
        let target;
        try {
            target = path.resolve(baseDir, decodeURIComponent(rawPath));
        } catch {
            target = path.resolve(baseDir, rawPath);
        }
        if (!isApprovedPath(target)) return { kind: "forbidden" };

        const classified = await classifyPath(target);
        if (classified.kind === "file") return { kind: "markdown", path: classified.path };
        if (classified.kind === "folder") return { kind: "folder", path: classified.path };
        return { kind: "missing", path: target };
    }

    // ---------- HTTP: renderer origin ----------

    async function handleRendererRequest(req, res) {
        applySecurityHeaders(res, {
            csp: rendererCsp(assetBaseUri, contentBaseUri),
            corp: "same-site",
        });
        if (!hasExpectedHost(req, rendererPort)) return endWithStatus(res, 403, "invalid host");
        if (req.method !== "GET" && req.method !== "HEAD") {
            return endWithStatus(res, 405, "method not allowed");
        }
        const parsed = new URL(req.url || "/", "http://127.0.0.1");
        const pathname = decodeURIComponent(parsed.pathname);
        if (req.method === "GET" && pathname === "/remote-content") {
            return handleRemoteContent(res, parsed);
        }
        return handleStatic(req, res, pathname, "renderer");
    }

    async function handleStatic(req, res, pathname, role) {
        // The embedding chrome asks for a favicon that a canvas never has; answer
        // quietly rather than logging a 404 into the user's console.
        if (pathname === "/favicon.ico") {
            res.writeHead(204).end();
            return;
        }

        const defaultPage = role === "shell" ? "shell.html" : "renderer.html";
        const relative = pathname === "/" ? defaultPage : pathname.replace(/^\/+/, "");
        if (!isAllowedStaticAsset(role, relative)) return endWithStatus(res, 404, "not found");
        const resolved = path.resolve(WEB_DIR, relative);
        if (!isInside(WEB_DIR, resolved)) return endWithStatus(res, 403, "forbidden");

        const normalized = relative.replaceAll("\\", "/");
        const parts = chunkedAssets().byLogicalPath.get(normalized);
        let data;
        try {
            data = parts ? await readAssembledAsset(normalized, parts) : await fsp.readFile(resolved);
        } catch {
            return endWithStatus(res, 404, "not found");
        }

        const type = STATIC_TYPES.get(path.extname(resolved).toLowerCase()) || "application/octet-stream";
        res.writeHead(200, {
            "Content-Type": type,
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : data);
    }

    // ---------- HTTP: content origin ----------

    async function handleContentRequest(req, res) {
        applySecurityHeaders(res, {
            csp: "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; object-src 'none'; sandbox",
            corp: "same-site",
        });
        if (!hasExpectedHost(req, contentPort)) return endWithStatus(res, 403, "invalid host");
        if (req.method !== "GET" && req.method !== "HEAD") {
            return endWithStatus(res, 405, "method not allowed");
        }
        const parsed = new URL(req.url || "/", "http://127.0.0.1");
        const segments = decodeURIComponent(parsed.pathname).split("/").filter(Boolean);
        if (segments.length < 3 || segments[0] !== "d") return endWithStatus(res, 404, "not found");

        const dir = contentDirs.get(segments[1]);
        if (!dir) return endWithStatus(res, 404, "not found");

        const candidate = path.resolve(dir, ...segments.slice(2));
        let resolved;
        try {
            resolved = await fsp.realpath(candidate);
        } catch {
            return endWithStatus(res, 404, "not found");
        }
        if (!isInside(dir, resolved)) return endWithStatus(res, 403, "forbidden");

        const type = CONTENT_TYPES.get(path.extname(resolved).toLowerCase());
        if (!type) return endWithStatus(res, 415, "unsupported media type");

        let data;
        try {
            data = await fsp.readFile(resolved);
        } catch {
            return endWithStatus(res, 404, "not found");
        }

        res.writeHead(200, {
            "Content-Type": type,
            "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : data);
    }

    // ---------- lifecycle ----------

    const historyReconcileTimer = setInterval(() => {
        void reconcileHistoryClear({ push: true }).catch((error) => {
            ctx.log?.(`skimdown history reconciliation failed: ${error?.message || error}`);
        });
    }, 5000);
    historyReconcileTimer.unref?.();

    async function dispose() {
        registryEvents.off("changed", onRegistryChanged);
        clearInterval(historyReconcileTimer);
        watcher.dispose();
        for (const client of sseClients) {
            try {
                client.end();
            } catch {
                // Already gone.
            }
        }
        sseClients.clear();
        await Promise.all([
            closeServer(assetServer),
            closeServer(rendererServer),
            closeServer(contentServer),
        ]);
    }

    // ---------- initial state ----------

    const settings = await loadSettings();
    state.source = settings.lastSource || SOURCE_SESSION;
    if (state.source === SOURCE_WORKSPACE) state.root = state.workspacePath;
    if (state.source === SOURCE_PATH) {
        const registry = await loadRegistry(ctx.sessionId);
        state.root = registry.lastRoot || state.workspacePath;
        approveRoot(state.root);
        if (!state.root) state.source = SOURCE_SESSION;
    }
    await refreshListing();
    await restoreSelection();
    if (!state.selection) await autoSelect({ push: false });

    async function restoreSelection() {
        const registry = await loadRegistry(ctx.sessionId);
        const last = registry.lastSelection;
        if (!last) return;
        try {
            if (last.kind === "inline") await selectInline(last.id, { push: false });
            else if (last.kind === "file") await selectFile(last.path, { push: false });
        } catch {
            state.selection = null;
            state.doc = null;
        }
    }

    /* ADR 0012: the panel is handed to the OS default browser as-is. The caller
     * never supplies a URL or a browser, and no result carries the capability. */
    function openPanelInBrowser() {
        const result = launchExternal(url);
        if (result?.ok) return { ok: true };
        return { ok: false, error: withoutCapability(result?.error) };
    }

    function withoutCapability(message) {
        const fallback = "Could not open in browser";
        if (typeof message !== "string" || message.length === 0) return fallback;
        return message.includes(capabilityToken) || message.includes(url) ? fallback : message;
    }

    return {
        url,
        assetPort,
        rendererPort,
        contentPort,
        state,
        setSource,
        openTarget,
        selectFile,
        selectInline,
        autoSelect,
        refreshListing,
        buildState,
        broadcast,
        dispose,
        openInBrowser: openPanelInBrowser,
        async showInline(id) {
            await refreshListing();
            return selectInline(id);
        },
        /** Listing for an arbitrary source, without changing what the panel shows. */
        async previewSource(source) {
            const root = source === SOURCE_PATH ? state.root : undefined;
            return listSource(
                { sessionId: ctx.sessionId, workspacePath: state.workspacePath },
                source,
                root,
            );
        },
    };
}

// ---------- shared helpers ----------

function pickPreferredFile(recent) {
    if (!Array.isArray(recent) || recent.length === 0) return null;
    // SkimDown's InitialSelectionPicker prefers a root README, then the newest file.
    const readme = recent.find(
        (entry) => !entry.relPath.includes("/") && /^readme\.(md|markdown)$/i.test(entry.name),
    );
    return readme || recent[0];
}

function displayPath(target) {
    return target;
}

function isInside(root, candidate) {
    const rel = path.relative(path.resolve(root), candidate);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isAllowedStaticAsset(role, relative) {
    const normalized = relative.replaceAll("\\", "/");
    if (role === "shell") return SHELL_ASSETS.has(normalized);
    // Chunks are an internal storage detail; only the assembled asset is served.
    if (chunkedAssets().chunkPaths.has(normalized)) return false;
    return RENDERER_ASSETS.has(normalized) || normalized.startsWith("vendor/");
}

function originOf(baseUri) {
    return new URL(baseUri).origin;
}

function shellCsp(rendererBaseUri) {
    return [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self'",
        "connect-src 'self'",
        `frame-src ${originOf(rendererBaseUri)}`,
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ].join("; ");
}

function rendererCsp(assetBaseUri, contentBaseUri) {
    return [
        "default-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "font-src 'self'",
        `img-src 'self' data: blob: ${originOf(contentBaseUri)}`,
        `media-src 'self' blob: ${originOf(contentBaseUri)}`,
        "connect-src 'none'",
        "frame-src 'none'",
        "worker-src 'none'",
        `frame-ancestors ${originOf(assetBaseUri)}`,
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ].join("; ");
}

function applySecurityHeaders(res, { csp, corp }) {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cross-Origin-Resource-Policy", corp);
    res.setHeader("Referrer-Policy", "no-referrer");
}

function openExternal(href) {
    if (!/^https?:\/\//i.test(href)) return { ok: false, error: "Only http/https URLs can be opened" };
    try {
        // Deliberately avoids cmd.exe so URL metacharacters can never be
        // interpreted as shell syntax.
        if (process.platform === "win32") {
            spawn("rundll32.exe", ["url.dll,FileProtocolHandler", href], {
                detached: true,
                stdio: "ignore",
            }).unref();
        } else if (process.platform === "darwin") {
            spawn("open", [href], { detached: true, stdio: "ignore" }).unref();
        } else {
            spawn("xdg-open", [href], { detached: true, stdio: "ignore" }).unref();
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error?.message || error) };
    }
}

async function readJsonBody(req, maxBytes) {
    const declaredLength = Number(req.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
        throw httpError(413, "request body too large");
    }

    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBytes) throw httpError(413, "request body too large");
        chunks.push(chunk);
    }
    if (chunks.length === 0) throw httpError(400, "JSON body is required");
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw httpError(400, "invalid JSON body");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw httpError(400, "JSON body must be an object");
    }
    return parsed;
}

function canonicalPath(value) {
    const resolved = path.resolve(value);
    try {
        return fs.realpathSync.native(resolved);
    } catch {
        return resolved;
    }
}

function hasExpectedHost(req, port) {
    return req.headers.host === `127.0.0.1:${port}`;
}

function validateProtectedRequest(req, parsed, expectedOrigin, capabilityToken, sse) {
    const suppliedToken = sse
        ? parsed.searchParams.get("token")
        : singleHeader(req.headers["x-skimdown-capability"]);
    if (!safeTokenEqual(suppliedToken, capabilityToken)) {
        return { status: 401, message: "invalid capability" };
    }

    if (singleHeader(req.headers["sec-fetch-site"]) !== "same-origin") {
        return { status: 403, message: "cross-site request denied" };
    }

    // Browsers omit `Origin` on same-origin GETs — including the `EventSource`
    // request behind the shell's event stream — so requiring it there would
    // reject the only client this server exists for. `Sec-Fetch-Site` above and
    // the capability already carry the CSRF boundary for reads; an `Origin`,
    // when the browser does send one, still has to match.
    const origin = singleHeader(req.headers.origin);
    const originRequired = req.method !== "GET";
    if ((originRequired && !origin) || (origin && origin !== expectedOrigin)) {
        return { status: 403, message: "invalid origin" };
    }
    return null;
}

function singleHeader(value) {
    return Array.isArray(value) ? value[0] : value;
}

function safeTokenEqual(left, right) {
    if (typeof left !== "string" || typeof right !== "string") return false;
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function isJsonContentType(value) {
    if (typeof value !== "string") return false;
    return value.split(";", 1)[0].trim().toLowerCase() === "application/json";
}

function httpError(statusCode, message) {
    return Object.assign(new Error(message), { statusCode });
}

function sendJson(res, status, payload, headers = {}) {
    const body = JSON.stringify(payload ?? null);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        ...headers,
    });
    res.end(body);
}

function endWithStatus(res, status, message) {
    if (res.headersSent) {
        res.end();
        return;
    }
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(message);
}

function listen(server) {
    return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
}

function portOf(server) {
    const address = server.address();
    return typeof address === "object" && address ? address.port : 0;
}

function closeServer(server) {
    return new Promise((resolve) => server.close(() => resolve()));
}

export { isMarkdownFile };
