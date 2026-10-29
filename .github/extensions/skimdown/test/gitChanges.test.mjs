import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
    blobID, createGitTracker, gitEnvironment, isReferenceEvent, openGitRepository, resolveGit, runGit,
} from "../lib/gitChanges.mjs";
import { lineDiff, sourceLines } from "../lib/lineDiff.mjs";
import { createInstance } from "../lib/server.mjs";
import { loadSettings, updateSettings } from "../lib/settings.mjs";
import { settingsFile } from "../lib/paths.mjs";

const exec = promisify(execFile);

async function fixture(t, format = "sha1") {
    const root = await mkdtemp(path.join(tmpdir(), "skimdown-git-"));
    const executable = await resolveGit(root);
    const git = (...args) => exec(executable, [
        "-c", "user.name=SkimDown Tests", "-c", "user.email=tests@example.invalid",
        "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
        "-c", "init.defaultBranch=main", ...args,
    ], { cwd: root, env: gitEnvironment(), windowsHide: true });
    await git("init", "--quiet", `--object-format=${format}`);
    const write = async (relative, content) => {
        const absolute = path.join(root, relative);
        await mkdir(path.dirname(absolute), { recursive: true });
        await writeFile(absolute, content);
        return absolute;
    };
    const errors = [];
    const tracker = createGitTracker(() => {}, (error) => errors.push(error));
    t.after(async () => {
        await tracker.dispose();
        await rm(root, { recursive: true, force: true });
    });
    return { root, executable, git, write, tracker, errors };
}

test("line hunks cover replacement, insertion, deletion, BOM, and line endings", () => {
    assert.deepEqual(sourceLines("\uFEFFa\r\nb\r"), ["a", "b"]);
    assert.deepEqual(lineDiff("\uFEFFa\r\n", "a\n"), []);
    assert.deepEqual(lineDiff("a\nb\nc\n", "a\nnew\nc\nextra\n"), [
        { oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, oldLines: ["b"] },
        { oldStart: 3, oldCount: 0, newStart: 3, newCount: 1, oldLines: [] },
    ]);
    assert.deepEqual(lineDiff("a\nb\n", "a\n"), [
        { oldStart: 1, oldCount: 1, newStart: 1, newCount: 0, oldLines: ["b"] },
    ]);
    assert.equal(lineDiff("", "a\nb\n")[0].newCount, 2);
    assert.equal(lineDiff("old\n".repeat(2000), "new\n".repeat(2000))[0].oldCount, 2000);
});

test("Git environment drops inherited redirects, config injection, and search paths", () => {
    const env = gitEnvironment({
        PATH: ".", GIT_DIR: "evil", GIT_WORK_TREE: "evil", GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.fsmonitor", GIT_CONFIG_VALUE_0: "evil", NODE_OPTIONS: "--require=evil",
    });
    assert.equal(env.GIT_NO_LAZY_FETCH, "1");
    assert.equal(env.GIT_OPTIONAL_LOCKS, "0");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.GIT_ALLOW_PROTOCOL, "");
    for (const key of ["PATH", "GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG_COUNT", "NODE_OPTIONS"]) {
        assert.equal(env[key], undefined);
    }
});

test("root-only tracking handles unborn HEAD, added, untracked, ignored, and disabled", async (t) => {
    const f = await fixture(t);
    const added = await f.write("added.md", "added\n");
    const untracked = await f.write("new.md", "new\n");
    const ignored = await f.write("ignored.md", "ignored\n");
    await f.write(".gitignore", "ignored.md\n");
    await f.git("add", "added.md");
    const result = await f.tracker.refresh(f.root, [added, untracked, ignored], { path: untracked, markdown: "new\n" });
    assert.deepEqual(result.statuses, { [added]: "A", [untracked]: "U" });
    assert.equal(result.gitDiff.hunks[0].newCount, 1);
    assert.equal(result.error, null);
    const ignoredResult = await f.tracker.refresh(f.root, [ignored], { path: ignored, markdown: "ignored\n" });
    assert.equal(ignoredResult.gitDiff, null);
    const sub = path.join(f.root, "docs");
    await mkdir(sub);
    assert.equal(await openGitRepository(sub), null);
    const disabled = await f.tracker.refresh(null, [untracked], { path: untracked, markdown: "new\n" });
    assert.deepEqual(disabled, { statuses: {}, gitDiff: null, error: null });
});

