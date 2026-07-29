/* Markdown discovery, mirroring SkimDown for Windows' MarkdownScanner /
 * MarkdownTreeBuilder / RecentMarkdownListBuilder:
 *
 *   - extensions: `.md`, `.markdown` (case-insensitive)
 *   - excluded directories at any depth: .git, node_modules, .build, DerivedData
 *   - hidden entries and dot-prefixed names are skipped
 *   - tree order: folders first, then case-insensitive name order
 *   - flat order: most recently modified first
 */

import fs from "node:fs/promises";
import path from "node:path";

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".build", "deriveddata"]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);

/** Depth guard so a pathological symlink loop cannot hang the extension. */
const MAX_DEPTH = 24;
/** Upper bound on discovered files, keeps huge monorepos from freezing the UI. */
const MAX_FILES = 5000;

export function isMarkdownFile(name) {
    return MARKDOWN_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function isExcludedDir(name) {
    return EXCLUDED_DIRS.has(name.toLowerCase());
}

function isHiddenName(name) {
    return name.startsWith(".");
}

/**
 * Recursively collect markdown files under `root`.
 * Returns `[{ path, relPath, name, size, mtimeMs }]` in unspecified order.
 */
export async function scan(root) {
    const results = [];
    if (!root) return results;

    let rootStat;
    try {
        rootStat = await fs.stat(root);
    } catch {
        return results;
    }
    if (!rootStat.isDirectory()) return results;

    await walk(root, root, 0, results);
    return results;
}

async function walk(root, dir, depth, results) {
    if (depth > MAX_DEPTH || results.length >= MAX_FILES) return;

    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return; // Unreadable directories are skipped, not fatal.
    }

    for (const entry of entries) {
        if (results.length >= MAX_FILES) return;
        const name = entry.name;
        if (!name || isHiddenName(name)) continue;

        const full = path.join(dir, name);

        if (entry.isDirectory()) {
            if (isExcludedDir(name)) continue;
            await walk(root, full, depth + 1, results);
            continue;
        }

        // Only regular files; symlinks are resolved via stat below.
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;
        if (!isMarkdownFile(name)) continue;

        const meta = await statSafe(full);
        if (!meta || !meta.isFile()) continue;

        results.push({
            path: full,
            relPath: toPosix(path.relative(root, full)),
            name,
            size: meta.size,
            mtimeMs: meta.mtimeMs,
        });
    }
}

export async function statSafe(target) {
    try {
        return await fs.stat(target);
    } catch {
        return null;
    }
}

export function toPosix(p) {
    return p.split(path.sep).join("/");
}

/**
 * Build a folder-first tree from scan results.
 * Nodes: `{ type: "dir", name, relPath, children }` and
 *        `{ type: "file", name, relPath, path, mtimeMs, size }`.
 */
export function buildTree(files) {
    const rootChildren = [];
    const dirIndex = new Map(); // relPath -> node

    const sorted = [...files].sort((a, b) => compareNames(a.relPath, b.relPath));

    for (const file of sorted) {
        const segments = file.relPath.split("/");
        const fileName = segments.pop();
        let children = rootChildren;
        let prefix = "";

        for (const segment of segments) {
            prefix = prefix ? `${prefix}/${segment}` : segment;
            let node = dirIndex.get(prefix);
            if (!node) {
                node = { type: "dir", name: segment, relPath: prefix, children: [] };
                dirIndex.set(prefix, node);
                children.push(node);
            }
            children = node.children;
        }

        children.push({
            type: "file",
            name: fileName,
            relPath: file.relPath,
            path: file.path,
            mtimeMs: file.mtimeMs,
            size: file.size,
        });
    }

    sortTree(rootChildren);
    return rootChildren;
}

function sortTree(nodes) {
    nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return compareNames(a.name, b.name);
    });
    for (const node of nodes) {
        if (node.type === "dir") sortTree(node.children);
    }
}

function compareNames(a, b) {
    const result = a.toLowerCase().localeCompare(b.toLowerCase());
    return result !== 0 ? result : a.localeCompare(b);
}

/** Flat list ordered by last-modified, newest first (SkimDown's "by date" mode). */
export function buildRecentList(files) {
    return [...files]
        .sort((a, b) => b.mtimeMs - a.mtimeMs || compareNames(a.relPath, b.relPath))
        .map((file) => ({
            type: "file",
            name: file.name,
            relPath: file.relPath,
            path: file.path,
            mtimeMs: file.mtimeMs,
            size: file.size,
            folder: file.relPath.includes("/")
                ? file.relPath.slice(0, file.relPath.lastIndexOf("/"))
                : "",
        }));
}
