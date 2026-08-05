// SkimDown — a calm, read-only Markdown reader canvas.
//
// Port of SkimDown for Windows (WinUI 3 + WebView2) to a GitHub Copilot app
// extension canvas, specialised for two jobs: reading the Markdown produced
// during the current session, and reading existing Markdown on disk.
//
// The Markdown rendering pipeline (markdown-it + highlight.js + DOMPurify +
// KaTeX + Mermaid, GitHub alerts, task lists, colour swatches, in-document
// search, Mermaid zoom) is `web/renderer.js`, maintained from SkimDown for
// Windows with narrowly scoped, regression-tested security hardening when a
// safe upstream revision is not yet available, including document-scoped
// remote-content consent. `web/bridge.js` re-implements the WebView2 host
// channel it expects on top of postMessage.
//
// Wiring only lives here; the real work is in ./lib.

import path from "node:path";
import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";

import { createInstance } from "./lib/server.mjs";
import { createLogger } from "./lib/log.mjs";
import { addInlineDoc, recordTouchedFile } from "./lib/sessionDocs.mjs";
import { isMarkdownFile } from "./lib/scanner.mjs";
import { classifyPath, SOURCE_SESSION } from "./lib/sources.mjs";

/** instanceId -> instance returned by createInstance(). */
const instances = new Map();

/** Tool names whose arguments name a file the agent just wrote. */
const FILE_WRITING_TOOLS = new Set([
    "create",
    "edit",
    "str_replace",
    "str_replace_editor",
    "write",
    "write_file",
    "create_file",
    "edit_file",
    "apply_patch",
    "multi_edit",
    "notebook_edit",
]);

/** Argument keys that, across tools, carry the target path. */
const PATH_KEYS = ["path", "file_path", "filePath", "filename", "file", "target_file", "notebook_path"];

let session;

/* stdout is the JSON-RPC channel, so console.log would corrupt the protocol.
 * Everything user-facing goes through session.log, which absorbs its own
 * failures so logging can never break the canvas. */
const log = createLogger(() => session);

/* Last resort. A failure anywhere in an unawaited promise would otherwise end
 * the extension process and take the reader down with it, so the reason is
 * recorded and the canvas is left running. stderr is the fallback because
 * stdout belongs to JSON-RPC. */
function reportFatal(kind, error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    log(`skimdown: ${kind} — ${detail}`, { level: "error" });
    try {
        process.stderr.write(`[skimdown] ${kind}: ${detail}\n`);
    } catch {
        // Nothing left to report through.
    }
}

process.on("unhandledRejection", (reason) => {
    reportFatal("unhandled rejection", reason);
});

process.on("uncaughtException", (error) => {
    reportFatal("uncaught exception", error);
});

async function getInstance(instanceId) {
    const instance = instances.get(instanceId);
    if (!instance) {
        throw new CanvasError("canvas_instance_unknown", `Canvas instance not open: ${instanceId}`);
    }
    return instance;
}

/* The only outward call this provider makes. It is reached from `/api/ask`,
 * which is reached only from a button or a keystroke in the reader, so a turn
 * appears in the transcript only when the reader asked for one. `enqueue` keeps
 * a question from cutting into a turn that is already running. */
async function askSession(message) {
    if (typeof session?.send !== "function") {
        throw new Error("this session does not accept messages");
    }
    return session.send({
        prompt: message.prompt,
        attachments: message.attachments,
        displayPrompt: message.displayPrompt,
        mode: "enqueue",
    });
}

/** `open` must be idempotent: the runtime replays it after provider reconnects. */
async function openCanvas(ctx) {
    let instance = instances.get(ctx.instanceId);
    if (!instance) {
        instance = await createInstance({
            instanceId: ctx.instanceId,
            sessionId: session.sessionId,
            workspacePath: session.workspacePath,
            log,
            ask: askSession,
        });
        instances.set(ctx.instanceId, instance);
    }

    const input = ctx.input && typeof ctx.input === "object" ? ctx.input : {};

    if (typeof input.markdown === "string" && input.markdown.length > 0) {
        const doc = await addInlineDoc(session.sessionId, {
            markdown: input.markdown,
            title: input.title,
            id: input.id,
        });
        await instance.setSource(SOURCE_SESSION);
        await instance.showInline(doc.id);
    } else if (Array.isArray(input.documents) && input.documents.length > 0) {
        await instance.presentDocumentSet({
            id: input.id,
            title: input.title,
            documents: input.documents,
        });
    } else if (typeof input.path === "string" && input.path.trim().length > 0) {
        await instance.openTarget(input.path, { approve: true });
    } else if (typeof input.source === "string") {
        await instance.setSource(input.source);
    }

    return {
        title: titleFor(instance),
        status: statusFor(instance),
        url: instance.url,
    };
}