for (const format of ["sha1", "sha256"]) {
    test(`compares raw working files with HEAD (${format}), not index or filters`, async (t) => {
        const f = await fixture(t, format);
        const changed = await f.write("docs/changed.md", "before\n");
        const same = await f.write("same.md", "a\nb\n");
        await f.git("add", ".");
        await f.git("commit", "--quiet", "-m", "Initial");
        await f.write("docs/changed.md", "after\n");
        await f.write("same.md", "a\r\nb\r\n");
        await f.git("add", "docs/changed.md");
        // If a prohibited porcelain/filter-aware path is used, these fail.
        await f.write(".gitattributes", "*.md filter=must-not-run\n");
        await f.git("config", "filter.must-not-run.clean", "nonexistent-skimdown-filter");
        await f.git("config", "filter.must-not-run.required", "true");
        await f.git("config", "core.fsmonitor", "nonexistent-skimdown-monitor");
        const beforeIndex = await readFile(path.join(f.root, ".git", "index"));
        const result = await f.tracker.refresh(f.root, [changed, same], { path: changed, markdown: "after\n" });
        assert.deepEqual(result.statuses, { [changed]: "M" });
        assert.deepEqual(result.gitDiff.hunks[0].oldLines, ["before"]);
        assert.deepEqual(await readFile(path.join(f.root, ".git", "index")), beforeIndex);
        assert.deepEqual(f.errors, []);
        const { stdout } = await f.git("rev-parse", "HEAD:same.md");
        assert.equal(blobID(Buffer.from("a\nb\n"), format), stdout.trim());
    });
}

test("accepts linked worktrees and refreshes HEAD and index references", async (t) => {
    const f = await fixture(t);
    await f.write("doc.md", "before\n");
    await f.git("add", ".");
    await f.git("commit", "--quiet", "-m", "Initial");
    const linked = path.join(f.root, "linked");
    await f.git("worktree", "add", "--quiet", "-b", "linked", linked);
    const repo = await openGitRepository(linked);
    assert.notEqual(repo.gitDir, repo.commonDir);
    let changes = 0;
    const tracker = createGitTracker(() => { changes++; }, assert.fail);
    t.after(() => tracker.dispose());
    const file = path.join(linked, "doc.md");
    await writeFile(file, "after\n");
    const result = await tracker.refresh(linked, [file], { path: file, markdown: "after\n" });
    assert.equal(result.statuses[file], "M");
    await f.git("-C", linked, "add", "doc.md");
    await f.git("-C", linked, "commit", "--quiet", "-m", "Changed");
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.ok(changes > 0, "linked HEAD/index watcher did not notify");
    assert.equal((await tracker.refresh(linked, [file], { path: file, markdown: "after\n" })).gitDiff, null);
});

test("reference events ignore lock files and object/log churn", () => {
    for (const name of ["HEAD", "index", "packed-refs", path.join("refs", "heads", "main")]) {
        assert.equal(isReferenceEvent(name), true, name);
    }
    for (const name of ["index.lock", "refs/heads/main.lock", "objects/ab/cd", "logs/HEAD"]) {
        assert.equal(isReferenceEvent(name), false, name);
    }
});

test("runner rejects porcelain, bounds output, and terminates at the deadline", async (t) => {
    const f = await fixture(t);
    await assert.rejects(runGit(f.executable, f.root, ["status"]), /unsupported Git command/);
    await assert.rejects(runGit(f.executable, f.root, ["diff"]), /unsupported Git command/);
    await assert.rejects(runGit(f.executable, f.root, ["rev-parse", "--show-toplevel"], { maxBytes: 1 }), /size limit/);
    await assert.rejects(runGit(f.executable, f.root, ["rev-parse", "--show-toplevel"], { timeout: 1 }), /timed out/);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(runGit(f.executable, f.root, ["rev-parse", "--show-toplevel"], {
        signal: controller.signal,
    }), { name: "AbortError" });
});

