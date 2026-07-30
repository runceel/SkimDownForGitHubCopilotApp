/* Resolution of the three reading sources the canvas offers.
 *
 *   session   — Markdown produced during this session:
 *               host artifacts (plan.md, files/**) + agent-written files +
 *               inline documents pushed through the `show_markdown` action.
 *   workspace — the session workspace root, browsed as a SkimDown folder tree.
 *   path      — any file or folder the agent/user points at.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { scan, buildTree, buildRecentList, statSafe, isMarkdownFile, toPosix } from "./scanner.mjs";
import { sessionArtifactsDir } from "./paths.mjs";
import { loadRegistry } from "./sessionDocs.mjs";

export const SOURCE_SESSION = "session";
export const SOURCE_WORKSPACE = "workspace";
export const SOURCE_PATH = "path";

/** Max bytes read for a single Markdown document. */
const MAX_DOC_BYTES = 8 * 1024 * 1024;

/**
 * Describe which sources are currently available so the shell can render the
 * source picker without guessing.
 */
export async function describeSources(ctx) {
    const artifacts = sessionArtifactsDir(ctx.sessionId);
    const hasArtifacts = Boolean(await statSafe(artifacts));
    return [
        {
            id: SOURCE_SESSION,
            label: "このセッション",
            detail: hasArtifacts ? artifacts : "エージェントが生成した Markdown",
            available: true,
        },
        {
            id: SOURCE_WORKSPACE,
            label: "ワークスペース",
            detail: ctx.workspacePath || "(ワークスペースなし)",
            available: Boolean(ctx.workspacePath),
        },
        {
            id: SOURCE_PATH,
            label: "パスを開く",
            detail: "任意のファイル / フォルダー",
            available: true,
        },
    ];
}

/**
 * Build the sidebar payload for a source.
 * Returns `{ source, root, rootLabel, mode, groups?, tree?, recent?, count }`.
 */
export async function listSource(ctx, source, rootOverride) {
    if (source === SOURCE_SESSION) return listSessionSource(ctx);

    const root = source === SOURCE_WORKSPACE ? ctx.workspacePath : rootOverride;
    if (!root) {
        return {
            source,
            root: null,
            rootLabel: source === SOURCE_WORKSPACE ? "(ワークスペースなし)" : "(パス未指定)",
            mode: "folder",
            tree: [],
            recent: [],
            count: 0,
        };
    }

    const files = await scan(root);
    return {
        source,
        root,
        rootLabel: path.basename(root) || root,
        mode: "folder",
        tree: buildTree(files),
        recent: buildRecentList(files),
        count: files.length,
    };
}

/**
 * The session source has no single root, so it is presented as grouped,
 * newest-first lists rather than a tree.
 */