function titleFor(instance) {
    const selection = instance.state.selection;
    return selection?.title ? `${selection.title} — SkimDown` : "SkimDown";
}

function statusFor(instance) {
    const listing = instance.state.listing;
    if (!listing) return "";
    return `${listing.rootLabel} · ${listing.count} ${listing.count === 1 ? "item" : "items"}`;
}

const DOCUMENT_SET_ITEM_SCHEMA = {
    type: "object",
    additionalProperties: false,
    properties: {
        path: {
            type: "string",
            description: "Absolute path to an existing Markdown file. Use this or `markdown`.",
        },
        markdown: {
            type: "string",
            description: "Markdown text to show without writing a file. Use this or `path`.",
        },
        title: { type: "string", description: "Optional label shown in the sidebar." },
        description: {
            type: "string",
            description: "Optional one-line note shown under the title, such as why it matters.",
        },
    },
};

const canvas = createCanvas({
    id: "skimdown",
    displayName: "SkimDown",
    description:
        "Read Markdown in a calm, read-only SkimDown reader — documents generated during this session, or any existing Markdown file or folder.",
    inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
            path: {
                type: "string",
                description: "Absolute path to a Markdown file or a folder to browse.",
            },
            markdown: {
                type: "string",
                description: "Markdown text to display immediately, without writing a file.",
            },
            documents: {
                type: "array",
                minItems: 1,
                maxItems: 25,
                items: DOCUMENT_SET_ITEM_SCHEMA,
                description:
                    "An ordered set of Markdown documents to present for review, in reading order.",
            },
            title: {
                type: "string",
                description:
                    "Title for the inline Markdown supplied via `markdown`, or the name of the `documents` set.",
            },
            id: {
                type: "string",
                description:
                    "Stable id for the inline document, so re-opening replaces it instead of adding a duplicate.",
            },
            source: {
                type: "string",
                enum: ["session", "workspace", "path"],
                description:
                    "Which source to show: this session's output, the workspace, or an explicit path.",
            },
        },
    },
    actions: [
        {
            name: "show_markdown",
            description:
                "Display Markdown text in the canvas without writing it to disk, and select it.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["markdown"],
                properties: {
                    markdown: { type: "string", description: "The Markdown source to render." },
                    title: { type: "string", description: "Optional title; defaults to the first heading." },
                    id: {
                        type: "string",
                        description: "Optional stable id so repeated calls update the same document.",
                    },
                },
            },
            handler: async (ctx) => {
                const instance = await getInstance(ctx.instanceId);
                const input = ctx.input || {};
                if (typeof input.markdown !== "string" || input.markdown.length === 0) {
                    throw new CanvasError("invalid_input", "`markdown` must be a non-empty string.");
                }
                const doc = await addInlineDoc(session.sessionId, {
                    markdown: input.markdown,
                    title: input.title,
                    id: input.id,
                });
                await instance.setSource(SOURCE_SESSION);
                await instance.showInline(doc.id);
                return { id: doc.id, title: doc.title, characters: doc.markdown.length };
            },
        },
        {
            name: "show_markdown_set",
            description:
                "Present an ordered set of Markdown documents for the reader to review. Files and inline Markdown can be mixed, the set replaces any previous one, and the reader can step through it with previous/next.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["documents"],
                properties: {
                    documents: {
                        type: "array",
                        minItems: 1,
                        maxItems: 25,
                        items: DOCUMENT_SET_ITEM_SCHEMA,
                        description: "The documents to review, in reading order.",
                    },
                    title: {
                        type: "string",
                        description:
                            "Optional name for the set, shown as the sidebar heading. Defaults to \"Documents to review\".",
                    },
                    id: {
                        type: "string",
                        description: "Optional stable id so repeated calls update the same set.",
                    },
                },
            },
            handler: async (ctx) => {
                const instance = await getInstance(ctx.instanceId);
                const input = ctx.input || {};
                if (!Array.isArray(input.documents) || input.documents.length === 0) {
                    throw new CanvasError("invalid_input", "`documents` must be a non-empty array.");
                }
                try {
                    return await instance.presentDocumentSet({
                        id: input.id,
                        title: input.title,
                        documents: input.documents,
                    });
                } catch (error) {
                    throw new CanvasError(error?.code || "open_failed", error?.message || String(error));
                }
            },
        },
        {
            name: "open_path",
            description: "Open a Markdown file, or browse a folder's Markdown tree, in the canvas.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                required: ["path"],
                properties: {
                    path: { type: "string", description: "Absolute path to a Markdown file or a folder." },
                },
            },
            handler: async (ctx) => {
                const instance = await getInstance(ctx.instanceId);
                try {
                    return await instance.openTarget(String(ctx.input?.path ?? ""), { approve: true });
                } catch (error) {
                    throw new CanvasError(error?.code || "open_failed", error?.message || String(error));
                }
            },
        },
        {
            name: "open_session",
            description: "Switch the canvas to the Markdown produced during this session.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            handler: async (ctx) => {
                const instance = await getInstance(ctx.instanceId);
                await instance.setSource(SOURCE_SESSION);
                return { source: SOURCE_SESSION, count: instance.state.listing?.count ?? 0 };
            },
        },
        {
            name: "refresh",
            description: "Rescan the current source and push the updated file list to the canvas.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            handler: async (ctx) => {
                const instance = await getInstance(ctx.instanceId);
                const listing = await instance.refreshListing({ push: true });
                return { count: listing?.count ?? 0, root: listing?.root ?? null };
            },
        },
        {
            name: "list_files",
            description:
                "Return the Markdown documents currently listed in the canvas, so they can be reasoned about.",
            inputSchema: {
                type: "object",
                additionalProperties: false,
                properties: {
                    source: {
                        type: "string",
                        enum: ["session", "workspace", "path"],
                        description:
                            "List this source instead of the one currently shown. Does not change the panel.",
                    },
                },
            },
            handler: async (ctx) => {
                const instance = await getInstance(ctx.instanceId);
                const requested = ctx.input?.source;
                const listing = requested
                    ? await instance.previewSource(requested)
                    : instance.state.listing;
                if (!listing) return { source: instance.state.source, entries: [] };

                if (listing.mode === "session") {
                    return {
                        source: listing.source,
                        entries: (listing.groups || []).flatMap((group) =>
                            group.entries.map((entry) => ({
                                group: group.label,
                                kind: entry.kind,
                                name: entry.name,
                                path: entry.path ?? null,
                                id: entry.id ?? null,
                            })),
                        ),
                    };
                }

                return {
                    source: listing.source,
                    root: listing.root,
                    entries: (listing.recent || []).map((entry) => ({
                        name: entry.name,
                        relPath: entry.relPath,
                        path: entry.path,
                        modifiedAt: new Date(entry.mtimeMs).toISOString(),
                    })),
                };
            },
        },
        {
            name: "get_state",
            description: "Return which source, root, and document the canvas is currently showing.",
            inputSchema: { type: "object", additionalProperties: false, properties: {} },
            handler: async (ctx) => {
                const instance = await getInstance(ctx.instanceId);
                return {
                    source: instance.state.source,
                    root: instance.state.root,
                    rootLabel: instance.state.listing?.rootLabel ?? null,
                    count: instance.state.listing?.count ?? 0,
                    selection: instance.state.selection,
                };
            },
        },
    ],
    open: openCanvas,
    onClose: async (ctx) => {
        const instance = instances.get(ctx.instanceId);
        if (!instance) return;
        instances.delete(ctx.instanceId);
        await instance.dispose();
    },
});

