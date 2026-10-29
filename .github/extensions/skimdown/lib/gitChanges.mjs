import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { watch } from "node:fs";
import path from "node:path";
import { lineDiff } from "./lineDiff.mjs";

const MAX_BYTES = 8 * 1024 * 1024;
const MAX_TREE_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 10000;

function inside(root, file) {
    const relative = path.relative(root, file);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function gitEnvironment(base = process.env) {
    const env = {
        LC_ALL: "C",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_NO_LAZY_FETCH: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_ALLOW_PROTOCOL: "",
    };
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP"]) {
        if (base[key]) env[key] = base[key];
    }
    return env;
}

// Never search the working directory or a repository-supplied PATH.
export async function resolveGit(root) {
    if (process.platform === "darwin") {
        try {
            const { stdout } = await promisify(execFile)("/usr/bin/xcode-select", ["-p"], {
                env: gitEnvironment(), timeout: 5000, maxBuffer: 4096,
            });
            await fs.access(path.join(stdout.trim(), "usr", "bin", "git"));
        } catch {
            throw new Error("Git changes unavailable: install the Xcode Command Line Tools.");
        }
    }
    const candidates = process.platform === "win32"
        ? [
            process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Git", "cmd", "git.exe"),
            process.env["ProgramFiles(x86)"] && path.join(process.env["ProgramFiles(x86)"], "Git", "cmd", "git.exe"),
            process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd", "git.exe"),
        ]
        : ["/usr/bin/git", "/usr/local/bin/git"];
    for (const candidate of candidates.filter(Boolean)) {
        try {
            const executable = await fs.realpath(candidate);
            if (!inside(root, executable) && (await fs.stat(executable)).isFile()) return executable;
        } catch (error) {
            if (!["ENOENT", "ENOTDIR"].includes(error.code)) throw error;
        }
    }
    throw new Error("Git changes unavailable: install Git in a standard system location.");
}

export function runGit(executable, root, args, {
    input, accepted = [0], timeout = TIMEOUT_MS, maxBytes = MAX_TREE_BYTES, signal,
} = {}) {
    if (!["rev-parse", "ls-tree", "ls-files", "cat-file", "check-ignore"].includes(args[0])) {
        return Promise.reject(new Error("Git changes unavailable: unsupported Git command."));
    }
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [
            "--no-pager", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", ...args,
        ], { cwd: root, env: gitEnvironment(), windowsHide: true, shell: false, stdio: ["pipe", "pipe", "pipe"], signal });
        const chunks = [];
        let bytes = 0;
        let failure;
        const fail = (message) => {
            failure ||= new Error(message);
            child.kill();
        };
        const timer = setTimeout(() => fail("Git changes unavailable: Git timed out."), timeout);
        child.stdout.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > maxBytes) fail("Git changes unavailable: Git output exceeds the size limit.");
            else chunks.push(chunk);
        });
        // Drain stderr, but never log paths, repository text, or config values.
        child.stderr.resume();
        child.stdin.on("error", (error) => {
            if (error.code !== "EPIPE") fail("Git changes unavailable: Git input failed.");
        });
        child.on("error", (error) => {
            failure ||= error.name === "AbortError" ? error : new Error("Git changes unavailable: Git could not be started.");
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (failure) return reject(failure);
            if (!accepted.includes(code)) return reject(new Error("Git changes unavailable: a read-only Git command failed."));
            resolve({ code, output: Buffer.concat(chunks) });
        });
        child.stdin.end(input);
    });
}

const records = (buffer) => buffer.toString("utf8").split("\0").filter(Boolean);
const key = (name) => name.normalize("NFC");
const text = (buffer) => buffer.toString("utf8").replace(/^\uFEFF/, "");

export async function openGitRepository(folder, { signal } = {}) {
    const root = await fs.realpath(folder);
    try {
        await fs.lstat(path.join(root, ".git"));
    } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
    }
    const executable = await resolveGit(root);
    const run = (args, options) => runGit(executable, root, args, { signal, ...options });
    const { output } = await run([
        "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir", "--git-common-dir", "--show-object-format",
    ]);
    const [top, gitDir, commonDir, format] = output.toString("utf8").trimEnd().split(/\r?\n/);
    if (!top || await fs.realpath(top) !== root || !["sha1", "sha256"].includes(format)) return null;
    return { root, gitDir, commonDir, format, run };
}

async function snapshot(repo) {
    const head = await repo.run(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"], { accepted: [0, 1] });
    const blobs = new Map();
    if (head.code === 0) {
        const oid = head.output.toString("utf8").trim();
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid)) throw new Error("Git changes unavailable: invalid tree ID.");
        const { output } = await repo.run(["ls-tree", "-r", "-z", oid]);
        for (const record of records(output)) {
            const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]*)$/.exec(record);
            if (match && match[1] !== "120000") blobs.set(key(match[3]), match[2]);
        }
    }
    const index = await repo.run(["ls-files", "-z", "--cached"]);
    return { blobs, indexed: new Set(records(index.output).map(key)) };
}

export function blobID(data, format = "sha1") {
    return createHash(format).update(`blob ${data.length}\0`).update(data).digest("hex");
}