test("disabling tracking cancels pending queries without surfacing cancellation as an error", async (t) => {
    const f = await fixture(t);
    const file = await f.write("doc.md", "new\n");
    const enabled = f.tracker.refresh(f.root, [file], { path: file, markdown: "new\n" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const disabled = f.tracker.refresh(null, [], null);
    assert.deepEqual(await disabled, { statuses: {}, gitDiff: null, error: null });
    assert.deepEqual(await enabled, { statuses: {}, gitDiff: null, error: null });
    assert.deepEqual(f.errors, []);
});

test("Git failure is visible without inventing added files or leaking repository text to logs", async (t) => {
    const f = await fixture(t);
    const file = await f.write("private-name.md", "PRIVATE_MARKDOWN_TEXT\n");
    await f.write(".git/config", "[invalid config containing PRIVATE_MARKDOWN_TEXT");
    const result = await f.tracker.refresh(f.root, [file], { path: file, markdown: "PRIVATE_MARKDOWN_TEXT\n" });
    assert.deepEqual(result.statuses, {});
    assert.equal(result.gitDiff, null);
    assert.match(result.error, /^Git changes unavailable:/);
    assert.equal(f.errors.length, 1);
    assert.doesNotMatch(f.errors[0], /PRIVATE_MARKDOWN_TEXT|private-name/);
    assert.ok(!f.errors[0].includes(f.root));
});

test("canvas preference is opt-in, shared, persisted, and refreshed after commits", async (t) => {
    const f = await fixture(t);
    const file = await f.write("README.md", "before\n");
    await f.git("add", "README.md");
    await f.git("commit", "--quiet", "-m", "Initial");
    await f.write("README.md", "after\n");
    const previousHome = process.env.COPILOT_HOME;
    const home = await mkdtemp(path.join(tmpdir(), "skimdown-git-home-"));
    process.env.COPILOT_HOME = home;
    const instances = [];
    try {
        assert.equal((await loadSettings({ fresh: true })).showGitChanges, false);
        const make = async (id) => {
            const instance = await createInstance({
                instanceId: id, sessionId: id, workspacePath: f.root, log() {},
            });
            instances.push(instance);
            await instance.setSource("workspace");
            return instance;
        };
        const first = await make("git-first");
        const second = await make("git-second");
        assert.equal(first.state.doc.gitDiff, null);
        const url = new URL(first.url);
        const token = new URLSearchParams(url.hash.slice(1)).get("token");
        const request = (body) => fetch(new URL("/api/settings", first.url), {
            method: "POST",
            headers: {
                Origin: url.origin, "Sec-Fetch-Site": "same-origin", "Content-Type": "application/json",
                "X-SkimDown-Capability": token,
            },
            body: JSON.stringify(body),
        });
        assert.equal((await request({ showGitChanges: true })).status, 200);
        assert.equal((await loadSettings({ fresh: true })).showGitChanges, true);
        const waitFor = async (predicate) => {
            const end = Date.now() + 8000;
            while (!predicate() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
            assert.ok(predicate(), "Git refresh did not settle");
        };
        await waitFor(() => first.state.doc.gitDiff !== null);
        assert.deepEqual(first.state.doc.gitDiff.hunks[0].oldLines, ["before"]);
        await waitFor(() => second.state.doc.gitDiff !== null);
        await f.git("add", "README.md");
        await f.git("commit", "--quiet", "-m", "Changed");
        await waitFor(() => first.state.doc.gitDiff === null && second.state.doc.gitDiff === null);
        assert.deepEqual(first.state.git.statuses, {});
        await f.write("README.md", "third\n");
        await waitFor(() => first.state.doc.markdown === "third\n" && first.state.doc.gitDiff !== null);
        assert.equal((await request({ showGitChanges: false })).status, 200);
        await waitFor(() => second.state.doc.gitDiff === null);
        assert.deepEqual(first.state.git.statuses, {});
        assert.equal((await loadSettings({ fresh: true })).showGitChanges, false);
        await f.write("README.md", "manual refresh\n");
        const listing = await first.refresh();
        assert.ok(listing.count > 0);
        assert.equal(first.state.doc.markdown, "manual refresh\n");
        // A peer extension process writes the same user-global preference but
        // cannot emit an in-process settings event.
        const peerSettings = JSON.parse(await readFile(settingsFile(), "utf8"));
        await writeFile(settingsFile(), JSON.stringify({ ...peerSettings, showGitChanges: true }));
        await waitFor(() => first.state.doc.gitDiff !== null && second.state.doc.gitDiff !== null);
        assert.equal((await request({ showGitChanges: false })).status, 200);
        const renderer = (await first.buildState()).rendererBaseUri;
        for (const asset of ["gitDiff.js", "gitDiff.css"]) {
            assert.equal((await fetch(new URL(asset, renderer))).status, 200);
            assert.equal((await fetch(new URL(asset, first.url))).status, 404);
        }
    } finally {
        await updateSettings({ showGitChanges: false });
        for (const instance of instances) await instance.dispose();
        if (previousHome === undefined) delete process.env.COPILOT_HOME;
        else process.env.COPILOT_HOME = previousHome;
        await rm(home, { recursive: true, force: true });
    }
});