/**
 * Track Markdown files the agent writes so the "this session" source can list
 * them. Only cheap string inspection happens on the hot path.
 */
function parseToolArgs(raw) {
    // The runtime delivers tool arguments as a JSON string for some tools and
    // as an already-parsed object for others.
    if (raw && typeof raw === "object") return raw;
    if (typeof raw !== "string" || raw.length === 0) return null;
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
        return null;
    }
}

async function onPostToolUse(input) {
    try {
        if (!FILE_WRITING_TOOLS.has(String(input?.toolName || "").toLowerCase())) return;
        const args = parseToolArgs(input.toolArgs);
        if (!args) return;

        for (const key of PATH_KEYS) {
            const value = args[key];
            if (typeof value !== "string" || value.length === 0) continue;
            if (!isMarkdownFile(value)) continue;

            const absolute = path.isAbsolute(value)
                ? value
                : path.resolve(input.workingDirectory || process.cwd(), value);
            const classified = await classifyPath(absolute);
            if (classified.kind !== "file") return;

            await recordTouchedFile(session.sessionId, classified.path, input.toolName);
            return;
        }
    } catch (error) {
        log(`skimdown: failed to record tool output — ${error?.message || error}`);
    }
}

/* Startup is the one failure the guards above must not hide: without a session
 * there is no canvas to keep alive, so a join failure stays fatal and visible
 * to the host. Only failures after this point are survivable. */
try {
    session = await joinSession({
        canvases: [canvas],
        hooks: { onPostToolUse },
    });
} catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`[skimdown] failed to join session: ${detail}\n`);
    process.exit(1);
}
