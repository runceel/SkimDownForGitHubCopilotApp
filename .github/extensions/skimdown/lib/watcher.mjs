/* Debounced recursive folder watching for live reload.
 *
 * `fs.watch` with `recursive: true` is supported on Windows and macOS; on Linux
 * Node falls back to a non-recursive watch, so we degrade gracefully rather than
 * throwing. Events are coalesced because editors and agents commonly emit a
 * burst of writes for a single logical save.
 */

import fs from "node:fs";
import path from "node:path";

const DEBOUNCE_MS = 150;

export function createWatcher(onChange) {
    /** @type {Map<string, fs.FSWatcher>} */
    const watchers = new Map();
    let timer = null;
    let pending = new Set();
    let disposed = false;

    function flush() {
        timer = null;
        const changed = pending;
        pending = new Set();
        if (disposed) return;
        try {
            onChange([...changed]);
        } catch {
            // A failing consumer must not kill the watcher.
        }
    }

    function schedule(changedPath) {
        if (changedPath) pending.add(changedPath);
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, DEBOUNCE_MS);
    }

    function watchDir(dir) {
        if (disposed || !dir || watchers.has(dir)) return;
        let watcher;
        try {
            watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
                // Ignore churn we can never display, otherwise a busy build
                // directory would rescan the tree continuously.
                if (filename && !isInteresting(filename.toString())) return;
                schedule(filename ? path.join(dir, filename.toString()) : dir);
            });
        } catch {
            try {
                watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
                    if (filename && !isInteresting(filename.toString())) return;
                    schedule(filename ? path.join(dir, filename.toString()) : dir);
                });
            } catch {
                return; // Unwatchable path (deleted, permission denied, ...).
            }
        }
        watcher.on("error", () => {
            unwatchDir(dir);
        });
        watchers.set(dir, watcher);
    }

    function unwatchDir(dir) {
        const watcher = watchers.get(dir);
        if (!watcher) return;
        watchers.delete(dir);
        try {
            watcher.close();
        } catch {
            // Already closed.
        }
    }

    /** Replace the watched set with exactly `dirs`. */
    function setDirs(dirs) {
        const wanted = new Set((dirs || []).filter(Boolean).map((dir) => path.resolve(dir)));
        for (const dir of [...watchers.keys()]) {
            if (!wanted.has(dir)) unwatchDir(dir);
        }
        for (const dir of wanted) watchDir(dir);
    }

    function dispose() {
        disposed = true;
        if (timer) clearTimeout(timer);
        timer = null;
        for (const dir of [...watchers.keys()]) unwatchDir(dir);
    }

    return { setDirs, dispose };
}

function isInteresting(relName) {
    const lower = relName.toLowerCase().split(path.sep).join("/");
    if (lower.includes("/.git/") || lower.startsWith(".git/")) return false;
    if (lower.includes("/node_modules/") || lower.startsWith("node_modules/")) return false;
    // Editors write temp/lock files next to the real file; those are noise.
    if (lower.endsWith("~") || lower.endsWith(".tmp") || lower.endsWith(".swp")) return false;
    return true;
}