async function listSessionSource(ctx) {
    const registry = await loadRegistry(ctx.sessionId);
    const artifactsRoot = sessionArtifactsDir(ctx.sessionId);

    const artifactFiles = await scan(artifactsRoot);
    const allArtifacts = artifactFiles
        .map((file) => ({
            type: "file",
            kind: file.relPath.startsWith("checkpoints/") ? "checkpoint" : "artifact",
            name: file.name,
            path: file.path,
            relPath: file.relPath,
            folder: file.relPath.includes("/")
                ? file.relPath.slice(0, file.relPath.lastIndexOf("/"))
                : "",
            mtimeMs: file.mtimeMs,
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs);

    const artifactEntries = allArtifacts.filter((entry) => entry.kind === "artifact");
    const checkpointEntries = allArtifacts.filter((entry) => entry.kind === "checkpoint");

    // Artifact paths must not reappear in the touched group, or the same
    // document would be listed twice.
    const artifactPaths = new Set(allArtifacts.map((entry) => entry.path.toLowerCase()));
    const touchedEntries = [];
    for (const entry of registry.touchedFiles) {
        if (artifactPaths.has(entry.path.toLowerCase())) continue;
        const meta = await statSafe(entry.path);
        if (!meta || !meta.isFile()) continue;
        touchedEntries.push({
            type: "file",
            kind: "touched",
            name: path.basename(entry.path),
            path: entry.path,
            relPath: relativeToWorkspace(ctx.workspacePath, entry.path),
            folder: folderLabel(ctx.workspacePath, entry.path),
            mtimeMs: meta.mtimeMs,
            touchedAt: entry.at,
        });
    }
    touchedEntries.sort((a, b) => b.touchedAt - a.touchedAt);

    const inlineEntries = registry.inlineDocs.map((doc) => ({
        type: "inline",
        kind: "inline",
        id: doc.id,
        name: doc.title,
        relPath: doc.id,
        folder: "",
        mtimeMs: doc.updatedAt,
    }));

    const groups = [
        { id: "inline", label: "エージェントが表示した Markdown", entries: inlineEntries },
        { id: "artifact", label: "セッション成果物", entries: artifactEntries },
        { id: "touched", label: "このセッションで編集したファイル", entries: touchedEntries },
        { id: "checkpoint", label: "チェックポイント", entries: checkpointEntries },
    ].filter((group) => group.entries.length > 0);

    const count = groups.reduce((sum, group) => sum + group.entries.length, 0);

    return {
        source: SOURCE_SESSION,
        root: null,
        rootLabel: "このセッション",
        mode: "session",
        groups,
        artifactsRoot,
        count,
    };
}

function relativeToWorkspace(workspacePath, target) {
    if (!workspacePath) return target;
    const rel = path.relative(workspacePath, target);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return target;
    return toPosix(rel);
}

function folderLabel(workspacePath, target) {
    const rel = relativeToWorkspace(workspacePath, target);
    if (rel === target) return shortenDir(path.dirname(target));
    return rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
}

/* Files outside the workspace would otherwise show a full absolute path in the
 * sidebar meta column, which crowds out the file name. The last couple of
 * segments are enough to tell two same-named files apart. */
function shortenDir(dir) {
    const parts = toPosix(dir).split("/").filter(Boolean);
    if (parts.length <= 2) return toPosix(dir);
    return `…/${parts.slice(-2).join("/")}`;
}

/** Read a Markdown document off disk, guarding size and encoding. */
export async function readMarkdownFile(absPath) {
    const meta = await statSafe(absPath);
    if (!meta || !meta.isFile()) {
        throw Object.assign(new Error(`Markdown file not found: ${absPath}`), { code: "not_found" });
    }
    if (!isMarkdownFile(absPath)) {
        throw Object.assign(new Error(`Not a Markdown file: ${absPath}`), { code: "not_markdown" });
    }
    if (meta.size > MAX_DOC_BYTES) {
        throw Object.assign(new Error(`Markdown file too large: ${absPath}`), { code: "too_large" });
    }
    const raw = await fs.readFile(absPath, "utf8");
    return {
        markdown: stripBom(raw),
        mtimeMs: meta.mtimeMs,
        size: meta.size,
    };
}

function stripBom(text) {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * Classify a user/agent supplied path so `open_path` can pick folder vs file
 * mode without the caller having to know. Relative paths resolve against
 * `baseDir` (the workspace root) rather than the extension host's cwd, which
 * is `$COPILOT_HOME` and never what the caller meant.
 */
export async function classifyPath(target, baseDir) {
    if (typeof target !== "string" || target.trim().length === 0) {
        return { kind: "invalid", reason: "パスが空です" };
    }
    const trimmed = target.trim();
    const resolved = path.isAbsolute(trimmed)
        ? path.resolve(trimmed)
        : path.resolve(baseDir || process.cwd(), trimmed);
    const meta = await statSafe(resolved);
    if (!meta) return { kind: "missing", path: resolved };
    if (meta.isDirectory()) return { kind: "folder", path: resolved };
    if (meta.isFile() && isMarkdownFile(resolved)) return { kind: "file", path: resolved };
    return { kind: "unsupported", path: resolved };
}