export function isReferenceEvent(relative) {
    const name = relative.split(path.sep).join("/");
    return !name.endsWith(".lock")
        && (["HEAD", "index", "packed-refs", "commondir", "refs"].includes(name) || name.startsWith("refs/"));
}

export function createGitTracker(onChange, onError) {
    let watchers = [];
    let timer;
    let disposed = false;
    let revision = 0;
    let active;
    let work = Promise.resolve();

    function stopWatching() {
        clearTimeout(timer);
        for (const watcher of watchers) watcher.close();
        watchers = [];
    }

    async function watchReferences(repo, signal) {
        const roots = [...new Set([repo.gitDir, repo.commonDir])];
        // A separate refs watch supplies recursive coverage even on Linux.
        const targets = new Set(roots);
        async function addRefDirs(dir) {
            try {
                for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                    if (entry.isDirectory()) {
                        const next = path.join(dir, entry.name);
                        targets.add(next);
                        await addRefDirs(next);
                    }
                }
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
        for (const root of roots) {
            targets.add(path.join(root, "refs"));
            await addRefDirs(path.join(root, "refs"));
        }
        for (const dir of targets) {
            if (signal.aborted) return;
            try {
                const watcher = watch(dir, { persistent: false }, (_event, file) => {
                    const changed = file ? path.join(dir, String(file)) : dir;
                    if (file && !roots.some((root) => isReferenceEvent(path.relative(root, changed)))) return;
                    clearTimeout(timer);
                    timer = setTimeout(() => { if (!disposed) onChange(); }, 300);
                });
                watcher.on("error", () => onError("Git changes unavailable: reference watching failed."));
                watchers.push(watcher);
            } catch (error) {
                if (error.code !== "ENOENT") throw error;
            }
        }
    }

    async function calculate(root, files, doc) {
        if (disposed) return { statuses: {}, gitDiff: null, error: null };
        stopWatching();
        if (!root) return { statuses: {}, gitDiff: null, error: null };
        const controller = new AbortController();
        active = controller;
        const { signal } = controller;
        try {
            const repo = await openGitRepository(root, { signal });
            if (!repo || signal.aborted) return { statuses: {}, gitDiff: null, error: null };
            await watchReferences(repo, signal);
            const { blobs, indexed } = await snapshot(repo);
            const statuses = {};
            const candidates = new Map();
            for (const file of new Set([...files, ...(doc?.path ? [doc.path] : [])])) {
                if (signal.aborted) return { statuses: {}, gitDiff: null, error: null };
                let resolved;
                try {
                    resolved = await fs.realpath(file);
                } catch (error) {
                    if (error.code === "ENOENT") continue;
                    throw error;
                }
                if (!inside(repo.root, resolved) || resolved === repo.root) continue;
                const relative = path.relative(repo.root, resolved).split(path.sep).join("/");
                candidates.set(file, relative);
            }
            const unknown = [...candidates.values()].filter((relative) => !blobs.has(key(relative)) && !indexed.has(key(relative)));
            const ignored = unknown.length
                ? new Set(records((await repo.run(["check-ignore", "-z", "--stdin"], {
                    input: Buffer.from(unknown.join("\0") + "\0"), accepted: [0, 1],
                })).output).map(key))
                : new Set();
            let base;
            for (const [file, relative] of candidates) {
                if (signal.aborted) return { statuses: {}, gitDiff: null, error: null };
                const oid = blobs.get(key(relative));
                if (!oid && ignored.has(key(relative))) continue;
                if (!oid) {
                    statuses[file] = indexed.has(key(relative)) ? "A" : "U";
                    if (file === doc?.path) base = "";
                    continue;
                }
                if ((await fs.stat(file)).size > MAX_BYTES) throw new Error("Git changes unavailable: Markdown exceeds the size limit.");
                const data = await fs.readFile(file);
                if (blobID(data, repo.format) !== oid
                    && blobID(Buffer.from(data.toString("utf8").replace(/\r\n/g, "\n")), repo.format) !== oid) {
                    statuses[file] = "M";
                }
                if (file === doc?.path && statuses[file]) {
                    base = text((await repo.run(["cat-file", "blob", oid], { maxBytes: MAX_BYTES })).output);
                }
            }
            const hunks = base === undefined ? [] : lineDiff(base, doc.markdown);
            return { statuses, gitDiff: hunks.length ? { hunks } : null, error: null };
        } catch (error) {
            if (signal.aborted) return { statuses: {}, gitDiff: null, error: null };
            // Only fixed messages cross the diagnostic boundary.
            const message = error.message.startsWith("Git changes unavailable:")
                ? error.message : "Git changes unavailable: the repository could not be read.";
            onError(message);
            return { statuses: {}, gitDiff: null, error: message };
        } finally {
            if (active === controller) active = null;
        }
    }

    return {
        refresh(root, files, doc) {
            const request = ++revision;
            active?.abort();
            stopWatching();
            const pending = work.then(() => request === revision
                ? calculate(root, files, doc)
                : { statuses: {}, gitDiff: null, error: null });
            work = pending.catch(() => {});
            return pending;
        },
        async dispose() {
            disposed = true;
            revision++;
            active?.abort();
            stopWatching();
            await work;
            stopWatching();
        },
    };
}
