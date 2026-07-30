/* Filesystem locations used by the SkimDown canvas.
 *
 * Durable state deliberately never lives under the session workspace: in the
 * GitHub Copilot app a project session's workspace *is* a git worktree, so
 * writing state there would pollute the user's repository. Everything goes to
 * `$COPILOT_HOME` instead (defaulting to `~/.copilot`).
 */

import { homedir } from "node:os";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import path from "node:path";
import fs from "node:fs/promises";

export const EXTENSION_NAME = "skimdown";
const stateLockContext = new AsyncLocalStorage();

export function copilotHome() {
    const configured = process.env.COPILOT_HOME;
    if (configured && configured.trim().length > 0) return path.resolve(configured.trim());
    return path.join(homedir(), ".copilot");
}

/** User-global artifacts directory: settings and per-session registries. */
export function artifactsDir() {
    return path.join(copilotHome(), "extensions", EXTENSION_NAME, "artifacts");
}

export function settingsFile() {
    return path.join(artifactsDir(), "settings.json");
}

function stateLockDir() {
    return path.join(artifactsDir(), ".state-locks");
}

export function sessionStateDir() {
    return path.join(artifactsDir(), "sessions");
}

/* Append-only renderer diagnostics.
 *
 * The preview runs in a nested iframe the extension process cannot inspect, so
 * when its boot fails the only evidence is what the page itself reports. Debug
 * logging goes to an ephemeral channel that is gone by the time anyone looks,
 * hence a file. */
export function diagFile() {
    return path.join(artifactsDir(), "diag.jsonl");
}

/* Written on every canvas boot, so without a cap the file grows forever. Keep
 * the tail: an entry is only interesting until the problem it describes has
 * been dealt with. */
const DIAG_MAX_LINES = 200;

export async function appendDiag(entry) {
    try {
        await ensureDir(artifactsDir());
        await fs.appendFile(diagFile(), JSON.stringify(entry) + "\n", "utf8");
        await trimDiag();
    } catch {
        // Diagnostics must never take the canvas down.
    }
}

async function trimDiag() {
    const lines = (await fs.readFile(diagFile(), "utf8")).split("\n").filter(Boolean);
    if (lines.length <= DIAG_MAX_LINES) return;
    await fs.writeFile(diagFile(), lines.slice(-DIAG_MAX_LINES).join("\n") + "\n", "utf8");
}

export function sessionStateFile(sessionId) {
    return path.join(sessionStateDir(), `${sanitizeId(sessionId)}.json`);
}

/** Where the host keeps this session's own artifacts (plan.md, files/). */
export function sessionArtifactsDir(sessionId) {
    return path.join(copilotHome(), "session-state", sanitizeId(sessionId));
}

function sanitizeId(sessionId) {
    const raw = typeof sessionId === "string" ? sessionId : "unknown";
    return raw.replace(/[^A-Za-z0-9._-]/g, "_") || "unknown";
}

export async function ensureDir(dir) {
    await fs.mkdir(dir, { recursive: true });
}

/**
 * Serialize settings and session-history mutations across extension processes.
 * A stale lock can only remain after a crashed process, so reclaim it after a
 * generous timeout.
 */
export async function withStateLock(operation) {
    if (stateLockContext.getStore() === true) return operation();

    const lockDir = stateLockDir();
    await ensureDir(lockDir);
    const deadline = Date.now() + 5000;
    const ticketName = `${process.pid}-${randomUUID()}.lock`;
    const ticketFile = path.join(lockDir, ticketName);
    await fs.writeFile(ticketFile, "", { encoding: "utf8", flag: "wx" });
    const publishedAt = (await fs.stat(ticketFile)).mtimeMs;

    try {
        while (true) {
            const tickets = await listLiveLockTickets(lockDir);
            // Order is based on filesystem publication, not intent. Waiting
            // past the timestamp bucket prevents a same-tick ticket from
            // appearing later with an earlier lexical tie-breaker.
            if (tickets[0] === ticketName && Date.now() >= publishedAt + 10) {
                return await stateLockContext.run(true, operation);
            }
            if (Date.now() >= deadline) throw new Error("Timed out waiting for the SkimDown state lock.");
            await delay(25);
        }
    } finally {
        await fs.unlink(ticketFile).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
        });
    }
}

async function listLiveLockTickets(lockDir) {
    const names = (await fs.readdir(lockDir))
        .filter((name) => /^\d+-[0-9a-f-]+\.lock$/i.test(name));
    const live = [];
    const now = Date.now();

    for (const name of names) {
        let meta;
        try {
            meta = await fs.stat(path.join(lockDir, name));
        } catch (error) {
            if (error?.code === "ENOENT") continue;
            throw error;
        }
        const pid = Number(/^(\d+)-/.exec(name)?.[1]);
        const stale =
            !Number.isSafeInteger(pid)
            || !isProcessAlive(pid)
            || now - meta.mtimeMs > 60 * 60 * 1000;
        if (!stale) {
            live.push({ name, publishedAt: meta.mtimeMs });
            continue;
        }
        await fs.unlink(path.join(lockDir, name)).catch((error) => {
            if (error?.code !== "ENOENT") throw error;
        });
    }
    return live
        .sort((a, b) => a.publishedAt - b.publishedAt || a.name.localeCompare(b.name))
        .map((ticket) => ticket.name);
}

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return error?.code !== "ESRCH";
    }
}

function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/* Resolve the folder the "ワークスペース" source should show.
 *
 * `session.workspacePath` is not always the code checkout: in the GitHub
 * Copilot app it can point at the session-state directory instead. Since the
 * whole point of this canvas is reading the Markdown that lives next to the
 * code, prefer the nearest enclosing git repository over whatever the SDK
 * reports, falling back gracefully when nothing looks like a checkout.
 */
export async function resolveWorkspaceRoot(reported) {
    const candidates = [];
    const push = (value) => {
        if (typeof value === "string" && value.trim().length > 0) {
            candidates.push(path.resolve(value.trim()));
        }
    };

    push(reported);
    push(process.cwd());
    // Project-scoped installs live at `<repo>/.github/extensions/skimdown`, so
    // the checkout is an ancestor of this file.
    push(path.dirname(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")));

    const seen = new Set();
    const unique = candidates.filter((dir) => {
        const key = dir.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    for (const dir of unique) {
        const repo = await findGitRoot(dir);
        if (repo) return repo;
    }
    return unique[0] || null;
}

async function findGitRoot(start) {
    let current = start;
    for (let depth = 0; depth < 24; depth += 1) {
        try {
            await fs.stat(path.join(current, ".git"));
            return current;
        } catch {
            // Keep walking up; a missing .git is the common case.
        }
        const parent = path.dirname(current);
        if (parent === current) return null;
        current = parent;
    }
    return null;
}

/** Write JSON atomically so a crash mid-write cannot corrupt durable state. */
export async function writeJsonAtomic(file, value) {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
    await fs.rename(tmp, file);
}

export async function readJson(file, fallback) {
    try {
        const text = await fs.readFile(file, "utf8");
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === "object") return parsed;
    } catch {
        // Missing or corrupt state falls back to defaults rather than failing
        // the whole canvas.
    }
    return fallback;
}
